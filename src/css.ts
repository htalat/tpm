// Shared CSS for tpm's HTML surfaces (`tpm report`, `tpm serve`).
// One stylesheet so the static rollup and the live dashboard look like the
// same product. Status badge colors follow the canonical status enum.
//
// Additional rules specific to the live server (sidebar layout, queue boxes,
// markdown body styling) layer on top via `EXTRA_SERVE_CSS` below.

export const BASE_CSS = `
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
.s-ready { background: #ddf0ff; color: #6639ba; }
.s-in-progress { background: #fff8c5; color: #9a6700; }
.s-needs-feedback { background: #ffe7d6; color: #b75500; }
.s-needs-review { background: #ffe6f0; color: #b03060; }
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
.indent { color: #8d96a0; margin-right: .25rem; }
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
  .s-ready { background: #2e1a5e; color: #b392f0; }
  .s-in-progress { background: #4d3a00; color: #e3b341; }
  .s-needs-feedback { background: #4d2a00; color: #ffa657; }
  .s-needs-review { background: #4d1535; color: #ff7eb6; }
  .s-blocked { background: #5d1a1a; color: #ff7b72; }
  .s-done, .s-active { background: #0f3d1f; color: #56d364; }
  .s-dropped, .s-archived, .s-paused { background: #21262d; color: #8d96a0; }
}
`;

// Layout/markdown styles only `tpm serve` uses (the static report doesn't
// render bodies and doesn't need the sidebar layout).
export const SERVE_CSS = `
nav.crumbs { font-size: .9em; color: #57606a; margin-bottom: 1rem; }
nav.crumbs a + a::before { content: " / "; color: #8d96a0; padding: 0 .25rem; }
.queue { margin-bottom: 1.5rem; }
.queue h2 { font-size: 1.05rem; margin-top: 1rem; padding-bottom: .2rem; }
.queue-empty { color: #8d96a0; font-size: .9em; padding: .35rem 0; }
.task-row { display: flex; gap: .75rem; align-items: center; padding: .35rem 0; border-bottom: 1px solid #eaeef2; }
.task-row:hover { background: #f6f8fa; }
.task-row .badge { min-width: 6.5em; text-align: center; }
.task-row .when { color: #57606a; font-size: .85em; margin-left: auto; }
.task-row a.title { font-weight: 500; }
.task-row .slug { color: #8d96a0; font-size: .85em; }
.layout { display: grid; grid-template-columns: 220px 1fr; gap: 1.5rem; align-items: start; }
.sidebar { font-size: .9em; }
.sidebar dt { color: #57606a; font-weight: 600; font-size: .75em; text-transform: uppercase; letter-spacing: .04em; margin-top: .8rem; }
.sidebar dd { margin: .15rem 0 0; }
.sidebar ul { padding-left: 1.1rem; margin: .25rem 0; }
.body { font-size: .95em; line-height: 1.6; }
.body h2 { font-size: 1.1rem; border: 0; margin-top: 1.5rem; }
.body h3 { font-size: 1rem; }
.body pre { background: #f6f8fa; padding: .75rem; border-radius: 6px; overflow-x: auto; font-size: .85em; line-height: 1.4; }
.body pre code { background: none; padding: 0; }
.body ul, .body ol { padding-left: 1.4rem; }
@media (prefers-color-scheme: dark) {
  .task-row { border-color: #21262d; }
  .task-row:hover { background: #161b22; }
  .sidebar dt { color: #8d96a0; }
  .body pre { background: #161b22; }
}
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
}
`;
