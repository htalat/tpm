import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot } from "./root.ts";
import { newProject, newTask } from "./new.ts";
import { context, repoPath } from "./context.ts";
import { report } from "./report.ts";
import { archiveTask, foldTask, isParent, loadProjects, flatTasks, rollupStatus } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { findTask } from "./resolve.ts";
import { init } from "./init.ts";
import { CONFIG_PATH } from "./config.ts";
import { now } from "./time.ts";

const VERSION = readVersion();

const args = process.argv.slice(2);
const cmd = args[0];

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
        if (!project || !slug) usage("tpm new task <project> <slug> [--title 'Title'] [--parent <parent-slug>]");
        const path = newTask(root, project, slug, {
          title: parseFlag(args, "--title"),
          parent: parseFlag(args, "--parent"),
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
    case "context": {
      const root = findRoot();
      const query = args[1];
      if (!query) usage("tpm context <task | project/task>");
      console.log(context(root, query));
      break;
    }
    case "report": {
      const root = findRoot();
      const format = args.includes("--md") ? "md" : "html";
      const path = report(root, { format });
      console.log(`Wrote ${path}`);
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
    case "next": {
      const root = findRoot();
      const projects = loadProjects(root);
      const projectFilter = parseFlag(args, "--project");
      const autonomous = args.includes("--autonomous");
      const candidates: Array<{ project: Project; task: Task }> = [];
      for (const p of projects) {
        if (projectFilter && p.slug !== projectFilter) continue;
        for (const t of flatTasks(p.tasks)) {
          if (t.archived) continue;
          if (isParent(t)) continue;
          if (t.data.status !== "ready") continue;
          if (autonomous && t.data.allow_orchestrator !== true) continue;
          candidates.push({ project: p, task: t });
        }
      }
      if (candidates.length === 0) {
        const where = projectFilter ? ` in project "${projectFilter}"` : "";
        const gate = autonomous ? " with allow_orchestrator: true" : "";
        console.error(`No ready tasks${where}${gate}.`);
        process.exit(1);
      }
      candidates.sort((a, b) => {
        const ac = String(a.task.data.created ?? "");
        const bc = String(b.task.data.created ?? "");
        return ac.localeCompare(bc);
      });
      const pick = candidates[0];
      console.log(qualifySlug(pick.project.slug, pick.task));
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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
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
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function help(): void {
  console.log(`tpm ${VERSION} — task & project manager

Usage:
  tpm init [<dir>]                          bootstrap a tree (default: ~/tpm)
  tpm new project <slug> [--name "Name"] [--repo <url>] [--path <dir>]
  tpm new task <project> <slug> [--title "Title"] [--parent <parent-slug>]
  tpm ls [--all] [--archived] [--flat] [--status open] [--project <slug>]
  tpm context <task | project/task | parent/child>
  tpm archive <task | project/task>          move a done/dropped task to tasks/archive/
  tpm fold <task | project/task>             promote a file-form task to folder-form (idempotent)
  tpm next [--project <slug>] [--autonomous] print the next ready leaf task (oldest first)
  tpm report [--md]
  tpm root                                   print the tree root
  tpm path <project | task | project/task>   print the local repo path
  tpm now                                    timestamp in the configured timezone
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
