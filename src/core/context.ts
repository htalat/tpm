import { loadProjects, isParent } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { findTask, findRepoTarget } from "./resolve.ts";
import { resolveSameRepoStrategy, DEFAULT_SAME_REPO_STRATEGY } from "./orchestrate/strategy.ts";
import { allRunLogs, latestSessionId } from "./orchestrate/run_log.ts";
import { branchState } from "./drift.ts";

export interface Repo {
  remote: string | null;
  local: string | null;
}

export function resolveRepo(project: Project, task?: Task): Repo {
  const t = readRepo(task?.data.repo);
  const p = readRepo(project.data.repo);
  return {
    remote: t.remote ?? p.remote,
    local: t.local ?? p.local,
  };
}

function readRepo(v: unknown): Repo {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { remote: null, local: null };
  const o = v as Record<string, unknown>;
  return { remote: str(o.remote) ?? null, local: str(o.local) ?? null };
}

export function context(root: string, query: string): string {
  const projects = loadProjects(root, { archived: true });
  const match = findTask(projects, query);
  if (!match) throw new Error(`No task matched "${query}". Try \`tpm ls\`.`);
  const { project, task } = match;
  const repo = resolveRepo(project, task);

  const lines: string[] = [];
  lines.push(`# Task briefing: ${str(task.data.title) ?? task.slug}`);
  lines.push("");
  // Resume banner (run-log audit theme 6): an in-progress task with prior
  // run logs means THIS session is picking up mid-flight, not starting
  // fresh — 093/004's resume cold-started onto another task's branch with
  // its uncommitted work and never noticed. Make the state impossible to miss.
  const priorRuns = String(task.data.status ?? "") === "in-progress" ? allRunLogs(task).length : 0;
  if (priorRuns > 0) {
    const sessionId = latestSessionId(task);
    const state = repo.local ? branchState(repo.local) : null;
    lines.push(`> **RESUMING — ${priorRuns} prior run${priorRuns === 1 ? "" : "s"} on this task.**`);
    if (state) {
      lines.push(`> Working tree: branch \`${state.branch}\`${state.dirty ? ", **uncommitted changes present**" : ", clean"}.`);
      lines.push("> Before writing anything: confirm this branch belongs to THIS task and reconcile any");
      lines.push("> leftover changes (they may be another task's work).");
    }
    lines.push("> Read the Log section below for what already happened — do not redo shipped steps.");
    if (sessionId) lines.push(`> Prior agent session: \`claude --resume ${sessionId}\``);
    lines.push("");
  }
  lines.push(`- Project: ${str(project.data.name) ?? project.slug} (${project.slug})`);
  if (repo.remote) lines.push(`- Repo: ${repo.remote}`);
  if (repo.local) lines.push(`- Local: ${repo.local}`);
  if (repo.local) {
    const state = branchState(repo.local);
    if (state) {
      lines.push(`- Branch: ${state.branch} (${state.dirty ? "dirty — uncommitted changes" : "clean"})`);
    }
  }
  lines.push(`- Host: ${str(project.data.host) ?? "github"}`);
  const strategy = resolveSameRepoStrategy(project);
  if (strategy !== DEFAULT_SAME_REPO_STRATEGY) {
    // Only surface when explicitly non-default; default is "serialize" and
    // mentioning it on every briefing would be noise.
    lines.push(`- Same-repo strategy: ${strategy}`);
  }
  const workflow = str(task.data.workflow) ?? str(project.data.workflow);
  if (workflow) lines.push(`- Workflow: ${workflow}`);
  lines.push(`- Type: ${str(task.data.type) ?? "?"}`);
  if (Array.isArray(task.data.prs) && task.data.prs.length) {
    lines.push(`- PRs: ${task.data.prs.join(", ")}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Project context");
  lines.push("");
  lines.push(extractSection(project.body, "Goal") ?? project.body.trim() ?? "_(no project body)_");

  const projectContext = extractSection(project.body, "Context");
  if (projectContext) {
    lines.push("");
    lines.push("### Project background");
    lines.push("");
    lines.push(projectContext);
  }

  // The project's `## Notes` is the de-facto project-level workflow doc:
  // conventions, gotchas, validation steps. It lives in project.md inside the
  // tpm tree — outside the agent's repo sandbox — so a path pointer is useless;
  // the agent can only ever see what `tpm context` prints. Inline it verbatim.
  const projectNotes = extractProseSection(project.body, "Notes");
  if (projectNotes) {
    lines.push("");
    lines.push("### Project notes (conventions — treat as workflow guidance)");
    lines.push("");
    lines.push(projectNotes);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(trimTaskBody(task.body));

  // Container tasks aren't actionable directly — surface their children so the
  // agent (or a parent run) never shells into the tree to discover them.
  if (isParent(task)) {
    lines.push("");
    lines.push("### Children");
    lines.push("");
    lines.push("This task is a container — work its children, not the parent directly.");
    for (const child of task.children!) {
      const title = str(child.data.title) ?? child.slug;
      const status = str(child.data.status) ?? "?";
      const ref = `${project.slug}/${task.slug}/${child.slug}`;
      lines.push(`- ${ref} — ${title} [${status}]`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Working agreement");
  // Drive all task state through `tpm` verbs. The task file lives in the tpm
  // tree, outside the repo sandbox — the agent's file tools can't reach it, so
  // never tell it to hand-edit the Log, frontmatter, or `prs:` list.
  const taskRef = task.parent
    ? `${project.slug}/${task.parent}/${task.slug}`
    : `${project.slug}/${task.slug}`;
  if (repo.local) lines.push(`- Work happens in ${repo.local}. cd there before editing code. The task tree lives outside this repo — drive task state through \`tpm\` verbs, never by reading or editing the task file directly.`);
  lines.push(`- Log progress with \`tpm log ${taskRef} "<what changed>"\`.`);
  if (str(task.data.type) === "investigation") {
    lines.push(`- Deliverable is a report: \`tpm report ${taskRef}\` scaffolds/attaches it; write findings into that file, then re-run \`tpm report ${taskRef}\` to hand off for review.`);
  } else {
    lines.push(`- After opening the PR, run \`tpm pr ${taskRef} <url>\` — it links the PR and advances status for review. Don't hand-edit \`prs:\`.`);
  }
  lines.push(`- Close out with \`tpm complete ${taskRef}\` (for \`type: pr\`, the poller usually does this once the PR merges).`);
  lines.push(`- Stuck? \`tpm block ${taskRef} "<reason>"\` (human queue) or \`tpm revert ${taskRef} "<reason>"\` (back to ready). Surface blockers explicitly; never exit while still in-progress.`);
  lines.push(`- For shipping (commit / push / PR / close), follow the repo's workflow doc: ${workflow ? `read ${workflow}` : "look for AGENTS.md, then CLAUDE.md, in the repo root"}. If no doc is found, ask before each step.`);

  return lines.join("\n");
}

export function repoPath(root: string, query: string): string {
  const projects = loadProjects(root, { archived: true });
  const target = findRepoTarget(projects, query);
  if (!target) throw new Error(`No project or task matched "${query}". Try \`tpm ls\`.`);
  const repo = resolveRepo(target.project, target.task);
  if (!repo.local) {
    const where = target.task ? `${target.project.slug}/${target.task.slug}` : target.project.slug;
    throw new Error(`No local path set for ${where}. Set repo.local in ${target.task?.path ?? target.project.path}.`);
  }
  return repo.local;
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`(?:^|\\n)##\\s+${escapeRe(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const content = m[1].trim();
  return content.length ? content : null;
}

// Like `extractSection`, but also strips HTML comments before checking for
// content — so a section that holds only its scaffold placeholder (e.g. the
// `<!-- Living notes... -->` in a fresh project.md) is treated as empty.
function extractProseSection(body: string, heading: string): string | null {
  const raw = extractSection(body, heading);
  if (!raw) return null;
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length ? stripped : null;
}

// Strip historical / placeholder sections from a task body before embedding it
// in the briefing. `## Log` is always dropped (chronological flips, already
// happened). `## Outcome` is dropped only when its body is empty or just the
// `<!-- Filled when closed: ... -->` placeholder — a non-empty Outcome means
// the task already shipped and the agent benefits from seeing what landed.
export function trimTaskBody(body: string): string {
  let out = stripSection(body, "Log");
  out = stripSectionIfPlaceholder(out, "Outcome");
  return out.trim();
}

function stripSection(body: string, heading: string): string {
  const re = new RegExp(`(?:^|\\n)##\\s+${escapeRe(heading)}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, "i");
  return body.replace(re, "");
}

function stripSectionIfPlaceholder(body: string, heading: string): string {
  const re = new RegExp(`(?:^|\\n)##\\s+${escapeRe(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m) return body;
  const content = m[1].replace(/<!--[\s\S]*?-->/g, "").trim();
  if (content.length > 0) return body;
  return body.replace(re, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}
