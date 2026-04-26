import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadProjects } from "./tree.ts";
import type { Project, Task } from "./tree.ts";
import { resolveRepo } from "./context.ts";
import { now } from "./time.ts";

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
  const allTasks = projects.flatMap(p => p.tasks.filter(t => !t.archived));
  const archivedCount = projects.reduce((n, p) => n + p.tasks.filter(t => t.archived).length, 0);
  const totals = countByStatus(allTasks);
  const generated = now();
  const openCount = (totals["open"] ?? 0) + (totals["in-progress"] ?? 0) + (totals["blocked"] ?? 0);

  let body = `<header><h1>tpm</h1>`;
  body += `<p class="meta">${generated} · ${projects.length} project${projects.length === 1 ? "" : "s"} · ${allTasks.length} active task${allTasks.length === 1 ? "" : "s"} · ${archivedCount} archived · <strong>${openCount} open</strong></p>`;
  body += `<div class="summary">${renderSummary(totals)}</div></header>`;

  if (projects.length === 0) {
    body += `<p class="meta">No projects yet. Run <code>tpm new project &lt;slug&gt;</code>.</p>`;
  }

  for (const p of projects) {
    const activeTasks = p.tasks.filter(t => !t.archived);
    const projectArchivedCount = p.tasks.length - activeTasks.length;
    const counts = countByStatus(activeTasks);
    const repo = resolveRepo(p);
    const repoLink = repo.remote
      ? ` <a class="repo" href="${esc(repo.remote)}">${esc(repoShort(repo.remote))}</a>`
      : "";
    body += `<section><h2>${esc(str(p.data.name) ?? p.slug)} <span class="badge s-${cls(p.data.status)}">${esc(str(p.data.status) ?? "?")}</span>${repoLink}</h2>`;
    const localBit = repo.local ? ` · <code title="local checkout">${esc(repo.local)}</code>` : "";
    body += `<p class="meta"><code>${esc(p.slug)}</code> · ${activeTasks.length} active task${activeTasks.length === 1 ? "" : "s"} · ${projectArchivedCount} archived${localBit}</p>`;
    if (activeTasks.length) body += `<div class="summary">${renderSummary(counts)}</div>`;

    const goal = extractSection(p.body, "Goal");
    if (goal) body += `<blockquote>${esc(goal).replace(/\n/g, "<br>")}</blockquote>`;

    if (activeTasks.length === 0) {
      body += `<p class="meta">No active tasks.</p></section>`;
      continue;
    }
    body += `<table><thead><tr><th>Task</th><th>Status</th><th>Type</th><th>PRs</th><th>Created</th><th>Closed</th></tr></thead><tbody>`;
    for (const t of activeTasks) {
      const prs = (Array.isArray(t.data.prs) ? t.data.prs : [])
        .map(pr => `<a href="${esc(String(pr))}">${esc(prShort(String(pr)))}</a>`)
        .join(", ");
      body += `<tr>`;
      body += `<td><strong>${esc(str(t.data.title) ?? t.slug)}</strong><br><span class="meta">${esc(t.slug)}</span></td>`;
      body += `<td><span class="badge s-${cls(t.data.status)}">${esc(str(t.data.status) ?? "?")}</span></td>`;
      body += `<td>${esc(str(t.data.type) ?? "")}</td>`;
      body += `<td>${prs}</td>`;
      body += `<td>${esc(str(t.data.created) ?? "")}</td>`;
      body += `<td>${esc(str(t.data.closed) ?? "")}</td>`;
      body += `</tr>`;
    }
    body += `</tbody></table></section>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tpm report</title>
<style>${CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1.25rem; color: #1f2328; background: #fff; }
h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
h2 { margin-top: 2.25rem; padding-bottom: .25rem; border-bottom: 1px solid #d0d7de; font-size: 1.2rem; display: flex; gap: .6rem; align-items: center; }
header { padding-bottom: 1rem; border-bottom: 2px solid #d0d7de; margin-bottom: 1rem; }
.meta { color: #57606a; font-size: .9em; margin: 0; }
section { margin-bottom: 2rem; }
table { width: 100%; border-collapse: collapse; margin-top: .75rem; font-size: .92em; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
th { font-weight: 600; color: #57606a; font-size: .78em; text-transform: uppercase; letter-spacing: .04em; background: #f6f8fa; }
tr:hover td { background: #f6f8fa; }
.badge { display: inline-block; padding: 1px 9px; border-radius: 12px; font-size: .78em; font-weight: 500; }
.s-open { background: #ddf4ff; color: #0969da; }
.s-in-progress { background: #fff8c5; color: #9a6700; }
.s-blocked { background: #ffebe9; color: #cf222e; }
.s-done, .s-active { background: #dafbe1; color: #1a7f37; }
.s-dropped, .s-archived, .s-paused { background: #eaeef2; color: #57606a; }
.summary { display: flex; gap: .5rem; flex-wrap: wrap; margin: .75rem 0; }
.summary > div { padding: .35rem .75rem; background: #f6f8fa; border-radius: 6px; font-size: .9em; }
blockquote { margin: .75rem 0; padding: .5rem .9rem; border-left: 3px solid #d0d7de; color: #57606a; background: #f6f8fa; border-radius: 0 4px 4px 0; }
code { background: #f6f8fa; padding: 1px 5px; border-radius: 3px; font-size: .9em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
a.repo { font-size: .8em; font-weight: 400; padding: 1px 8px; background: #f6f8fa; border-radius: 6px; color: #57606a; }
a.repo:hover { background: #eaeef2; text-decoration: none; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  h2, header { border-color: #30363d; }
  th { background: #161b22; color: #8d96a0; }
  th, td { border-color: #21262d; }
  tr:hover td { background: #161b22; }
  .summary > div, blockquote, code { background: #161b22; }
  blockquote { border-color: #30363d; color: #8d96a0; }
  .meta { color: #8d96a0; }
  a.repo { background: #161b22; color: #8d96a0; }
  a.repo:hover { background: #21262d; }
  .s-open { background: #033158; color: #79c0ff; }
  .s-in-progress { background: #4d3a00; color: #e3b341; }
  .s-blocked { background: #5d1a1a; color: #ff7b72; }
  .s-done, .s-active { background: #0f3d1f; color: #56d364; }
  .s-dropped, .s-archived, .s-paused { background: #21262d; color: #8d96a0; }
}
`;

function renderSummary(counts: Record<string, number>): string {
  const order = ["open", "in-progress", "blocked", "done", "dropped"];
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

function repoShort(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (m) return m[1];
  const ssh = url.match(/^[^:]+:([^/]+\/[^/.]+)/);
  if (ssh) return ssh[1];
  return url.length > 40 ? url.slice(0, 37) + "…" : url;
}

function prShort(url: string): string {
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
    const activeTasks = p.tasks.filter(t => !t.archived);
    const archivedCount = p.tasks.length - activeTasks.length;
    s += `## ${str(p.data.name) ?? p.slug} (\`${p.slug}\`) — ${str(p.data.status) ?? "?"}\n\n`;
    if (archivedCount) s += `_${archivedCount} archived._\n\n`;
    if (activeTasks.length === 0) { s += "_No active tasks._\n\n"; continue; }
    s += "| Task | Status | Type | PRs |\n|---|---|---|---|\n";
    for (const t of activeTasks) {
      const prs = (Array.isArray(t.data.prs) ? t.data.prs : []).join(", ");
      s += `| ${str(t.data.title) ?? t.slug} | ${str(t.data.status) ?? "?"} | ${str(t.data.type) ?? "?"} | ${prs} |\n`;
    }
    s += "\n";
  }
  return s;
}
