import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadProjects, flatTasks, isParent, rollupStatus } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { resolveRepo } from "./context.ts";
import { now } from "./time.ts";
import { BASE_CSS } from "./css.ts";

export function report(root: string, opts: { format: "html" | "md" }): string {
  const projects = loadProjects(root, { archived: true });
  const reportsDir = join(root, "reports");
  mkdirSync(reportsDir, { recursive: true });

  if (opts.format === "md") {
    const out = join(reportsDir, "index.md");
    writeFileSync(out, renderMd(projects));
    return out;
  }
  const out = join(reportsDir, "index.html");
  writeFileSync(out, renderHtml(projects));
  return out;
}

function renderHtml(projects: Project[]): string {
  const allLeaves = projects.flatMap(p => leafTasks(p.tasks).filter(t => !t.archived));
  const archivedCount = projects.reduce(
    (n, p) => n + flatTasks(p.tasks).filter(t => t.archived).length,
    0,
  );
  const totals = countByStatus(allLeaves);
  const generated = now();
  const openCount = (totals["open"] ?? 0) + (totals["ready"] ?? 0) + (totals["in-progress"] ?? 0) + (totals["blocked"] ?? 0);

  let body = `<header><h1>tpm</h1>`;
  body += `<p class="meta">${generated} · ${projects.length} project${projects.length === 1 ? "" : "s"} · ${allLeaves.length} active task${allLeaves.length === 1 ? "" : "s"} · ${archivedCount} archived · <strong>${openCount} open</strong></p>`;
  body += `<div class="summary">${renderSummary(totals)}</div></header>`;

  if (projects.length === 0) {
    body += `<p class="meta">No projects yet. Run <code>tpm new project &lt;slug&gt;</code>.</p>`;
  }

  for (const p of projects) {
    const allActive = flatTasks(p.tasks).filter(t => !t.archived);
    const activeLeaves = leafTasks(p.tasks).filter(t => !t.archived);
    const projectArchivedCount = flatTasks(p.tasks).length - allActive.length;
    const counts = countByStatus(activeLeaves);
    const repo = resolveRepo(p);
    const repoLink = repo.remote
      ? ` <a class="repo" href="${esc(repo.remote)}">${esc(repoShort(repo.remote))}</a>`
      : "";
    body += `<section><h2>${esc(str(p.data.name) ?? p.slug)} <span class="badge s-${cls(p.data.status)}">${esc(str(p.data.status) ?? "?")}</span>${repoLink}</h2>`;
    const localBit = repo.local ? ` · <code title="local checkout">${esc(repo.local)}</code>` : "";
    body += `<p class="meta"><code>${esc(p.slug)}</code> · ${activeLeaves.length} active task${activeLeaves.length === 1 ? "" : "s"} · ${projectArchivedCount} archived${localBit}</p>`;
    if (activeLeaves.length) body += `<div class="summary">${renderSummary(counts)}</div>`;

    const goal = extractSection(p.body, "Goal");
    if (goal) body += `<blockquote>${esc(goal).replace(/\n/g, "<br>")}</blockquote>`;

    const topActive = p.tasks.filter(t => !t.archived || (t.children?.some(c => !c.archived) ?? false));
    if (topActive.length === 0) {
      body += `<p class="meta">No active tasks.</p></section>`;
      continue;
    }
    body += `<table><thead><tr><th>Task</th><th>Status</th><th>Type</th><th>PRs</th><th>Created</th><th>Closed</th></tr></thead><tbody>`;
    for (const t of topActive) {
      body += renderTaskRow(t, 0);
      for (const c of t.children ?? []) {
        if (c.archived) continue;
        body += renderTaskRow(c, 1);
      }
    }
    body += `</tbody></table></section>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tpm report</title>
<style>${BASE_CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

function renderTaskRow(t: Task, depth: number): string {
  const prs = (Array.isArray(t.data.prs) ? t.data.prs : [])
    .map(pr => `<a href="${esc(String(pr))}">${esc(prShort(String(pr)))}</a>`)
    .join(", ");
  const status = rollupStatus(t);
  const indent = depth > 0 ? `<span class="indent">↳</span> ` : "";
  let row = `<tr>`;
  row += `<td>${indent}<strong>${esc(str(t.data.title) ?? t.slug)}</strong><br><span class="meta">${esc(t.slug)}</span></td>`;
  row += `<td><span class="badge s-${cls(status)}">${esc(status)}</span></td>`;
  row += `<td>${esc(str(t.data.type) ?? "")}</td>`;
  row += `<td>${prs}</td>`;
  row += `<td>${esc(str(t.data.created) ?? "")}</td>`;
  row += `<td>${esc(str(t.data.closed) ?? "")}</td>`;
  row += `</tr>`;
  return row;
}

function leafTasks(tasks: Task[]): Task[] {
  return flatTasks(tasks).filter(t => !isParent(t));
}


function renderSummary(counts: Record<string, number>): string {
  const order = ["open", "ready", "in-progress", "blocked", "done", "dropped"];
  const known = new Set(order);
  const parts = order.filter(k => counts[k]).map(k => `<div><strong>${counts[k]}</strong> ${k}</div>`);
  for (const [k, v] of Object.entries(counts)) {
    if (!known.has(k) && v) parts.push(`<div><strong>${v}</strong> ${k}</div>`);
  }
  return parts.join("");
}

function countByStatus(tasks: Task[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    const s = String(t.data.status ?? "unknown");
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

function cls(s: unknown): string {
  return String(s ?? "unknown").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

export function repoShort(url: string): string {
  const ado = url.match(/dev\.azure\.com\/([^/]+)\/[^/]+\/_git\/([^/?#]+)/);
  if (ado) return `${ado[1]}/${ado[2]}`;
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (m) return m[1];
  const ssh = url.match(/^[^:]+:([^/]+\/[^/.]+)/);
  if (ssh) return ssh[1];
  return url.length > 40 ? url.slice(0, 37) + "…" : url;
}

export function prShort(url: string): string {
  const ado = url.match(/dev\.azure\.com\/([^/]+)\/[^/]+\/_git\/([^/]+)\/pullrequest\/(\d+)/);
  if (ado) return `${ado[1]}/${ado[2]}!${ado[3]}`;
  const m = url.match(/\/(?:pull|pulls)\/(\d+)/);
  if (m) {
    const repo = url.match(/github\.com\/([^/]+\/[^/]+)/);
    return repo ? `${repo[1]}#${m[1]}` : `#${m[1]}`;
  }
  return url.length > 40 ? url.slice(0, 37) + "…" : url;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`(?:^|\\n)##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const content = m[1].trim().replace(/^<!--[\s\S]*?-->\s*/g, "").trim();
  return content.length ? content : null;
}

function renderMd(projects: Project[]): string {
  let s = `# tpm report\n\nGenerated ${now()}\n\n`;
  for (const p of projects) {
    const allActive = flatTasks(p.tasks).filter(t => !t.archived);
    const archivedCount = flatTasks(p.tasks).length - allActive.length;
    s += `## ${str(p.data.name) ?? p.slug} (\`${p.slug}\`) — ${str(p.data.status) ?? "?"}\n\n`;
    if (archivedCount) s += `_${archivedCount} archived._\n\n`;
    const topActive = p.tasks.filter(t => !t.archived || (t.children?.some(c => !c.archived) ?? false));
    if (topActive.length === 0) { s += "_No active tasks._\n\n"; continue; }
    s += "| Task | Status | Type | PRs |\n|---|---|---|---|\n";
    for (const t of topActive) {
      s += renderMdRow(t, 0);
      for (const c of t.children ?? []) {
        if (c.archived) continue;
        s += renderMdRow(c, 1);
      }
    }
    s += "\n";
  }
  return s;
}

function renderMdRow(t: Task, depth: number): string {
  const prs = (Array.isArray(t.data.prs) ? t.data.prs : []).join(", ");
  const status = rollupStatus(t);
  const indent = depth > 0 ? "↳ " : "";
  return `| ${indent}${str(t.data.title) ?? t.slug} | ${status} | ${str(t.data.type) ?? "?"} | ${prs} |\n`;
}
