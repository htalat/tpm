import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot } from "./root.ts";
import { newProject, newTask } from "./new.ts";
import { context, repoPath } from "./context.ts";
import { report } from "./report.ts";
import { archiveTask, foldTask, loadProjects, flatTasks, rollupStatus, taskHasReport, taskReportPath } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { selectNext, selectCandidates, inboxItems } from "./queue.ts";
import { resolveSameRepoStrategy } from "./orchestrate/strategy.ts";
import { findTask, findRepoTarget } from "./resolve.ts";
import { init } from "./init.ts";
import { CONFIG_PATH, readConfig, writeConfig, serveBaseUrl } from "./config.ts";
import { now } from "../util/time.ts";
import * as mutate from "./mutate.ts";
import * as lock from "./orchestrate/lock.ts";
import { runOrchestrate } from "./orchestrate/orchestrate.ts";
import { runPoll } from "./orchestrate/poll.ts";
import { runServe } from "../web/serve.ts";
import { shouldNotify, fireNotification, NOTIFY_EVENTS } from "./notify.ts";
import { taskDeepLink } from "../web/serve_url.ts";
import type { NotifyEvent } from "./notify.ts";
import { resolveRepo } from "./context.ts";
import { checkDrift } from "./drift.ts";
import { getScheduler } from "./scheduler/types.ts";
import { refreshSkills } from "./refresh_skills.ts";

const VERSION = readVersion();

const args = process.argv.slice(2);
const cmd = args[0];

// Hoisted above the dispatch (not parked next to the other helpers below)
// because the `help`, `config get`, and `config set` case branches all run
// during top-level switch evaluation and read these — leaving the const
// below the switch put them in the TDZ and crashed `tpm help`.
// Keys exposed via `tpm config get/set`. Kept short on purpose — most callers
// want `workers` (the only one that benefits from runtime adjustment); the rest
// of the config has purpose-built verbs (`tpm root`, `tpm now`) or is a one-
// time bootstrap (`tpm init`). Extending this list is intentional.
const KNOWN_CONFIG_KEYS = ["workers"] as const;
type KnownConfigKey = (typeof KNOWN_CONFIG_KEYS)[number];

function isKnownConfigKey(key: string): key is KnownConfigKey {
  return (KNOWN_CONFIG_KEYS as readonly string[]).includes(key);
}

try {
  switch (cmd) {
    case "new": {
      const root = findRoot();
      const what = args[1];
      if (what === "project") {
        const slug = args[2];
        if (!slug) usage("tpm new project <slug> [--name 'Name'] [--repo <url>] [--path <dir>]");
        const path = newProject(root, slug, {
          name: parseFlag(args, "--name"),
          repoRemote: parseFlag(args, "--repo"),
          repoLocal: parseFlag(args, "--path"),
        });
        console.log(`Created ${path}`);
      } else if (what === "task") {
        const project = args[2];
        const slug = args[3];
        if (!project || !slug) usage("tpm new task <project> <slug> [--title 'Title'] [--parent <parent-slug>] [--type pr|investigation]");
        const path = newTask(root, project, slug, {
          title: parseFlag(args, "--title"),
          parent: parseFlag(args, "--parent"),
          type: parseFlag(args, "--type"),
        });
        console.log(`Created ${path}`);
      } else {
        usage("tpm new project|task ...");
      }
      break;
    }
    case "ls": {
      const root = findRoot();
      const filter = parseFlag(args, "--status");
      const showAll = args.includes("--all");
      const includeArchived = showAll || args.includes("--archived");
      const flat = args.includes("--flat");
      const projects = loadProjects(root, { archived: includeArchived });
      const projectFilter = parseFlag(args, "--project");
      if (projects.length === 0) {
        console.log("No projects yet. Run: tpm new project <slug>");
        break;
      }
      const passes = (t: Task) => {
        if (filter) return t.data.status === filter;
        if (showAll || includeArchived) return true;
        return !isHiddenStatus(t.data.status) && !t.archived;
      };
      for (const p of projects) {
        if (projectFilter && p.slug !== projectFilter) continue;
        const visible = filterTaskTree(p.tasks, passes, flat);
        if (filter && visible.length === 0 && !flat) continue;
        const name = strOr(p.data.name, p.slug);
        const status = strOr(p.data.status, "?");
        console.log(`\n${name}  (${p.slug})  [${status}]`);
        if (visible.length === 0 && (!filter || flat)) console.log(`  (no tasks)`);
        if (flat) {
          for (const t of visible) console.log(formatTaskLine(t, 0));
        } else {
          for (const t of visible) {
            console.log(formatTaskLine(t, 0, rollupStatus(t)));
            for (const c of t.children ?? []) console.log(formatTaskLine(c, 1));
          }
        }
      }
      break;
    }
    case "archive": {
      const root = findRoot();
      const query = args[1];
      if (!query) usage("tpm archive <task | project/task>");
      const projects = loadProjects(root, { archived: true });
      const match = findTask(projects, query);
      if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls --all\`.`);
      const path = archiveTask(match.task);
      console.log(`Archived ${qualifySlug(match.project.slug, match.task)} -> ${path}`);
      break;
    }
    case "fold": {
      const root = findRoot();
      const query = args[1];
      if (!query) usage("tpm fold <task | project/task>");
      const projects = loadProjects(root);
      const match = findTask(projects, query);
      if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
      const path = foldTask(match.task);
      console.log(`Folded ${qualifySlug(match.project.slug, match.task)} -> ${path}`);
      break;
    }
    case "reparent": {
      const root = findRoot();
      const taskQuery = args[1];
      const parentQuery = args[2];
      if (!taskQuery || !parentQuery) usage("tpm reparent <task> <new-parent | --top>");
      const projects = loadProjects(root);
      const match = findTask(projects, taskQuery);
      if (!match) throw new Error(`No task matched "${taskQuery}". Try \`tpm ls\`.`);
      let newParent: Task | null = null;
      if (parentQuery !== "--top") {
        if (parentQuery.startsWith("-")) {
          usage('tpm reparent <task> <new-parent | --top>  (parent slug cannot start with "-"; use --top to promote)');
        }
        // Resolve new-parent within the source task's project. Keeps the move
        // local — cross-project moves aren't supported in v0.
        const parentMatch = findTask([match.project], parentQuery);
        if (!parentMatch) {
          throw new Error(`No task matched new-parent "${parentQuery}" in project ${match.project.slug}.`);
        }
        newParent = parentMatch.task;
      }
      const r = mutate.reparent(match.task, newParent);
      console.log(r.message);
      console.log(`-> ${r.newPath}`);
      break;
    }
    case "context": {
      const root = findRoot();
      const query = args[1];
      if (!query) usage("tpm context <task | project/task>");
      console.log(context(root, query));
      break;
    }
    case "report": {
      // Two shapes share this verb:
      //   `tpm report [--md]`               — rollup HTML/MD for the whole tree
      //   `tpm report <slug> [<path>]`      — attach a report artifact to a task
      //   `tpm report <slug> --export text` — print the report as plain text
      // First positional disambiguates: starts with `-` (or absent) → rollup;
      // bare token → slug-attach.
      const first = args[1];
      if (!first || first.startsWith("-")) {
        const root = findRoot();
        const format = args.includes("--md") ? "md" : "html";
        const path = report(root, { format });
        console.log(`Wrote ${path}`);
        break;
      }
      const slug = first;
      const exportFmt = parseFlag(args, "--export");
      if (exportFmt !== undefined) {
        if (exportFmt !== "text") usage("tpm report <slug> --export text  (only 'text' is supported)");
        const task = resolveLiveTask(slug, "tpm report <slug> --export text");
        if (!taskHasReport(task)) {
          throw new Error(`${task.slug}: no report attached. Run \`tpm report ${slug}\` first.`);
        }
        const absPath = taskReportPath(task);
        const text = readFileSync(absPath, "utf8");
        // Cheap markdown → text: drop HTML comments. Everything else stays
        // as-is (headings, bullets) — markdown reads fine in a terminal.
        process.stdout.write(text.replace(/<!--[\s\S]*?-->/g, ""));
        break;
      }
      const task = resolveLiveTask(slug, "tpm report <slug> [--export text]");
      const r = mutate.addReport(task);
      console.log(r.message);
      break;
    }
    case "init": {
      const result = init(args[1]);
      console.log(`tpm tree at ${result.root}`);
      console.log(`config:    ${result.configPath}`);
      if (result.created.length) {
        console.log(`created:`);
        for (const c of result.created) console.log(`  ${c}`);
      } else {
        console.log(`(tree already existed — config now points here)`);
      }
      break;
    }
    case "root": {
      console.log(findRoot());
      break;
    }
    case "path": {
      const root = findRoot();
      const query = args[1];
      if (!query) usage("tpm path <project | task | project/task>");
      console.log(repoPath(root, query));
      break;
    }
    case "now": {
      console.log(now());
      break;
    }
    case "config": {
      const sub = args[1];
      const key = args[2];
      if (sub === "get") {
        if (!key) usage("tpm config get <key>");
        const cfg = readConfig();
        // `workers` is the only key plumbed through CLI today; other keys
        // (root/timezone/...) have purpose-built verbs (`tpm root`, `tpm now`).
        // We surface the known-key list explicitly so unknown keys fail loudly
        // instead of returning a misleading empty string.
        if (!isKnownConfigKey(key)) {
          usage(`tpm config get <key>: unknown key "${key}" (known: ${KNOWN_CONFIG_KEYS.join(", ")})`);
        }
        const value = (cfg as Record<string, unknown>)[key];
        if (value === undefined) {
          console.log("");
        } else if (typeof value === "object") {
          console.log(JSON.stringify(value));
        } else {
          console.log(String(value));
        }
        break;
      }
      if (sub === "set") {
        const raw = args[3];
        if (!key || raw === undefined) usage("tpm config set <key> <value>");
        if (!isKnownConfigKey(key)) {
          usage(`tpm config set <key> <value>: unknown key "${key}" (known: ${KNOWN_CONFIG_KEYS.join(", ")})`);
        }
        if (key === "workers") {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 0) usage("workers must be a non-negative integer");
          const cfg = readConfig();
          cfg.workers = n;
          writeConfig(cfg);
          console.log(`workers: ${n}`);
          break;
        }
        usage(`tpm config set: setter for "${key}" not implemented`);
      }
      usage("tpm config get|set <key> [value]");
    }
    case "start": {
      const r = mutate.start(resolveLiveTask(args[1], "tpm start <task>"));
      console.log(r.message);
      break;
    }
    case "ready": {
      const r = mutate.ready(resolveLiveTask(args[1], "tpm ready <task>"));
      console.log(r.message);
      break;
    }
    case "block": {
      const reason = args[2];
      if (!args[1] || !reason) usage('tpm block <task> "<reason>"');
      const r = mutate.block(resolveLiveTask(args[1], 'tpm block <task> "<reason>"'), reason);
      console.log(r.message);
      break;
    }
    case "reopen": {
      const reason = args[2];
      const r = mutate.reopen(resolveLiveTask(args[1], 'tpm reopen <task> ["<reason>"]'), reason);
      console.log(r.message);
      break;
    }
    case "pull": {
      const r = mutate.pullFromQueue(resolveLiveTask(args[1], "tpm pull <task>"));
      console.log(r.message);
      break;
    }
    case "revert": {
      const reason = args[2];
      const r = mutate.revert(resolveLiveTask(args[1], 'tpm revert <task> ["<reason>"]'), reason);
      console.log(r.message);
      break;
    }
    case "log": {
      const message = args[2];
      if (!args[1] || !message) usage('tpm log <task> "<message>"');
      const r = mutate.logEntry(resolveLiveTask(args[1], 'tpm log <task> "<message>"'), message);
      console.log(r.message);
      break;
    }
    case "pr": {
      const url = args[2];
      if (!args[1] || !url) usage("tpm pr <task> <url>");
      const r = mutate.addPr(resolveLiveTask(args[1], "tpm pr <task> <url>"), url);
      console.log(r.message);
      break;
    }
    case "status": {
      const newStatus = args[2];
      if (!args[1] || !newStatus) usage("tpm status <task> <new-status>");
      const r = mutate.setStatus(resolveLiveTask(args[1], "tpm status <task> <new-status>"), newStatus);
      console.log(r.message);
      break;
    }
    case "allow": {
      const r = mutate.setAllowOrchestrator(resolveLiveTask(args[1], "tpm allow <task>"), true);
      console.log(r.message);
      break;
    }
    case "disallow": {
      const r = mutate.setAllowOrchestrator(resolveLiveTask(args[1], "tpm disallow <task>"), false);
      console.log(r.message);
      break;
    }
    case "set-type": {
      const newType = args[2];
      if (!args[1] || !newType) usage("tpm set-type <task> <pr|investigation>");
      const r = mutate.setType(resolveLiveTask(args[1], "tpm set-type <task> <type>"), newType);
      console.log(r.message);
      break;
    }
    case "complete": {
      if (!args[1]) usage('tpm complete <task> [--outcome "..."] [--no-archive] [--archive]');
      const outcome = parseFlag(args, "--outcome");
      const noArchive = args.includes("--no-archive");
      const forceArchive = args.includes("--archive");
      if (noArchive && forceArchive) usage("--archive and --no-archive are mutually exclusive");
      const archiveOpt = noArchive ? false : forceArchive ? true : undefined;
      const r = mutate.complete(resolveLiveTask(args[1], 'tpm complete <task>'), {
        outcome,
        archive: archiveOpt,
      });
      console.log(r.message);
      if (r.archivedAt) console.log(`Archived -> ${r.archivedAt}`);
      break;
    }
    case "lgtm": {
      // Reviewer LGTM on an investigation report: derive an Outcome from the
      // report file (title + first paragraph) and run complete. The serve
      // `LGTM` button shells out to this verb so the web layer never reaches
      // into mutate directly.
      if (!args[1]) usage("tpm lgtm <task>");
      const task = resolveLiveTask(args[1], "tpm lgtm <task>");
      if (!taskHasReport(task)) throw new Error(`${task.slug}: no report attached. Run \`tpm report ${args[1]}\` first.`);
      const absPath = taskReportPath(task);
      const reportText = readFileSync(absPath, "utf8");
      const outcome = mutate.deriveReportOutcome(reportText);
      const r = mutate.complete(task, { outcome });
      console.log(r.message);
      if (r.archivedAt) console.log(`Archived -> ${r.archivedAt}`);
      break;
    }
    case "request-changes": {
      const comment = args[2];
      if (!args[1] || !comment) usage('tpm request-changes <task> "<comment>"');
      const r = mutate.requestReportChanges(
        resolveLiveTask(args[1], 'tpm request-changes <task> "<comment>"'),
        comment,
      );
      console.log(r.message);
      break;
    }
    case "edit": {
      const section = args[2];
      const value = args[3];
      if (!args[1] || !section || value === undefined) {
        usage('tpm edit <task> <title|context|plan|outcome> "<value>" [--expect-mtime <ms>]');
      }
      const mtimeRaw = parseFlag(args, "--expect-mtime");
      let expectMtimeMs: number | undefined;
      if (mtimeRaw !== undefined) {
        const n = Number(mtimeRaw);
        if (!Number.isFinite(n)) {
          throw new Error(`tpm edit: --expect-mtime must be a number, got "${mtimeRaw}"`);
        }
        expectMtimeMs = n;
      }
      const r = mutate.editTaskSection(
        resolveLiveTask(args[1], 'tpm edit <task> <section> "<value>"'),
        section,
        value,
        { expectMtimeMs },
      );
      console.log(r.message);
      break;
    }
    case "edit-project": {
      const section = args[2];
      const value = args[3];
      if (!args[1] || !section || value === undefined) {
        usage('tpm edit-project <project> <name|goal|context|notes> "<value>" [--expect-mtime <ms>]');
      }
      const mtimeRaw = parseFlag(args, "--expect-mtime");
      let expectMtimeMs: number | undefined;
      if (mtimeRaw !== undefined) {
        const n = Number(mtimeRaw);
        if (!Number.isFinite(n)) {
          throw new Error(`tpm edit-project: --expect-mtime must be a number, got "${mtimeRaw}"`);
        }
        expectMtimeMs = n;
      }
      const r = mutate.editProjectSection(
        resolveProject(args[1], 'tpm edit-project <project> <section> "<value>"'),
        section,
        value,
        { expectMtimeMs },
      );
      console.log(r.message);
      break;
    }
    case "lock": {
      const sub = args[1];
      const root = findRoot();
      // The 3rd positional is either a task slug or a flag. If it's a flag
      // (or absent), we're in legacy global-lock territory.
      const positional = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      const agentId = parseFlag(args, "--as") ?? process.env.TPM_AGENT_ID;
      switch (sub) {
        case "acquire": {
          if (!positional) {
            warnLegacyGlobalLock("acquire");
            const r = lock.acquire(root);
            if (!r.acquired) {
              console.error(`tpm lock: ${r.reason}`);
              process.exit(1);
            }
            if (r.takeover) {
              const prior = r.prior ? `(stale lock from pid ${r.prior.pid}, started ${r.prior.started_at})` : "(stale lock)";
              console.log(`acquired ${prior}`);
            } else {
              console.log("acquired");
            }
            break;
          }
          if (!agentId) usage("tpm lock acquire <task> --as <agent-id>");
          const slug = qualifySlugString(root, positional);
          const r = lock.acquireTask(root, slug, agentId);
          if (!r.acquired) {
            console.error(`tpm lock: ${r.reason}`);
            process.exit(1);
          }
          console.log(`acquired ${slug} as ${agentId}`);
          break;
        }
        case "release": {
          const force = args.includes("--force");
          if (!positional) {
            warnLegacyGlobalLock("release");
            const r = lock.release(root, force);
            if (!r.released) {
              console.error(`tpm lock: ${r.message}`);
              process.exit(1);
            }
            console.log(r.message);
            break;
          }
          const slug = qualifySlugString(root, positional);
          const r = lock.releaseTask(root, slug, agentId ?? "", force);
          if (!r.released) {
            console.error(`tpm lock: ${r.message}`);
            process.exit(1);
          }
          console.log(`${r.message}: ${slug}`);
          break;
        }
        case "heartbeat": {
          if (!positional) usage("tpm lock heartbeat <task> --as <agent-id>");
          if (!agentId) usage("tpm lock heartbeat <task> --as <agent-id>");
          const slug = qualifySlugString(root, positional);
          const r = lock.heartbeatTask(root, slug, agentId);
          if (!r.ok) {
            console.error(`tpm lock: ${r.message}`);
            process.exit(1);
          }
          console.log(`${r.message}: ${slug}`);
          break;
        }
        case "status": {
          if (!positional) {
            console.log(lock.status(root));
            break;
          }
          const slug = qualifySlugString(root, positional);
          console.log(lock.statusTask(root, slug));
          break;
        }
        case "list": {
          const entries = lock.listTaskLocks(root);
          if (entries.length === 0) {
            console.log("no per-task locks");
            break;
          }
          // Pad each column to the widest content (or its header), so output
          // stays readable when long slugs and short ones mix.
          const slugW    = Math.max("PROJECT/SLUG".length, ...entries.map(e => e.qualifiedSlug.length));
          const agentW   = Math.max("AGENT-ID".length, ...entries.map(e => e.data.agentId.length));
          const acqW     = Math.max("ACQUIRED".length, 8);
          const beatW    = Math.max("HEARTBEAT".length, 9);
          console.log(
            `${pad("PROJECT/SLUG", slugW)}  ${pad("AGENT-ID", agentW)}  ${pad("ACQUIRED", acqW)}  ${pad("HEARTBEAT", beatW)}`,
          );
          for (const e of entries) {
            console.log(
              `${pad(e.qualifiedSlug, slugW)}  ${pad(e.data.agentId, agentW)}  ${pad(formatAge(e.acquiredAgeMinutes), acqW)}  ${pad(formatAge(e.ageMinutes), beatW)}`,
            );
          }
          break;
        }
        case "release-stale": {
          const ttlArg = parseFlag(args, "--ttl");
          const ttl = ttlArg !== undefined ? Number(ttlArg) : staleTtlDefault(root);
          if (!Number.isFinite(ttl) || ttl <= 0) usage("--ttl must be a positive number (minutes)");
          const removed = lock.releaseStaleTaskLocks(root, ttl);
          if (removed.length === 0) {
            console.log(`no stale locks (ttl ${ttl}m)`);
            break;
          }
          for (const e of removed) {
            console.log(`released ${e.qualifiedSlug} (was ${e.data.agentId}, age ${e.ageMinutes.toFixed(1)}m)`);
          }
          break;
        }
        default:
          usage("tpm lock acquire <task> --as <id> | release <task> --as <id> [--force] | heartbeat <task> --as <id> | status [<task>] | list | release-stale [--ttl <minutes>]");
      }
      break;
    }
    case "drift-check": {
      const root = findRoot();
      const projectFlag = parseFlag(args, "--project");
      const positional = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const query = projectFlag ?? positional;
      if (!query) usage("tpm drift-check <project | task> | --project <slug>");
      const projects = loadProjects(root);
      const target = findRepoTarget(projects, query);
      if (!target) throw new Error(`No project/task matched "${query}".`);
      const repo = resolveRepo(target.project, target.task);
      if (!repo.local) throw new Error(`No repo.local set for "${query}"; cannot run drift-check.`);
      const r = checkDrift(repo.local);
      if (r.clean) {
        console.log(`clean: on ${r.branch} at ${r.repoLocal}`);
      } else {
        console.error(`drift-check: ${r.reason} [${r.repoLocal}]`);
        process.exit(1);
      }
      break;
    }
    case "next": {
      const root = findRoot();
      const projects = loadProjects(root);
      const projectFilter = parseFlag(args, "--project");
      const autonomous = args.includes("--autonomous");
      const claimAgent = parseFlag(args, "--claim") ?? (args.includes("--claim") ? process.env.TPM_AGENT_ID : undefined);
      // Lock predicate enables the queue's stranded-in-progress admission
      // (task 065): a task whose status is in-progress but whose per-task lock
      // is gone is reclaimable. Stale-lock hygiene runs below on the --claim
      // path; on the non-claim path we accept that a freshly-stale lock will
      // hide a stranded task until the next claim or the reclaim sweeper runs.
      const hasTaskLock = (slug: string) => lock.hasTaskLock(root, slug);
      if (!claimAgent) {
        const pick = selectNext(projects, { projectFilter, autonomous, hasTaskLock });
        if (!pick) {
          const where = projectFilter ? ` in project "${projectFilter}"` : "";
          const gate = autonomous ? " with allow_orchestrator: true" : "";
          console.error(`No ready or needs-feedback tasks${where}${gate}.`);
          process.exit(1);
        }
        console.log(qualifySlug(pick.project.slug, pick.task));
        break;
      }
      // --claim: walk candidates in order, atomically lock the first one we can.
      // Strategy `serialize` also requires the repo lock — fall through to
      // the next candidate if a sibling task is already running in this repo.
      // Skip a stale-lock sweep first as a hygiene step.
      const ttl = staleTtlDefault(root);
      lock.releaseStaleTaskLocks(root, ttl);
      const candidates = selectCandidates(projects, { projectFilter, autonomous, hasTaskLock });
      for (const c of candidates) {
        const slug = qualifySlug(c.project.slug, c.task);
        const strategy = resolveSameRepoStrategy(c.project);
        if (strategy === "worktree") {
          // Declared but not yet implemented (035/003 ships the field +
          // serialize; worktree lifecycle is a follow-up). Skip rather than
          // claim a task we can't safely dispatch in parallel.
          continue;
        }
        const taskR = lock.acquireTask(root, slug, claimAgent);
        if (!taskR.acquired) continue;
        if (strategy === "serialize") {
          const repoR = lock.acquireRepo(root, c.project.slug, claimAgent);
          if (!repoR.acquired) {
            // Release the per-task lock so future claims see it free.
            lock.releaseTask(root, slug, claimAgent);
            continue;
          }
        }
        console.log(slug);
        process.exit(0);
      }
      const where = projectFilter ? ` in project "${projectFilter}"` : "";
      const gate = autonomous ? " with allow_orchestrator: true" : "";
      console.error(`No claimable ready or needs-feedback tasks${where}${gate} (all candidates locked or their repos busy).`);
      process.exit(1);
    }
    case "serve": {
      const portArg = parseFlag(args, "--port");
      const hostArg = parseFlag(args, "--host");
      const opts: { port?: number; host?: string } = {};
      if (portArg !== undefined) {
        const n = Number(portArg);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) usage("--port must be an integer 1..65535");
        opts.port = n;
      }
      if (hostArg !== undefined) opts.host = hostArg;
      await runServe(opts);
      // runServe never resolves under normal operation (server is listening).
      // We hit this only on listen-error → process.exit already fired.
      break;
    }
    case "notify": {
      const event = args[1] as NotifyEvent | undefined;
      // args[2] is either the task slug or a flag.
      const query = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      if (!event || !query) usage(`tpm notify <${NOTIFY_EVENTS.join("|")}> <task> [--as <agent-id>]`);
      if (!NOTIFY_EVENTS.includes(event as NotifyEvent)) {
        usage(`tpm notify <${NOTIFY_EVENTS.join("|")}> <task> [--as <agent-id>]`);
      }
      const root = findRoot();
      const projects = loadProjects(root);
      const match = findTask(projects, query);
      if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
      const cfg = readConfig();
      if (shouldNotify(event as NotifyEvent, {
        task: match.task,
        project: match.project,
        globalConfig: cfg.notifications,
      })) {
        // Include agent-id in the message body so multi-agent setups can tell
        // which runner pinged. Defaults to TPM_AGENT_ID env or hostname-pid.
        const notifyAgent = parseFlag(args, "--as") ?? process.env.TPM_AGENT_ID;
        const verb = event === "start" ? "starting"
                   : event === "finish" ? "finished"
                   : "failed";
        const message = notifyAgent
          ? `${notifyAgent} ${verb} ${match.task.slug}`
          : `${match.task.slug}: ${event}`;
        const url = taskDeepLink(serveBaseUrl(cfg), match.project, match.task);
        fireNotification("tpm", message, { url });
      }
      // Best-effort — never propagate failure.
      break;
    }
    case "poll":
    case "check-pr-signal": {
      // `tpm poll` is the in-process PR-signal poller; `check-pr-signal` is a
      // back-compat alias so existing cron/launchd entries don't have to flip
      // on the same tick as the install.
      const dryRun = args.includes("--dry-run");
      await runPoll({ dryRun });
      break;
    }
    case "orchestrate": {
      const minutesArg = parseFlag(args, "--minutes");
      const claudeArg = parseFlag(args, "--claude");
      const agentArg = parseFlag(args, "--agent");
      const taskArg = parseFlag(args, "--task");
      const workersArg = parseFlag(args, "--workers");
      const cliArg = parseFlag(args, "--cli");
      const opts: {
        minutesOverride?: number;
        claudeBin?: string;
        agentName?: string;
        preClaimedTask?: string;
        workers?: number;
        cliPerWorker?: string[];
      } = {};
      if (minutesArg !== undefined) {
        const n = Number(minutesArg);
        if (!Number.isInteger(n) || n <= 0) usage("--minutes must be a positive integer");
        opts.minutesOverride = n;
      }
      if (workersArg !== undefined) {
        const n = Number(workersArg);
        if (!Number.isInteger(n) || n <= 0) usage("--workers must be a positive integer");
        opts.workers = n;
      }
      if (cliArg !== undefined) {
        const list = cliArg.split(",").map(s => s.trim()).filter(s => s.length > 0);
        if (list.length === 0) usage("--cli must list at least one agent name");
        opts.cliPerWorker = list;
      }
      // `--claude <path>` is the pre-092 flag — kept as a back-compat alias
      // that pins the agent to claude AND overrides its bin path. `--agent
      // <name>` is the new selector (claude, copilot, …).
      if (claudeArg !== undefined) {
        opts.claudeBin = claudeArg;
        if (agentArg === undefined) opts.agentName = "claude";
      }
      if (agentArg !== undefined) opts.agentName = agentArg;
      if (taskArg !== undefined) opts.preClaimedTask = taskArg;
      const r = await runOrchestrate(opts);
      process.exit(r.exitCode);
    }
    case "inbox": {
      const root = findRoot();
      const projects = loadProjects(root);
      const items = inboxItems(projects);
      if (items.length === 0) {
        console.log("Inbox empty (no needs-review, blocked, or open tasks).");
        break;
      }
      console.log(`Inbox (${items.length} task${items.length === 1 ? "" : "s"}):`);
      for (const it of items) {
        const slug = qualifySlug(it.project.slug, it.task);
        const title = strOr(it.task.data.title, it.task.slug);
        console.log(`  ${pad(it.status, 13)} ${pad(slug, 36)} ${title}`);
      }
      break;
    }
    case "schedule": {
      const sub = args[1];
      const scheduler = getScheduler();
      switch (sub) {
        case "install": {
          const name = args[2];
          if (!name) usage("tpm schedule install <name> --every <seconds> -- <cmd> [args...]");
          const everyArg = parseFlag(args, "--every");
          if (everyArg === undefined) usage("tpm schedule install <name> --every <seconds> -- <cmd> [args...]");
          const intervalSeconds = Number(everyArg);
          if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            usage("--every must be a positive number of seconds");
          }
          const dashIdx = args.indexOf("--");
          if (dashIdx < 0 || dashIdx === args.length - 1) {
            usage("tpm schedule install <name> --every <seconds> -- <cmd> [args...]");
          }
          const cmdArgs = args.slice(dashIdx + 1);
          // Convenience: if the user typed bare `tpm` (no path separator),
          // substitute the absolute path of THIS install. Systemd's PATH for
          // user services is usually thin and cron's is thinner — an absolute
          // path makes the unit work without further env wiring.
          if (cmdArgs[0] === "tpm") cmdArgs[0] = resolveTpmBin();
          scheduler.install({ name, args: cmdArgs, intervalSeconds });
          console.log(`scheduled ${name} (every ${intervalSeconds}s)`);
          break;
        }
        case "uninstall": {
          const name = args[2];
          if (!name) usage("tpm schedule uninstall <name>");
          scheduler.uninstall(name);
          console.log(`unscheduled ${name}`);
          break;
        }
        case "status": {
          const name = args[2];
          if (name) {
            console.log(scheduler.status(name));
            break;
          }
          const jobs = scheduler.list();
          if (jobs.length === 0) {
            console.log("(no scheduled jobs)");
            break;
          }
          for (const j of jobs) console.log(`${j}\tinstalled`);
          break;
        }
        case "list": {
          const jobs = scheduler.list();
          if (jobs.length === 0) {
            console.log("(no scheduled jobs)");
            break;
          }
          for (const j of jobs) console.log(j);
          break;
        }
        default:
          usage("tpm schedule install <name> --every <sec> -- <cmd> [args...] | uninstall <name> | status [<name>] | list");
      }
      break;
    }
    case "refresh-skills": {
      // Install/refresh the user-scoped skills from this checkout into
      // ~/.claude/skills/. On macOS/Linux it's a symlink (so edits flow
      // live); on Windows it's a recursive copy (symlinks need admin) and
      // must be re-run after editing a SKILL.md.
      const entries = refreshSkills();
      if (entries.length === 0) {
        console.log("(no skills found in source)");
        break;
      }
      for (const e of entries) {
        console.log(`${e.name}: ${e.action} (${e.source} -> ${e.target})`);
      }
      break;
    }
    case "version":
    case "--version":
    case "-V":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      help();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
} catch (e: unknown) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function resolveLiveTask(query: string | undefined, usageMsg: string): Task {
  if (!query) usage(usageMsg);
  const root = findRoot();
  const projects = loadProjects(root);
  const match = findTask(projects, query);
  if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
  return match.task;
}

// Resolve a project by slug for project-scoped verbs (`tpm edit-project`).
// Loads with archived included so the same lookup works regardless of how the
// tree is filtered elsewhere; projects aren't archived today, but the flag
// keeps this stable if that changes.
function resolveProject(query: string | undefined, usageMsg: string): Project {
  if (!query) usage(usageMsg);
  const root = findRoot();
  const project = loadProjects(root, { archived: true }).find(p => p.slug === query);
  if (!project) throw new Error(`No project matched "${query}". Try \`tpm ls\`.`);
  return project;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// Human-friendly age (seconds < 1m, minutes < 1h, hours < 24h, days otherwise).
// Used by `tpm lock list` so a freshly-acquired lock reads "5s" rather than
// "0.1m". Negatives (sub-ms clock skew) clamp to "0s".
function formatAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "0s";
  const seconds = minutes * 60;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length ? v : fallback;
}

function isHiddenStatus(status: unknown): boolean {
  return status === "done" || status === "dropped";
}

function qualifySlug(projectSlug: string, task: Task): string {
  return task.parent ? `${projectSlug}/${task.parent}/${task.slug}` : `${projectSlug}/${task.slug}`;
}

// Resolve a user-supplied slug (bare, project/slug, or project/parent/child)
// to its fully-qualified form. Used by `tpm lock` so the lock-file path is
// stable regardless of how the user typed the task name.
function qualifySlugString(root: string, query: string): string {
  const projects = loadProjects(root);
  const match = findTask(projects, query);
  if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
  return qualifySlug(match.project.slug, match.task);
}

let legacyLockWarned = false;
function warnLegacyGlobalLock(sub: string): void {
  if (legacyLockWarned) return;
  legacyLockWarned = true;
  console.error(
    `tpm lock: \`tpm lock ${sub}\` (no task argument) is the legacy global lock and will be removed in a future release. ` +
    `Switch to \`tpm lock ${sub} <task> --as <agent-id>\` for per-task locking.`,
  );
}

// Default stale-lock TTL: the global time-bound (or built-in 30m) plus a 5m
// buffer so a long-running task hovering near the bound doesn't get yanked.
// The per-task variant of this would resolve via project/task frontmatter,
// but `release-stale` walks all locks at once — a single global value is fine.
function staleTtlDefault(_root: string): number {
  const cfg = readConfig();
  const baseline = cfg.time_bound_minutes ?? 30;
  return baseline + 5;
}

function filterTaskTree(tasks: Task[], passes: (t: Task) => boolean, flat: boolean): Task[] {
  if (flat) return flatTasks(tasks).filter(passes);
  const out: Task[] = [];
  for (const t of tasks) {
    const children = t.children ? t.children.filter(passes) : [];
    const selfPasses = passes(t);
    if (selfPasses || children.length) {
      out.push({ ...t, children });
    }
  }
  return out;
}

function formatTaskLine(t: Task, depth: number, displayStatus?: string): string {
  const prs = Array.isArray(t.data.prs) ? t.data.prs.join(", ") : "";
  const archived = t.archived ? "  [archived]" : "";
  const indent = "  ".repeat(depth + 1);
  const status = displayStatus ?? strOr(t.data.status, "?");
  const isContainer = (t.children?.length ?? 0) > 0;
  const marker = isContainer ? "▸" : "·";
  return `${indent}${marker} ${pad(status, 12)} ${pad(strOr(t.data.type, "?"), 14)} ${t.slug}${archived}${prs ? "  " + prs : ""}`;
}

function usage(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readVersion(): string {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

// Resolve the absolute path to this install's `bin/tpm`, so `tpm schedule
// install <name> ... -- tpm <args>` writes a unit/cron line that runs even
// when the scheduler's PATH doesn't include the user's normal shell PATH.
// Honors $TPM_BIN as an explicit override. Falls back to bare "tpm" if the
// shim isn't where we expect (someone reorganized the repo).
function resolveTpmBin(): string {
  const override = process.env.TPM_BIN;
  if (override && isAbsolute(override) && existsSync(override)) return override;
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = resolve(dirname(here), "..", "..", "bin", "tpm");
    if (existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return "tpm";
}

function help(): void {
  console.log(`tpm ${VERSION} — task & project manager

Usage:
  tpm init [<dir>]                          bootstrap a tree (default: ~/tpm)
  tpm new project <slug> [--name "Name"] [--repo <url>] [--path <dir>]
  tpm new task <project> <slug> [--title "Title"] [--parent <parent-slug>] [--type pr|investigation]
  tpm ls [--all] [--archived] [--flat] [--status open] [--project <slug>]
  tpm context <task | project/task | parent/child>
  tpm start <task>                           set status: in-progress, log started
  tpm ready <task>                           set status: ready (+ allow_orchestrator: true), log promoted; tpm disallow after for supervised-only
  tpm complete <task> [--outcome "..."] [--no-archive] [--archive]
                                             set status: done, stamp closed, log; archives by type
  tpm block <task> "<reason>"                set status: blocked, log the reason
  tpm reopen <task> ["<reason>"]             set status: open, log it (optional reason on the Log)
  tpm pull <task>                            pull a queued task back into the human pile: ready -> open, needs-feedback -> needs-review
  tpm revert <task> ["<reason>"]             flip in-progress -> ready, log a timeout/revert (no-op otherwise)
  tpm status <task> <new-status>             generic status setter (validated)
  tpm set-type <task> <pr|investigation>   reclassify a task's type: (validated); back-end for tpm serve's type dropdown
  tpm log <task> "<message>"                 append a single timestamped Log line
  tpm edit <task> <title|context|plan|outcome> "<value>" [--expect-mtime <ms>]
                                             rewrite the title (frontmatter) or one prose section; back-end for tpm serve's inline editor
  tpm edit-project <project> <name|goal|context|notes> "<value>" [--expect-mtime <ms>]
                                             rewrite the project name (frontmatter) or one prose section (Goal/Context/Notes); back-end for tpm serve's project editor
  tpm pr <task> <url>                        add URL to prs:, log opened PR
  tpm report <task>                          attach a report artifact at <project>/tasks/<slug>/report.md (auto-folds file-form tasks);
                                             auto-flips in-progress -> needs-review (investigation analogue of tpm pr)
  tpm report <task> --export text            print the report as plain text (drops HTML comments)
  tpm lgtm <task>                            reviewer approval on a report task: derive Outcome + complete
  tpm request-changes <task> "<comment>"     reviewer pushback on a report: append to ## Reviewer feedback + flip to needs-feedback
  tpm allow <task>                           set allow_orchestrator: true (safe for autonomous runs)
  tpm disallow <task>                        set allow_orchestrator: false
  tpm archive <task | project/task>          move a done/dropped task to tasks/archive/
  tpm fold <task | project/task>             promote a file-form task to folder-form (idempotent)
  tpm reparent <task> <new-parent | --top>   move a task under a new parent (or to top-level); folds the new parent if needed
  tpm lock acquire <task> --as <id>          claim a per-task lock (atomic O_CREAT|O_EXCL)
  tpm lock release <task> --as <id> [--force]  release a per-task lock
  tpm lock heartbeat <task> --as <id>        refresh a held lock so stale-lock sweeps don't reclaim it
  tpm lock status [<task>]                   show holder + age (or legacy global lock if no task)
  tpm lock list                              list every claimed task across the tree
  tpm lock release-stale [--ttl <minutes>]   clear locks whose heartbeat is older than ttl
  tpm drift-check <project | task>           verify the project's repo.local is on its default branch + clean
  tpm next [--project <slug>] [--autonomous] [--claim <id>]
                                             print next leaf task (needs-feedback > ready, oldest first); --claim atomically locks
  tpm inbox                                  list human-queue tasks (needs-review, blocked, open) cross-project
  tpm orchestrate [--workers <N>] [--cli claude,copilot,…] [--minutes <N>] [--agent <name>] [--claude <path>] [--task <slug>]
                                             run a pool of concurrent worker loops in one invocation. pool size tracks
                                             \`workers\` in ~/.tpm/config.json (default: 1) — \`tpm config set workers N\`
                                             adjusts the live pool within one reconcile tick (scale-down drains).
                                             --workers <N> is a bootstrap default used only when config.workers is unset.
                                             --cli is a comma-separated CLI per worker slot (extra slots beyond the list use the default agent).
                                             --task pins a single pre-claimed task (pool flags ignored).
                                             --claude <path> is a back-compat alias that pins the agent to claude with a bin override.
  tpm poll [--dry-run]                       PR-signal poller: walk linked PRs, flip status, auto-close on merge
  tpm schedule install <name> --every <sec> -- <cmd> [args...]
                                             install a recurring job (Linux: systemd --user timer / cron fallback; Windows: Task Scheduler via schtasks)
  tpm schedule uninstall <name>              remove a job by name
  tpm schedule status [<name>]               with a name: installed | missing; without: list everything installed
  tpm schedule list                          print the names of all tpm-managed scheduled jobs
  tpm notify <start|finish|fail> <task>      best-effort osascript notification (cascade: task > project > global)
  tpm refresh-skills                         install/refresh user-scoped skills into ~/.claude/skills/ (macOS/Linux: symlink, Windows: copy)
  tpm serve [--port 7777] [--host 127.0.0.1] start a localhost HTTP UI for the queues (read-only)
  tpm report [--md]                          generate a rollup of every project/task to reports/index.{html,md}
  tpm root                                   print the tree root
  tpm path <project | task | project/task>   print the local repo path
  tpm now                                    timestamp in the configured timezone
  tpm config get <key>                       read a config key from ~/.tpm/config.json (known: ${KNOWN_CONFIG_KEYS.join(", ")})
  tpm config set <key> <value>               write a config key to ~/.tpm/config.json (e.g. \`tpm config set workers 3\`);
                                             tpm orchestrate hot-reloads workers each reconcile tick
  tpm version                                print the installed version

Layout (inside a tree):
  <slug>/project.md                          project goals + context
  <slug>/tasks/NNN-*.md                      file-form task
  <slug>/tasks/NNN-*/task.md                 folder-form task (parent)
  <slug>/tasks/NNN-*/NNN-*.md                child of a folder-form parent
  <slug>/tasks/archive/...                   archived tasks (mirrors live layout)
  <slug>/notes/                              free-form scratch
  reports/index.html                         generated rollup
  .tpm/templates/                            task & project templates

Tree root: ${CONFIG_PATH} -> root  (set by \`tpm init\`).
`);
}
