import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  allRunLogs,
  compactUtc,
  formatRunLogHeader,
  isLegacyRunLogName,
  isValidRunLogName,
  latestRunLog,
  newRunLogName,
  newRunLogPath,
  parseLine,
  parseEvents,
  parseRunLog,
  parseRunLogHeader,
  prepareRunLogPath,
  taskRunsDir,
} from "./run_log.ts";
import type { Task } from "../tree.ts";

function topLevelFileForm(root: string, slug: string): Task {
  const path = join(root, `${slug}.md`);
  writeFileSync(path, "---\nstatus: ready\n---\n");
  return { slug, path, archived: false, data: { slug, status: "ready" }, body: "" };
}

function topLevelFolderForm(root: string, slug: string): Task {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "task.md");
  writeFileSync(path, "---\nstatus: ready\n---\n");
  return { slug, path, dir, archived: false, data: { slug, status: "ready" }, body: "" };
}

function childOfFolderForm(root: string, parentSlug: string, slug: string): Task {
  const parentDir = join(root, parentSlug);
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(parentDir, "task.md"), "---\nstatus: ready\n---\n");
  const path = join(parentDir, `${slug}.md`);
  writeFileSync(path, `---\nstatus: ready\nparent: ${parentSlug}\n---\n`);
  return { slug, path, archived: false, parent: parentSlug, data: { slug, status: "ready", parent: parentSlug }, body: "" };
}

test("compactUtc: ISO timestamp collapses to YYYYMMDDTHHMMSSZ", () => {
  const d = new Date("2026-05-15T23:05:44.123Z");
  assert.equal(compactUtc(d), "20260515T230544Z");
});

test("taskRunsDir: top-level folder-form points at <task-dir>/runs/", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    assert.equal(taskRunsDir(t), join(root, "001-foo", "runs"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("taskRunsDir: top-level file-form points at the to-be-folded folder's runs/", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFileForm(root, "001-foo");
    assert.equal(taskRunsDir(t), join(root, "001-foo", "runs"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("taskRunsDir: child task points at the parent's runs/", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = childOfFolderForm(root, "001-parent", "002-child");
    assert.equal(taskRunsDir(t), join(root, "001-parent", "runs"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("newRunLogName: top-level uses bare <utc>.log (folder disambiguates)", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    const d = new Date("2026-05-15T23:05:44Z");
    assert.equal(newRunLogName(t, d), "20260515T230544Z.log");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("newRunLogName: child carries <child-slug>-- prefix (siblings share parent's runs/)", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = childOfFolderForm(root, "001-parent", "002-child");
    const d = new Date("2026-05-15T23:05:44Z");
    assert.equal(newRunLogName(t, d), "002-child--20260515T230544Z.log");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("newRunLogPath: composes dir + filename", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    const d = new Date("2026-05-15T23:05:44Z");
    assert.equal(newRunLogPath(t, d), join(root, "001-foo", "runs", "20260515T230544Z.log"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepareRunLogPath: folder-form top-level mkdir's runs/ and returns the new path", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    const d = new Date("2026-05-15T23:05:44Z");
    const { logFile, taskPath } = prepareRunLogPath(t, d);
    assert.equal(logFile, join(root, "001-foo", "runs", "20260515T230544Z.log"));
    assert.equal(taskPath, t.path); // unchanged
    assert.ok(statSync(join(root, "001-foo", "runs")).isDirectory());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepareRunLogPath: file-form top-level auto-folds before resolving the path", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFileForm(root, "001-foo");
    assert.ok(existsSync(t.path), "precondition: file-form task exists at <slug>.md");
    const d = new Date("2026-05-15T23:05:44Z");
    const { logFile, taskPath } = prepareRunLogPath(t, d);
    // File got renamed into the folder.
    assert.ok(!existsSync(join(root, "001-foo.md")));
    assert.equal(taskPath, join(root, "001-foo", "task.md"));
    assert.equal(logFile, join(root, "001-foo", "runs", "20260515T230544Z.log"));
    assert.ok(statSync(join(root, "001-foo", "runs")).isDirectory());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepareRunLogPath: child task passes through (parent already folder-form)", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = childOfFolderForm(root, "001-parent", "002-child");
    const d = new Date("2026-05-15T23:05:44Z");
    const { logFile, taskPath } = prepareRunLogPath(t, d);
    assert.equal(taskPath, t.path);
    assert.equal(logFile, join(root, "001-parent", "runs", "002-child--20260515T230544Z.log"));
    assert.ok(statSync(join(root, "001-parent", "runs")).isDirectory());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isValidRunLogName: top-level accepts <utc>.log only", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    assert.equal(isValidRunLogName("20260515T230544Z.log", t), true);
    // Slug-prefixed name doesn't belong in a top-level task's runs/ (would be
    // an artifact of the legacy flat layout that snuck in).
    assert.equal(isValidRunLogName("001-foo--20260515T230544Z.log", t), false);
    assert.equal(isValidRunLogName(".hidden.log", t), false);
    assert.equal(isValidRunLogName("../etc/passwd", t), false);
    assert.equal(isValidRunLogName("foo/bar.log", t), false);
    assert.equal(isValidRunLogName("20260515T230544Z.txt", t), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isValidRunLogName: child requires <child-slug>--<utc>.log", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = childOfFolderForm(root, "001-parent", "002-child");
    assert.equal(isValidRunLogName("002-child--20260515T230544Z.log", t), true);
    // A bare timestamp file in the parent's runs/ belongs to the parent (or
    // some other sibling), not to this child.
    assert.equal(isValidRunLogName("20260515T230544Z.log", t), false);
    // A different sibling's file also doesn't belong to this child.
    assert.equal(isValidRunLogName("003-other--20260515T230544Z.log", t), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allRunLogs: returns [] when the runs dir is missing", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    assert.deepEqual(allRunLogs(t), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allRunLogs: lists all runs for a top-level task newest-first", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    const runsDir = join(root, "001-foo", "runs");
    mkdirSync(runsDir);
    writeFileSync(join(runsDir, "20260101T000000Z.log"), "old");
    writeFileSync(join(runsDir, "20260515T120000Z.log"), "mid");
    writeFileSync(join(runsDir, "20260601T080000Z.log"), "new");
    const all = allRunLogs(t);
    assert.equal(all.length, 3);
    assert.match(all[0], /20260601T080000Z\.log$/);
    assert.match(all[1], /20260515T120000Z\.log$/);
    assert.match(all[2], /20260101T000000Z\.log$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allRunLogs: child task filters parent's runs/ by <child-slug>-- prefix", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const child = childOfFolderForm(root, "001-parent", "002-child");
    const runsDir = join(root, "001-parent", "runs");
    mkdirSync(runsDir);
    writeFileSync(join(runsDir, "002-child--20260101T000000Z.log"), "mine-old");
    writeFileSync(join(runsDir, "002-child--20260601T080000Z.log"), "mine-new");
    // Sibling and parent files share the dir; this child shouldn't see them.
    writeFileSync(join(runsDir, "003-other--20260515T120000Z.log"), "sibling");
    writeFileSync(join(runsDir, "20260515T120000Z.log"), "parent");
    const all = allRunLogs(child);
    assert.equal(all.length, 2);
    assert.match(all[0], /002-child--20260601T080000Z\.log$/);
    assert.match(all[1], /002-child--20260101T000000Z\.log$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("latestRunLog: picks newest by lexicographic filename order", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    const runsDir = join(root, "001-foo", "runs");
    mkdirSync(runsDir);
    writeFileSync(join(runsDir, "20260101T000000Z.log"), "old");
    writeFileSync(join(runsDir, "20260601T080000Z.log"), "new");
    const p = latestRunLog(t);
    assert.ok(p);
    assert.match(p!, /20260601T080000Z\.log$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("latestRunLog: returns null when no runs", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tpm-runs-"));
  try {
    const t = topLevelFolderForm(root, "001-foo");
    assert.equal(latestRunLog(t), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isLegacyRunLogName: matches the pre-095 flat-dir filename shape", () => {
  assert.equal(isLegacyRunLogName("tpm-057-foo--20260515T230544Z.log"), true);
  assert.equal(isLegacyRunLogName("alpha-001--20260101T000000Z.log"), true);
  assert.equal(isLegacyRunLogName("20260515T230544Z.log"), false); // new shape
  assert.equal(isLegacyRunLogName("../etc/passwd"), false);
  assert.equal(isLegacyRunLogName(".hidden.log"), false);
});

test("parseLine: empty / whitespace lines yield no events", () => {
  assert.deepEqual(parseLine(""), []);
  assert.deepEqual(parseLine("   "), []);
});

test("parseLine: non-JSON degrades to a raw event (so the panel still shows it)", () => {
  const events = parseLine("not json at all");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "raw");
});

test("parseLine: system init carries subtype + model", () => {
  const events = parseLine(JSON.stringify({
    type: "system", subtype: "init", model: "claude-opus-4-7",
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "system");
  if (events[0].kind === "system") {
    assert.equal(events[0].subtype, "init");
    assert.equal(events[0].model, "claude-opus-4-7");
  }
});

test("parseLine: assistant text content yields a text event", () => {
  const events = parseLine(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello there" }] },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "text");
  if (events[0].kind === "text") {
    assert.equal(events[0].text, "hello there");
  }
});

test("parseLine: assistant tool_use yields tool_use event with input preview", () => {
  const events = parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "abc", name: "Read", input: { file_path: "/x/y.ts" } }],
    },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_use");
  if (events[0].kind === "tool_use") {
    assert.equal(events[0].name, "Read");
    assert.match(events[0].inputPreview, /\/x\/y\.ts/);
  }
});

test("parseLine: assistant content can mix text and tool_use; both surface in order", () => {
  const events = parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reading file..." },
        { type: "tool_use", id: "abc", name: "Read", input: { file_path: "/x" } },
      ],
    },
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "text");
  assert.equal(events[1].kind, "tool_use");
});

test("parseLine: user tool_result yields tool_result event", () => {
  const events = parseLine(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "abc", content: "file contents here" }],
    },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_result");
  if (events[0].kind === "tool_result") {
    assert.equal(events[0].preview, "file contents here");
    assert.equal(events[0].isError, false);
  }
});

test("parseLine: user prompt (string content) is silently skipped", () => {
  // The first message is the `/tpm <slug>` prompt — noise in the panel.
  const events = parseLine(JSON.stringify({
    type: "user",
    message: { role: "user", content: "/tpm tpm/057-foo" },
  }));
  assert.deepEqual(events, []);
});

test("parseLine: tool_result with structured content extracts text parts", () => {
  const events = parseLine(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      }],
    },
  }));
  assert.equal(events.length, 1);
  if (events[0].kind === "tool_result") {
    assert.match(events[0].preview, /line 1 line 2/);
  }
});

test("parseLine: tool_result with is_error: true sets isError", () => {
  const events = parseLine(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "oops", is_error: true }],
    },
  }));
  assert.equal(events.length, 1);
  if (events[0].kind === "tool_result") {
    assert.equal(events[0].isError, true);
  }
});

test("parseLine: result event preserves subtype + cost + duration", () => {
  const events = parseLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done.",
    duration_ms: 12_345,
    total_cost_usd: 0.42,
  }));
  assert.equal(events.length, 1);
  if (events[0].kind === "result") {
    assert.equal(events[0].subtype, "success");
    assert.equal(events[0].preview, "done.");
    assert.equal(events[0].durationMs, 12_345);
    assert.equal(events[0].totalCostUsd, 0.42);
    assert.equal(events[0].isError, false);
  }
});

test("parseLine: unknown event types yield no events (don't pollute the panel)", () => {
  const events = parseLine(JSON.stringify({ type: "weather_report", forecast: "rain" }));
  assert.deepEqual(events, []);
});

test("parseLine: long input previews are truncated", () => {
  const longInput = "x".repeat(500);
  const events = parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: longInput } }],
    },
  }));
  if (events[0].kind === "tool_use") {
    assert.ok(events[0].inputPreview.length <= 100);
    assert.ok(events[0].inputPreview.endsWith("…"));
  }
});

test("parseEvents: parses an NDJSON buffer into a flat stream", () => {
  const buf = [
    JSON.stringify({ type: "system", subtype: "init", model: "x" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
  ].join("\n");
  const events = parseEvents(buf);
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "system");
  assert.equal(events[1].kind, "text");
  assert.equal(events[2].kind, "result");
});

test("parseEvents: tolerates blank lines and trailing newline", () => {
  const buf = `\n${JSON.stringify({ type: "system", subtype: "init" })}\n\n`;
  const events = parseEvents(buf);
  assert.equal(events.length, 1);
});

// ---- concatenated / NDJSON edge cases -------------------------------------
//
// The capture path under `~/.tpm/runs/` doesn't always land each stream-json
// event on its own line. Observed shapes from claude's tee:
//   - Two objects on one line:  `{...}{...}`
//   - The whole transcript on one line, no newlines at all.
// The parser walks brace depth so each top-level `{...}` becomes its own event.

test("parseLine: two concatenated objects on one line yield two events", () => {
  const a = JSON.stringify({ type: "system", subtype: "init", model: "x" });
  const b = JSON.stringify({ type: "result", subtype: "success", result: "ok" });
  const events = parseLine(a + b);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "system");
  assert.equal(events[1].kind, "result");
});

test("parseLine: N concatenated objects on one line all parse", () => {
  const objs = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "a" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "b" }] } },
    { type: "result", subtype: "success", result: "ok" },
  ].map(o => JSON.stringify(o)).join("");
  const events = parseLine(objs);
  // system + 2 text + result = 4
  assert.equal(events.length, 4);
  assert.equal(events[0].kind, "system");
  assert.equal(events[3].kind, "result");
});

test("parseLine: string containing literal '}{' inside a value is not split", () => {
  // A JSON value with `}{` inside its string must round-trip as a single object.
  const obj = { type: "assistant", message: { content: [{ type: "text", text: "weird }{ braces" }] } };
  const events = parseLine(JSON.stringify(obj));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "text");
  if (events[0].kind === "text") assert.equal(events[0].text, "weird }{ braces");
});

test("parseLine: string containing escaped quotes does not desync the walker", () => {
  // `"\"close\""` inside a text value used to be a trap for the string-state machine.
  const obj = { type: "assistant", message: { content: [{ type: "text", text: 'has \\"escaped\\" quotes' }] } };
  // Hand-crafted to ensure the `\"` ends up in the wire form.
  const wire = JSON.stringify(obj);
  const events = parseLine(wire + wire);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "text");
  assert.equal(events[1].kind, "text");
});

test("parseEvents: mixed NDJSON lines (some single, some concatenated) all parse", () => {
  const single = JSON.stringify({ type: "system", subtype: "init" });
  const a = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "one" }] } });
  const b = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "two" }] } });
  const buf = `${single}\n${a}${b}\n${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}`;
  const events = parseEvents(buf);
  assert.equal(events.length, 4);
  assert.equal(events[0].kind, "system");
  assert.equal(events[1].kind, "text");
  assert.equal(events[2].kind, "text");
  assert.equal(events[3].kind, "result");
});

test("parseEvents: whole transcript on one line (no newlines) still splits", () => {
  // The shape that triggered task 074: claude's tee landed every event back-to-back.
  const objs = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "result", subtype: "success", result: "done" },
  ].map(o => JSON.stringify(o)).join("");
  const events = parseEvents(objs);
  assert.equal(events.length, 4);
});

test("parseRunLog: empty input yields zero events and zero counts", () => {
  const r = parseRunLog("");
  assert.deepEqual(r.events, []);
  assert.equal(r.parsed, 0);
  assert.equal(r.skipped, 0);
});

test("parseRunLog: clean NDJSON reports parsed count and no skipped", () => {
  const buf = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
  ].join("\n");
  const r = parseRunLog(buf);
  assert.equal(r.parsed, 2);
  assert.equal(r.skipped, 0);
  assert.equal(r.events.length, 2);
});

test("parseRunLog: malformed object on a line is counted as skipped; others still render", () => {
  // The middle slice has a stray colon inside that breaks JSON.parse, but the
  // outer braces match so the walker still emits it as a candidate.
  const good = JSON.stringify({ type: "system", subtype: "init" });
  const bad = '{"type":"assistant","message":{:::}}';
  const tail = JSON.stringify({ type: "result", subtype: "success", result: "ok" });
  const r = parseRunLog(good + bad + tail);
  assert.equal(r.parsed, 2);
  assert.equal(r.skipped, 1);
  // events: system + result (the bad one is skipped, not rendered as raw)
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].kind, "system");
  assert.equal(r.events[1].kind, "result");
});

test("parseRunLog: unclosed object at end of line is counted as skipped (truncated tail)", () => {
  const good = JSON.stringify({ type: "system", subtype: "init" });
  // Mid-write truncation: walker sees `{` but never the closing `}`.
  const truncated = '{"type":"result","subtype":"succ';
  const r = parseRunLog(good + truncated);
  assert.equal(r.parsed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "system");
});

// ---- header sniff + format dispatch (task 092) ----------------------------

test("formatRunLogHeader: emits the canonical `# tpm-run agent=… outputFormat=…\\n`", () => {
  assert.equal(
    formatRunLogHeader("claude", "claude-stream-json"),
    "# tpm-run agent=claude outputFormat=claude-stream-json\n",
  );
  assert.equal(
    formatRunLogHeader("copilot", "copilot-json"),
    "# tpm-run agent=copilot outputFormat=copilot-json\n",
  );
});

test("parseRunLogHeader: round-trips formatRunLogHeader output", () => {
  const line = "# tpm-run agent=copilot outputFormat=copilot-json";
  assert.deepEqual(parseRunLogHeader(line), {
    agent: "copilot",
    outputFormat: "copilot-json",
  });
});

test("parseRunLogHeader: ignores unknown outputFormat values (defensive)", () => {
  // A future agent's outputFormat shouldn't be parsed as a known one; the
  // viewer should fall back to its caller-provided default.
  const h = parseRunLogHeader("# tpm-run agent=cursor outputFormat=cursor-stream");
  assert.equal(h?.agent, "cursor");
  assert.equal(h?.outputFormat, undefined);
});

test("parseRunLogHeader: non-header line returns null", () => {
  assert.equal(parseRunLogHeader("{}"), null);
  assert.equal(parseRunLogHeader(""), null);
  assert.equal(parseRunLogHeader("# unrelated comment"), null);
});

test("parseRunLog: header on first line sets format and is not surfaced as an event", () => {
  const buf =
    "# tpm-run agent=claude outputFormat=claude-stream-json\n" +
    JSON.stringify({ type: "system", subtype: "init" }) + "\n";
  const r = parseRunLog(buf);
  assert.equal(r.format, "claude-stream-json");
  assert.equal(r.header?.agent, "claude");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "system");
});

test("parseRunLog: header outputFormat wins over caller-provided default", () => {
  // The orchestrator wrote the header; the viewer must dispatch on the
  // recorded format, not whatever the caller guessed.
  const buf =
    "# tpm-run agent=copilot outputFormat=copilot-json\n" +
    JSON.stringify({ role: "assistant", content: "hello" }) + "\n";
  const r = parseRunLog(buf, { format: "claude-stream-json" });
  assert.equal(r.format, "copilot-json");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "text");
  if (r.events[0].kind === "text") assert.match(r.events[0].text, /assistant: hello/);
});

test("parseRunLog: no header defaults to claude-stream-json (back-compat with pre-092 logs)", () => {
  const buf = JSON.stringify({ type: "system", subtype: "init", model: "x" }) + "\n";
  const r = parseRunLog(buf);
  assert.equal(r.format, "claude-stream-json");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "system");
});

test("parseRunLog: copilot-json route extracts role + content from a chat-style object", () => {
  const buf =
    "# tpm-run agent=copilot outputFormat=copilot-json\n" +
    JSON.stringify({ role: "assistant", content: "ran tests, all green" }) + "\n";
  const r = parseRunLog(buf);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "text");
  if (r.events[0].kind === "text") {
    assert.match(r.events[0].text, /assistant: ran tests, all green/);
  }
});

test("parseRunLog: copilot-json route extracts text from typed content array", () => {
  // Anthropic-style block array — copilot may emit structured content too.
  const buf =
    "# tpm-run agent=copilot outputFormat=copilot-json\n" +
    JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }],
    }) + "\n";
  const r = parseRunLog(buf);
  assert.equal(r.events.length, 1);
  if (r.events[0].kind === "text") assert.match(r.events[0].text, /assistant: part one part two/);
});

test("parseRunLog: copilot-json route falls back to raw preview for unknown shapes", () => {
  // The minimal common renderer can't extract role+text from a wrapper-only
  // object — keep it visible as a raw JSON preview so a stuck copilot run
  // isn't a blank panel.
  const buf =
    "# tpm-run agent=copilot outputFormat=copilot-json\n" +
    JSON.stringify({ unfamiliar: "shape", with: 42 }) + "\n";
  const r = parseRunLog(buf);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "raw");
});

test("parseRunLog: text format treats each non-empty line as a raw event", () => {
  const buf =
    "# tpm-run agent=cursor outputFormat=text\n" +
    "line one\n" +
    "line two\n";
  // The header registers an unknown outputFormat; opts.format forces text.
  const r = parseRunLog(buf, { format: "text" });
  assert.equal(r.format, "text");
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].kind, "raw");
  assert.equal(r.events[1].kind, "raw");
});

test("parseLine: format param dispatches copilot vs claude on the same JSON", () => {
  // Same wire object, two interpreters: claude looks for `type:"assistant"`
  // (no match → empty); copilot pulls role+content into a text event. The
  // dispatch is the whole point of the format parameter.
  const obj = JSON.stringify({ role: "assistant", content: "hi" });
  const claude = parseLine(obj, "claude-stream-json");
  assert.equal(claude.length, 0);
  const copilot = parseLine(obj, "copilot-json");
  assert.equal(copilot.length, 1);
  assert.equal(copilot[0].kind, "text");
});
