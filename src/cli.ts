import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot } from "./root.ts";
import { newProject, newTask } from "./new.ts";
import { context, repoPath } from "./context.ts";
import { report } from "./report.ts";
import { archiveTask, loadProjects } from "./tree.ts";
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
        if (!project || !slug) usage("tpm new task <project> <slug> [--title 'Title']");
        const path = newTask(root, project, slug, parseFlag(args, "--title"));
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
      const projects = loadProjects(root, { archived: includeArchived });
      const projectFilter = parseFlag(args, "--project");
      if (projects.length === 0) {
        console.log("No projects yet. Run: tpm new project <slug>");
        break;
      }
      for (const p of projects) {
        if (projectFilter && p.slug !== projectFilter) continue;
        const tasks = filter
          ? p.tasks.filter(t => t.data.status === filter)
          : showAll
            ? p.tasks
            : includeArchived
              ? p.tasks
              : p.tasks.filter(t => !isHiddenStatus(t.data.status) && !t.archived);
        if (tasks.length === 0 && filter) continue;
        const name = strOr(p.data.name, p.slug);
        const status = strOr(p.data.status, "?");
        console.log(`\n${name}  (${p.slug})  [${status}]`);
        if (tasks.length === 0) console.log(`  (no tasks)`);
        for (const t of tasks) {
          const prs = Array.isArray(t.data.prs) ? t.data.prs.join(", ") : "";
          const archived = t.archived ? "  [archived]" : "";
          console.log(`  · ${pad(strOr(t.data.status, "?"), 12)} ${pad(strOr(t.data.type, "?"), 14)} ${t.slug}${archived}${prs ? "  " + prs : ""}`);
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
      console.log(`Archived ${match.project.slug}/${match.task.slug} -> ${path}`);
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

function findTask(projects: ReturnType<typeof loadProjects>, query: string) {
  if (query.includes("/")) {
    const [p, t] = query.split("/", 2);
    const project = projects.find(pr => pr.slug === p);
    const task = project?.tasks.find(task => matchTask(task.slug, t));
    return project && task ? { project, task } : null;
  }
  const matches = projects.flatMap(project => {
    const task = project.tasks.find(t => matchTask(t.slug, query));
    return task ? [{ project, task }] : [];
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.project.slug}/${m.task.slug}`).join("\n");
    throw new Error(`Ambiguous task "${query}". Use project/task. Matches:\n${list}`);
  }
  return null;
}

function matchTask(slug: string, query: string): boolean {
  return slug === query || slug.endsWith(`-${query}`) || slug.replace(/^\d+-/, "") === query;
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
  tpm new task <project> <slug> [--title "Title"]
  tpm ls [--all] [--archived] [--status open] [--project <slug>]
  tpm context <task | project/task>
  tpm archive <task | project/task>          move a done/dropped task to tasks/archive/
  tpm report [--md]
  tpm root                                  print the tree root
  tpm path <project | task | project/task>  print the local repo path
  tpm now                                   timestamp in the configured timezone
  tpm version                               print the installed version

Layout (inside a tree):
  <slug>/project.md              project goals + context
  <slug>/tasks/NNN-*.md          active task files
  <slug>/tasks/archive/NNN-*.md  archived done/dropped task files
  <slug>/notes/                  free-form scratch
  reports/index.html             generated rollup
  .tpm/templates/                task & project templates

Tree root: ${CONFIG_PATH} -> root  (set by \`tpm init\`).
`);
}
