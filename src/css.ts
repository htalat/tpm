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
.s-needs-close { background: #d9f7be; color: #2f6f1a; }
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
  .s-needs-close { background: #1d3a14; color: #7ee787; }
  .s-needs-review { background: #4d1535; color: #ff7eb6; }
  .s-blocked { background: #5d1a1a; color: #ff7b72; }
  .s-done, .s-active { background: #0f3d1f; color: #56d364; }
  .s-dropped, .s-archived, .s-paused { background: #21262d; color: #8d96a0; }
}
`;

// Layout/markdown styles only `tpm serve` uses (the static report doesn't
// render bodies and doesn't need the sidebar layout).
export const SERVE_CSS = `
header.site-header { margin: 0 0 1rem; padding: .4rem .75rem; border: 0; background: #f6f8fa; border-radius: 6px; }
header.site-header a.home { font-weight: 700; font-size: 1.05rem; letter-spacing: -.02em; color: #1f2328; }
header.site-header a.home:hover { color: #0969da; text-decoration: none; }
nav.crumbs { font-size: .9em; color: #57606a; margin-bottom: 1rem; }
nav.crumbs a + a::before { content: " \\203A "; color: #8d96a0; padding: 0 .25rem; }
nav.project-chips { display: flex; gap: .4rem; flex-wrap: wrap; margin-bottom: 1rem; padding-bottom: .75rem; border-bottom: 1px solid #eaeef2; }
.chip { display: inline-block; padding: .2rem .65rem; border-radius: 999px; background: #f6f8fa; color: #0969da; font-size: .85em; border: 1px solid #d0d7de; }
.chip:hover { background: #eaeef2; text-decoration: none; }
.chip.active { background: #0969da; color: #fff; border-color: #0969da; cursor: default; }
.archive-toggle { margin: .5rem 0 0; font-size: .85em; }
.archive-toggle a { color: #57606a; }
.queue { margin-bottom: 1.5rem; }
.queue h2 { font-size: 1.05rem; margin-top: 1rem; padding-bottom: .2rem; }
.queue-empty { color: #8d96a0; font-size: .9em; padding: .35rem 0; }
.task-row { display: flex; gap: .75rem; align-items: center; padding: .35rem 0; border-bottom: 1px solid #eaeef2; }
.task-row:hover { background: #f6f8fa; }
.task-row .badge { min-width: 6.5em; text-align: center; }
.task-row .when { color: #57606a; font-size: .85em; margin-left: auto; }
.task-row a.title { font-weight: 500; }
.task-row .title-cell { display: inline-flex; align-items: baseline; min-width: 0; }
.task-row .parent-crumb { color: #8d96a0; font-size: .85em; font-weight: 400; white-space: nowrap; }
.task-row .parent-crumb::after { content: " \\203A "; color: #8d96a0; padding: 0 .35rem; }
.task-row .slug { color: #8d96a0; font-size: .85em; }
.task-row.archived { opacity: .65; }
.task-row.archived a.title { font-weight: 400; }
.archived-tag { font-size: .7em; text-transform: uppercase; letter-spacing: .04em; color: #8d96a0; padding: 1px 6px; border-radius: 4px; background: #eaeef2; }
body { max-width: 1600px; }
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr) 260px; gap: 1.5rem; align-items: start; }
.layout.no-rail { grid-template-columns: 220px minmax(0, 1fr); }
.task-rail { position: sticky; top: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.task-rail section { margin: 0; padding-top: 0; border-top: 0; }
.task-log-link { padding: .5rem .85rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; font-size: .9em; }
.task-log-link a { text-decoration: none; }
.task-runs-link { padding: .5rem .85rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; font-size: .9em; }
.task-runs-link a { text-decoration: none; }
.task-runs-list { margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #d0d7de; }
.task-runs-list h2 { font-size: 1.05rem; margin-top: 0; padding-bottom: .2rem; border: 0; }
.run-list { list-style: none; padding: 0; margin: .5rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85em; line-height: 1.6; }
.run-list li { padding: .15rem 0; border-top: 1px solid #eaeef2; display: flex; gap: .75rem; align-items: baseline; }
.run-list li:first-child { border-top: 0; }
.run-list-ts { color: #8d96a0; font-size: .9em; }
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
  header.site-header { background: #161b22; }
  header.site-header a.home { color: #e6edf3; }
  nav.project-chips { border-color: #21262d; }
  .chip { background: #161b22; border-color: #30363d; color: #79c0ff; }
  .chip:hover { background: #21262d; }
  .chip.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .archive-toggle a { color: #8d96a0; }
  .archived-tag { background: #21262d; color: #8d96a0; }
  .task-row { border-color: #21262d; }
  .task-row:hover { background: #161b22; }
  .sidebar dt { color: #8d96a0; }
  .body pre { background: #161b22; }
  .task-log-link { background: #161b22; border-color: #30363d; }
  .task-runs-link { background: #161b22; border-color: #30363d; }
  .task-runs-list { border-color: #30363d; }
  .run-list li { border-color: #21262d; }
  .run-list-ts { color: #8d96a0; }
}
.flash { margin: 0 0 1rem; padding: .55rem .85rem; border-radius: 6px; background: #fff8c5; border: 1px solid #d4a72c; color: #57606a; font-size: .9em; display: flex; gap: .75rem; align-items: center; justify-content: space-between; }
.flash a.flash-dismiss { color: #57606a; font-size: .8em; }
.task-actions { margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #d0d7de; }
.task-actions h2 { font-size: 1.05rem; margin-top: 0; padding-bottom: .2rem; border: 0; }
.task-actions.disabled p.meta { font-style: italic; }
.action-form { display: flex; flex-direction: column; gap: .35rem; margin: .75rem 0; padding: .75rem .9rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; }
.action-form label { display: flex; flex-direction: column; gap: .25rem; font-size: .85em; color: #57606a; }
.action-form textarea, .action-form input[type="text"], .action-form input[type="url"] { width: 100%; padding: .35rem .5rem; border: 1px solid #d0d7de; border-radius: 4px; font: inherit; background: #fff; color: inherit; }
.action-form button { align-self: flex-start; padding: .35rem .85rem; background: #0969da; color: #fff; border: 1px solid #0969da; border-radius: 6px; cursor: pointer; font: inherit; }
.action-form button:hover { background: #0860c4; }
@media (prefers-color-scheme: dark) {
  .flash { background: #4d3a00; border-color: #9a6700; color: #e6edf3; }
  .flash a.flash-dismiss { color: #8d96a0; }
  .task-actions { border-color: #30363d; }
  .action-form { background: #161b22; border-color: #30363d; }
  .action-form textarea, .action-form input[type="text"], .action-form input[type="url"] { background: #0d1117; border-color: #30363d; color: #e6edf3; }
  .action-form button { background: #1f6feb; border-color: #1f6feb; }
  .action-form button:hover { background: #388bfd; }
}
.report-actions-bar { position: sticky; top: 0; z-index: 10; display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-start; margin: 0 0 1rem; padding: .6rem .85rem; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; box-shadow: 0 2px 6px rgba(31, 35, 40, .06); }
.report-actions-bar .action-form { margin: 0; padding: .35rem .55rem; flex: 0 1 auto; min-width: 0; }
.report-actions-bar .action-form button { white-space: nowrap; }
@media (prefers-color-scheme: dark) {
  .report-actions-bar { background: #0d1117; border-color: #30363d; box-shadow: 0 2px 6px rgba(0, 0, 0, .35); }
}
.pr-panel { margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #d0d7de; }
.pr-panel h2 { font-size: 1.05rem; margin-top: 0; padding-bottom: .2rem; border: 0; }
.pr-card { margin: .75rem 0; padding: .7rem .9rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; }
.pr-card-empty .pr-headline a:first-child { color: #57606a; }
.pr-headline { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
.pr-headline a:first-child { font-weight: 600; }
.pr-title { color: #57606a; }
.pr-open { font-size: .85em; margin-left: auto; white-space: nowrap; }
.pr-badges { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: .55rem; }
.pr-badge { display: inline-flex; gap: .35rem; align-items: center; }
.pr-badge-label { color: #57606a; font-size: .7em; text-transform: uppercase; letter-spacing: .05em; }
.pr-fetched, .pr-nodata { color: #8d96a0; font-size: .8em; margin: .55rem 0 0; }
.pr-chip { font-size: .68em; padding: 1px 7px; }
a.pr-chip:hover { text-decoration: none; opacity: .8; }
.report-chip { font-size: .68em; padding: 1px 7px; }
a.report-chip:hover { text-decoration: none; opacity: .8; }
.artifact-filter { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .75rem; }
.artifact-row { display: flex; gap: .75rem; align-items: center; padding: .35rem 0; border-bottom: 1px solid #eaeef2; }
.artifact-row:hover { background: #f6f8fa; }
.artifact-row .badge { min-width: 6.5em; text-align: center; }
.artifact-row a.title { font-weight: 500; }
.artifact-row .slug { color: #8d96a0; font-size: .85em; }
.artifact-row.archived { opacity: .65; }
.artifact-row.archived a.title { font-weight: 400; }
.artifact-chips { margin-left: auto; display: inline-flex; gap: .35rem; flex-wrap: wrap; }
@media (prefers-color-scheme: dark) {
  .artifact-row { border-color: #21262d; }
  .artifact-row:hover { background: #161b22; }
}
@media (prefers-color-scheme: dark) {
  .pr-panel { border-color: #30363d; }
  .pr-card { background: #161b22; border-color: #30363d; }
  .pr-card-empty .pr-headline a:first-child { color: #8d96a0; }
  .pr-title { color: #8d96a0; }
  .pr-badge-label { color: #8d96a0; }
}
.run-panel { margin-top: 2rem; padding-top: 1rem; border-top: 2px solid #d0d7de; }
.run-panel h2 { font-size: 1.05rem; margin-top: 0; padding-bottom: .2rem; border: 0; }
.run-panel h2 .meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .7em; color: #8d96a0; }
.run-empty { color: #8d96a0; font-size: .9em; margin: .5rem 0; font-style: italic; }
.run-meta { color: #8d96a0; font-size: .8em; margin: .55rem 0 0; }
.run-warning { color: #9a6700; background: #fff8c5; border: 1px solid #eac54f; border-radius: 4px; padding: .3rem .55rem; font-size: .82em; margin: .55rem 0; }
.run-events { list-style: none; padding: 0; margin: .5rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82em; line-height: 1.45; }
.run-events .ev { display: flex; gap: .65rem; padding: .15rem 0; border-top: 1px solid #f0f3f6; }
.run-events .ev:first-child { border-top: 0; }
.run-events .ev-tag { flex: 0 0 auto; min-width: 9.5em; color: #57606a; font-weight: 500; }
.run-events .ev-body { flex: 1 1 auto; color: #1f2328; word-break: break-word; }
.run-events .ev-system .ev-tag { color: #8d96a0; }
.run-events .ev-tool .ev-tag { color: #0969da; }
.run-events .ev-result .ev-tag { color: #1a7f37; }
.run-events .ev-final { border-top: 2px solid #d0d7de; margin-top: .35rem; padding-top: .35rem; }
.run-events .ev-final .ev-tag { color: #1a7f37; }
.run-events .ev-error .ev-tag { color: #cf222e; }
.run-events .ev-raw .ev-tag { color: #8d96a0; }
@media (prefers-color-scheme: dark) {
  .run-panel { border-color: #30363d; }
  .run-events .ev { border-color: #21262d; }
  .run-events .ev-final { border-top-color: #30363d; }
  .run-events .ev-body { color: #e6edf3; }
  .run-events .ev-tag { color: #8d96a0; }
  .run-events .ev-tool .ev-tag { color: #79c0ff; }
  .run-events .ev-result .ev-tag { color: #56d364; }
  .run-events .ev-final .ev-tag { color: #56d364; }
  .run-events .ev-error .ev-tag { color: #ff7b72; }
  .run-warning { color: #d4a72c; background: #1f1e16; border-color: #5c4a1a; }
}
@media (max-width: 900px) {
  .layout, .layout.no-rail { grid-template-columns: 1fr; }
  .task-rail { position: static; }
  .run-events .ev { flex-direction: column; gap: .15rem; }
  .run-events .ev-tag { min-width: 0; }
}
.chip-config { font-style: italic; }
.chip-logs { font-style: italic; }
.log-panel { margin-bottom: 2rem; padding: .75rem .9rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; }
.log-panel h2 { font-size: 1rem; margin: 0 0 .25rem; padding: 0; border: 0; }
.log-panel h2 .meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .7em; font-weight: 400; color: #8d96a0; word-break: break-all; }
.log-meta { color: #8d96a0; font-size: .8em; margin: .15rem 0 .5rem; }
.log-empty { color: #8d96a0; font-size: .9em; font-style: italic; margin: .35rem 0; }
.log-lines { list-style: none; padding: 0; margin: .5rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8em; line-height: 1.45; }
.log-line { display: flex; gap: .65rem; padding: .1rem 0; border-top: 1px solid #eaeef2; align-items: baseline; }
.log-line:first-child { border-top: 0; }
.log-ts { flex: 0 0 auto; color: #8d96a0; min-width: 13em; }
.log-line .log-level { flex: 0 0 auto; display: inline-block; min-width: 3.5em; text-align: center; padding: 0 6px; border-radius: 3px; font-size: .85em; font-weight: 600; }
.log-script { flex: 0 0 auto; color: #57606a; min-width: 10em; }
.log-msg { flex: 1 1 auto; color: #1f2328; word-break: break-word; white-space: pre-wrap; }
.log-raw { flex: 1 1 auto; color: #57606a; white-space: pre-wrap; word-break: break-word; }
.log-line-raw { padding-left: 13.5em; }
.log-level-info { background: #dafbe1; color: #1a7f37; }
.log-level-warn { background: #fff8c5; color: #9a6700; }
.log-level-error { background: #ffebe9; color: #cf222e; }
.log-source-task-log { font-style: italic; color: #57606a; }
.log-line-task-log .log-msg { color: #57606a; }
.log-cards { display: grid; gap: 1rem; margin: 1rem 0 1.5rem; }
.log-card { margin: 0; padding: .75rem .9rem; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; }
.log-card h2 { margin: 0 0 .25rem; padding: 0; border: 0; font-size: 1rem; }
.log-card-last { margin: .35rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .8em; color: #1f2328; word-break: break-word; }
.log-card-empty .log-card-last { color: #8d96a0; }
@media (prefers-color-scheme: dark) {
  .log-panel { background: #161b22; border-color: #30363d; }
  .log-line { border-color: #21262d; }
  .log-msg { color: #e6edf3; }
  .log-ts, .log-script, .log-raw { color: #8d96a0; }
  .log-level-info { background: #0f3d1f; color: #56d364; }
  .log-level-warn { background: #4d3a00; color: #e3b341; }
  .log-level-error { background: #5d1a1a; color: #ff7b72; }
  .log-source-task-log { color: #8d96a0; }
  .log-line-task-log .log-msg { color: #b6becc; }
  .log-card { background: #161b22; border-color: #30363d; }
  .log-card-last { color: #e6edf3; }
}
@media (max-width: 900px) {
  .log-line { flex-direction: column; gap: .1rem; }
  .log-ts, .log-script, .log-line .log-level { min-width: 0; }
  .log-line-raw { padding-left: 0; }
}
.config-section { margin-bottom: 2rem; }
.config-section h2 { font-size: 1.15rem; }
.config-interp { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: .75rem 0; font-size: .9em; }
.config-interp dt { color: #57606a; font-weight: 600; font-size: .85em; text-transform: uppercase; letter-spacing: .04em; }
.config-interp dd { margin: 0; }
.config-default { color: #8d96a0; font-size: .85em; }
.config-comment { color: #8d96a0; font-style: italic; }
.config-empty, .config-missing { color: #8d96a0; font-size: .9em; font-style: italic; margin: .5rem 0; }
.config-json { background: #f6f8fa; padding: .75rem; border-radius: 6px; overflow-x: auto; font-size: .85em; line-height: 1.4; margin: .75rem 0; }
.config-json code { background: none; padding: 0; }
.config-error { padding: .65rem .85rem; border-radius: 6px; background: #ffebe9; border: 1px solid #f1aeb5; color: #82071e; margin: .75rem 0; }
.config-error pre { background: rgba(255, 255, 255, .5); padding: .4rem .6rem; border-radius: 4px; margin: .35rem 0; overflow-x: auto; font-size: .85em; }
.config-error code { background: none; padding: 0; }
.config-raw summary { cursor: pointer; color: #82071e; font-size: .85em; }
@media (prefers-color-scheme: dark) {
  .config-default, .config-comment, .config-empty, .config-missing { color: #8d96a0; }
  .config-json { background: #161b22; }
  .config-error { background: #5d1a1a; border-color: #cf222e; color: #ffdcd7; }
  .config-error pre { background: rgba(0, 0, 0, .3); }
  .config-raw summary { color: #ffdcd7; }
}
`;
