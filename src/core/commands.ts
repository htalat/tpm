import { readFileSync } from "node:fs";
import { loadProjects, archiveTask, taskHasReport, taskReportPath } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { findTask } from "./resolve.ts";
import { newTask } from "./new.ts";
import { readConfig, writeConfig } from "./config.ts";
import * as mutate from "./mutate.ts";

// The in-process command layer: the mutation subset of the CLI vocabulary,
// callable without spawning a process. `execCommand(root, argv)` speaks the
// exact argv grammar of the CLI so there is ONE vocabulary — the web layer
// (and any future JSON API) builds the same argv it always has, and the CLI's
// dispatch delegates the shared verbs here instead of keeping its own copy.
//
// Result shape deliberately mirrors what the old spawn-based runner produced
// (`{ok, stdout, stderr}`): stdout is the human-readable message(s) the CLI
// would have printed, stderr the error message. Callers that need branding
// (`tpm` -> `tpmgr` on Windows) apply it at the printing edge, same as before.
//
// Read verbs (ls, context, session, …) stay in cli.ts: they are formatting
// over loaders the web layer already imports directly.
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// The verbs cli.ts delegates here wholesale. Dispatch understands a slightly
// larger grammar than this set: `new task` and `config set workers` are also
// executable (the web's new-task form and worker stepper build those argvs),
// but the CLI keeps its own `new` / `config` cases — they carry extra
// sub-verbs (`new project`, `config get`) that stay CLI-only.
export const COMMAND_VERBS = new Set([
  "ready", "start", "block", "reopen", "pull", "revert", "log", "pr", "review",
  "status", "allow", "disallow", "set-type", "done", "complete", "drop",
  "lgtm", "request-changes", "edit", "edit-project", "archive",
]);

// `root` may be a thunk so resolution is deferred until a verb actually needs
// the tree: arity errors (and the `status` vocab listing) must not require a
// configured root — `tpm drop` with no args prints usage even outside a tree.
export function execCommand(root: string | (() => string), argv: string[]): CommandResult {
  const getRoot = typeof root === "function" ? root : () => root;
  try {
    return { ok: true, stdout: dispatch(getRoot, argv), stderr: "" };
  } catch (e: unknown) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

function dispatch(getRoot: () => string, argv: string[]): string {
  const cmd = argv[0];
  switch (cmd) {
    case "ready":
      return mutate.ready(resolveLiveTask(getRoot(), argv[1], "tpm ready <task>")).message;
    case "start":
      return mutate.start(resolveLiveTask(getRoot(), argv[1], "tpm start <task>")).message;
    case "block": {
      const reason = argv[2];
      if (!argv[1] || !reason) throw new Error('tpm block <task> "<reason>"');
      return mutate.block(resolveLiveTask(getRoot(), argv[1], 'tpm block <task> "<reason>"'), reason).message;
    }
    case "reopen":
      return mutate.reopen(resolveLiveTask(getRoot(), argv[1], 'tpm reopen <task> ["<reason>"]'), argv[2]).message;
    case "pull":
      return mutate.pullFromQueue(resolveLiveTask(getRoot(), argv[1], "tpm pull <task>")).message;
    case "revert":
      return mutate.revert(resolveLiveTask(getRoot(), argv[1], 'tpm revert <task> ["<reason>"]'), argv[2]).message;
    case "log": {
      const message = argv[2];
      if (!argv[1] || !message) throw new Error('tpm log <task> "<message>"');
      return mutate.logEntry(resolveLiveTask(getRoot(), argv[1], 'tpm log <task> "<message>"'), message).message;
    }
    case "pr": {
      const url = argv[2];
      if (!argv[1] || !url) throw new Error("tpm pr <task> <url>");
      return mutate.addPr(resolveLiveTask(getRoot(), argv[1], "tpm pr <task> <url>"), url).message;
    }
    case "review":
      return mutate.review(resolveLiveTask(getRoot(), argv[1], "tpm review <task>")).message;
    case "status": {
      // --force bypasses the transition legality table (transitions.ts) — the
      // repair hatch for hand-mangled frontmatter or a flow the table doesn't
      // model yet. Normal moves should go through the purpose-built verbs.
      const force = argv.includes("--force");
      const positional = argv.slice(1).filter(a => a !== "--force");
      const newStatus = positional[1];
      // No new-status arg → self-document the vocabulary instead of erroring,
      // so agents discover valid statuses + the verbs that reach them from the
      // CLI itself (no grepping the source). Covers both `tpm status` and the
      // half-typed `tpm status <task>`.
      if (!newStatus) return statusVocabListing();
      if (!positional[0]) throw new Error("tpm status <task> <new-status> [--force]");
      return mutate.setStatus(
        resolveLiveTask(getRoot(), positional[0], "tpm status <task> <new-status> [--force]"),
        newStatus,
        undefined,
        { force },
      ).message;
    }
    case "allow":
      return mutate.setAllowOrchestrator(resolveLiveTask(getRoot(), argv[1], "tpm allow <task>"), true).message;
    case "disallow":
      return mutate.setAllowOrchestrator(resolveLiveTask(getRoot(), argv[1], "tpm disallow <task>"), false).message;
    case "set-type": {
      const newType = argv[2];
      if (!argv[1] || !newType) throw new Error("tpm set-type <task> <pr|investigation>");
      return mutate.setType(resolveLiveTask(getRoot(), argv[1], "tpm set-type <task> <type>"), newType).message;
    }
    case "done": // alias: matches the `/tpm done` slash command + AGENTS "close out"
    case "complete": {
      if (!argv[1]) throw new Error('tpm complete <task> [--outcome "..."] [--no-archive] [--archive]');
      const outcome = parseFlag(argv, "--outcome");
      const noArchive = argv.includes("--no-archive");
      const forceArchive = argv.includes("--archive");
      if (noArchive && forceArchive) throw new Error("--archive and --no-archive are mutually exclusive");
      const archiveOpt = noArchive ? false : forceArchive ? true : undefined;
      const r = mutate.complete(resolveLiveTask(getRoot(), argv[1], "tpm complete <task>"), {
        outcome,
        archive: archiveOpt,
      });
      return r.archivedAt ? `${r.message}\nArchived -> ${r.archivedAt}` : r.message;
    }
    case "drop": {
      // Terminal "abandon" verb — the dropped-status counterpart to complete.
      // Optional reason lands in ## Outcome + the Log line; reasonless drops
      // log a plain `dropped` (block/reopen dash convention).
      if (!argv[1]) throw new Error('tpm drop <task> ["<reason>"]');
      return mutate.drop(resolveLiveTask(getRoot(), argv[1], 'tpm drop <task> ["<reason>"]'), argv[2]).message;
    }
    case "lgtm": {
      // Reviewer LGTM on an investigation report: derive an Outcome from the
      // report file (title + first paragraph) and run complete.
      if (!argv[1]) throw new Error("tpm lgtm <task>");
      const task = resolveLiveTask(getRoot(), argv[1], "tpm lgtm <task>");
      if (!taskHasReport(task)) throw new Error(`${task.slug}: no report attached. Run \`tpm report ${argv[1]}\` first.`);
      const reportText = readFileSync(taskReportPath(task), "utf8");
      const outcome = mutate.deriveReportOutcome(reportText);
      const r = mutate.complete(task, { outcome });
      return r.archivedAt ? `${r.message}\nArchived -> ${r.archivedAt}` : r.message;
    }
    case "request-changes": {
      const comment = argv[2];
      if (!argv[1] || !comment) throw new Error('tpm request-changes <task> "<comment>"');
      return mutate.requestReportChanges(
        resolveLiveTask(getRoot(), argv[1], 'tpm request-changes <task> "<comment>"'),
        comment,
      ).message;
    }
    case "edit": {
      const section = argv[2];
      const value = argv[3];
      if (!argv[1] || !section || value === undefined) {
        throw new Error('tpm edit <task> <title|context|plan|outcome> "<value>" [--expect-mtime <ms>]');
      }
      return mutate.editTaskSection(
        resolveLiveTask(getRoot(), argv[1], 'tpm edit <task> <section> "<value>"'),
        section,
        value,
        { expectMtimeMs: parseMtime("tpm edit", argv) },
      ).message;
    }
    case "edit-project": {
      const section = argv[2];
      const value = argv[3];
      if (!argv[1] || !section || value === undefined) {
        throw new Error('tpm edit-project <project> <name|goal|context|notes> "<value>" [--expect-mtime <ms>]');
      }
      return mutate.editProjectSection(
        resolveProject(getRoot(), argv[1]),
        section,
        value,
        { expectMtimeMs: parseMtime("tpm edit-project", argv) },
      ).message;
    }
    case "archive": {
      const query = argv[1];
      if (!query) throw new Error("tpm archive <task | project/task>");
      const projects = loadProjects(getRoot(), { archived: true });
      const match = findTask(projects, query);
      if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls --all\`.`);
      const path = archiveTask(match.task);
      return `Archived ${qualifySlug(match.project.slug, match.task)} -> ${path}`;
    }
    case "new": {
      // Web new-task form only — `new project` stays CLI-only.
      const project = argv[2];
      const slug = argv[3];
      if (argv[1] !== "task" || !project || !slug) {
        throw new Error("tpm new task <project> <slug> [--title 'Title'] [--parent <parent-slug>] [--type pr|investigation]");
      }
      const path = newTask(getRoot(), project, slug, {
        title: parseFlag(argv, "--title"),
        parent: parseFlag(argv, "--parent"),
        type: parseFlag(argv, "--type"),
      });
      return `Created ${path}`;
    }
    case "config": {
      // Web worker stepper only — `config get` stays CLI-only.
      const key = argv[2];
      const raw = argv[3];
      if (argv[1] !== "set" || !key || raw === undefined) throw new Error("tpm config set <key> <value>");
      if (key !== "workers") throw new Error(`tpm config set <key> <value>: unknown key "${key}" (known: workers)`);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error("workers must be a non-negative integer");
      const cfg = readConfig();
      cfg.workers = n;
      writeConfig(cfg);
      return `workers: ${n}`;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

// ---- the `tpm status` no-arg vocabulary listing ---------------------------

function statusVocabListing(): string {
  const lines = ["Valid task statuses (transition via the verb shown, or `tpm status <task> <new-status>` directly):", ""];
  const width = Math.max(...mutate.STATUS_VOCAB.map((e) => e.status.length));
  for (const { status, verbs, note } of mutate.STATUS_VOCAB) {
    const reach = verbs.length ? verbs.join(", ") : "(no agent verb)";
    const suffix = note ? `  — ${note}` : "";
    lines.push(`  ${status.padEnd(width)}  ${reach}${suffix}`);
  }
  return lines.join("\n");
}

// ---- helpers ---------------------------------------------------------------

function resolveLiveTask(root: string, query: string | undefined, usageMsg: string): Task {
  if (!query) throw new Error(usageMsg);
  // Live tree only — mutations never target archived tasks (mutate's
  // guardArchived is the backstop, but excluding them here also keeps an
  // archived slug from shadowing a live one during resolution).
  const projects = loadProjects(root);
  const match = findTask(projects, query);
  if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
  return match.task;
}

function resolveProject(root: string, query: string): Project {
  const project = loadProjects(root, { archived: true }).find(p => p.slug === query);
  if (!project) throw new Error(`No project matched "${query}". Try \`tpm ls\`.`);
  return project;
}

function qualifySlug(projectSlug: string, task: Task): string {
  return task.parent ? `${projectSlug}/${task.parent}/${task.slug}` : `${projectSlug}/${task.slug}`;
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseMtime(verb: string, argv: string[]): number | undefined {
  const raw = parseFlag(argv, "--expect-mtime");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${verb}: --expect-mtime must be a number, got "${raw}"`);
  return n;
}
