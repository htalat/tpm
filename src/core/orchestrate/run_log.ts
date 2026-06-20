import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR } from "../config.ts";
import { foldTask } from "../tree.ts";
import type { Task } from "../tree.ts";
import type { AgentOutputFormat } from "../agent_cli.ts";

// Per-run logs live alongside the task they describe: top-level tasks get
// their own `runs/` subfolder inside the task's folder; child tasks share the
// parent's `runs/` and disambiguate via a `<child-slug>--` filename prefix
// (children don't have own folders post-094). `tpm archive` already moves the
// whole task folder, so per-run captures travel with the task automatically.
//
// Layouts:
//   <project>/tasks/<slug>/runs/<utc>.log                          — top-level
//   <project>/tasks/<parent>/runs/<child-slug>--<utc>.log          — child of folder-form parent
//
// File naming:
//   utc-iso-compact: `YYYYMMDDTHHMMSSZ`. Sorts lexicographically by time, so
//     a `readdir().sort().reverse()` gives newest-first without a stat call.
//   For children, the `<child-slug>--<utc>.log` shape lets siblings share the
//     parent's runs/ without collision while still being filterable by prefix.

// `2026-05-15T23:05:44.123Z` → `20260515T230544Z`.
export function compactUtc(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

// Where this task's run logs live on disk. For top-level tasks it's the
// task's own `runs/` subfolder (the task is folder-form, or will be after
// `prepareRunLogPath` auto-folds it); for child tasks it's the parent's
// `runs/`. The returned path may not exist yet — `prepareRunLogPath` is the
// only caller that mkdir's it.
export function taskRunsDir(task: Task): string {
  if (task.parent) {
    // Child of a folder-form parent: `<parent-dir>/<child-slug>.md` lives
    // here, so the parent dir is one up.
    return join(dirname(task.path), "runs");
  }
  if (task.dir) return join(task.dir, "runs");
  // File-form top-level: the to-be-folded folder. `prepareRunLogPath` folds
  // before writing; readers that hit this branch get an empty list (the
  // task has never been dispatched).
  return join(dirname(task.path), task.slug, "runs");
}

// Filename for the next run inside taskRunsDir(task). Top-level tasks get
// just the timestamp (their folder disambiguates); children carry their slug
// as a prefix so sibling children sharing the parent's runs/ don't collide.
export function newRunLogName(task: Task, when: Date = new Date()): string {
  const ts = compactUtc(when);
  return task.parent ? `${task.slug}--${ts}.log` : `${ts}.log`;
}

export function newRunLogPath(task: Task, when: Date = new Date()): string {
  return join(taskRunsDir(task), newRunLogName(task, when));
}

const TS_RE = /\d{8}T\d{6}Z\.log$/;

// Path-traversal guard for the per-task `/runs/<basename>` route. A valid
// name for a top-level task is `<utc>.log`; for a child task, it must be
// `<child-slug>--<utc>.log` (the on-disk filename pattern).
export function isValidRunLogName(name: string, task: Task): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\.log$/.test(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) return false;
  if (task.parent) {
    const expected = new RegExp(`^${escapeRegex(task.slug)}--\\d{8}T\\d{6}Z\\.log$`);
    return expected.test(name);
  }
  return /^\d{8}T\d{6}Z\.log$/.test(name);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All run logs for a task, newest-first. Returns absolute paths; callers can
// `basename()` for display. Empty array when the runs dir doesn't exist or
// the task has never been dispatched. For child tasks, filters the parent's
// runs/ to entries matching the `<child-slug>--` prefix.
export function allRunLogs(task: Task): string[] {
  const dir = taskRunsDir(task);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const matches = entries.filter(name => isValidRunLogName(name, task));
  matches.sort();
  matches.reverse();
  return matches.map(name => join(dir, name));
}

// Most recent run log for a task, or null if none exist.
export function latestRunLog(task: Task): string | null {
  const all = allRunLogs(task);
  return all.length ? all[0] : null;
}

// Session id of a task's most recent orchestrator run, or null when the task
// has never been dispatched or the capture never recorded one (e.g. a run that
// died before the agent emitted its `init` event, or an output format that
// doesn't carry a session id). Backs `tpm session <slug>` so a human can
// `claude --resume` the exact session the orchestrator spawned. Reads the
// newest run log only — older runs are reachable via their own log files.
export function latestSessionId(task: Task): string | null {
  const path = latestRunLog(task);
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseRunLog(text).sessionId ?? null;
}

// Pre-spawn: auto-fold file-form top-level tasks so the runs/ subfolder has
// a home, mkdir runs/, and return the new log path. Children pass through —
// their runs go in the parent's existing folder. Mutates disk (renames the
// task file when folding) but does not mutate the passed-in Task struct;
// caller should re-resolve via `findTask` if it needs a fresh view.
export interface PrepareRunLogResult {
  logFile: string;
  // Task path after the fold (or unchanged if the task was already
  // folder-form / child). Lets the caller update its in-memory Task if it
  // wants to without an extra tree walk.
  taskPath: string;
}
export function prepareRunLogPath(task: Task, when: Date = new Date()): PrepareRunLogResult {
  let taskPath = task.path;
  if (!task.parent && !task.dir) {
    // Legacy safety net: pre-folder-form-default top-level tasks are file-form;
    // fold so `<task-folder>/runs/` exists. No-op for new tasks (born folder-form).
    taskPath = foldTask(task);
  }
  const dir = taskRunsDir(task);
  mkdirSync(dir, { recursive: true });
  return { logFile: join(dir, newRunLogName(task, when)), taskPath };
}

// ---- legacy (~/.tpm/runs/) ------------------------------------------------
//
// The flat global runs dir has been retired. The helpers below exist solely
// so the serve layer can 302-redirect old `/runs/<file>` URLs.

export function legacyRunsDir(): string {
  return resolve(CONFIG_DIR, "runs");
}

// Old encoding used in flat-dir filenames: `/` → `-`. Lossy (a top-level
// slug containing a literal `-` can collide with a `parent/child` shape),
// which is why the new layout drops it.
export function encodeLegacySlug(slug: string): string {
  return slug.replace(/[\/\\]/g, "-");
}

// Validator for the legacy filename shape (`<encoded-slug>--<utc>.log`).
// Used by the migration walker and the old `/runs/<file>` redirect.
export function isLegacyRunLogName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*--\d{8}T\d{6}Z\.log$/i.test(name);
}

// ---- per-run log header ---------------------------------------------------
//
// When the orchestrator opens a per-run log it writes a metadata header line
// as the first line: `# tpm-run agent=<name> outputFormat=<format>`. The
// parser sniffs the header to pick the right interpreter; logs without a
// header (every run before task 092) default to claude-stream-json so
// existing transcripts keep rendering.

export interface RunLogHeader {
  agent?: string;
  outputFormat?: AgentOutputFormat;
}

const HEADER_RE = /^#\s*tpm-run\s+(.*)$/;

export function formatRunLogHeader(agent: string, outputFormat: AgentOutputFormat): string {
  return `# tpm-run agent=${agent} outputFormat=${outputFormat}\n`;
}

export function parseRunLogHeader(line: string): RunLogHeader | null {
  const m = line.match(HEADER_RE);
  if (!m) return null;
  const out: RunLogHeader = {};
  for (const part of m[1].split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "agent") out.agent = v;
    else if (k === "outputFormat") {
      if (v === "claude-stream-json" || v === "copilot-json" || v === "text") {
        out.outputFormat = v;
      }
    }
  }
  return out;
}

// ---- NDJSON event parsing -------------------------------------------------
//
// `claude -p --output-format stream-json --verbose` emits one JSON object per
// line. The shapes we care about:
//
//   {type:"system", subtype:"init", model, tools, ...}
//   {type:"assistant", message:{content:[{type:"text",text}|{type:"tool_use",name,input}]}}
//   {type:"user", message:{content:[{type:"tool_result",content,is_error?}]}}
//   {type:"result", subtype, is_error, result, duration_ms, total_cost_usd}
//
// Copilot (`copilot -p --output-format json`) emits a different NDJSON
// dialect — the generic interpreter below extracts role + text from common
// shapes (`{role, content}`, `{event, message}`) and falls back to a raw
// JSON preview so the panel still surfaces *something* when the schema is
// unknown. Per-agent richer rendering is a follow-up; the first cut keeps
// the dispatch wired without claiming knowledge of a wire schema we haven't
// pinned down yet.
//
// In practice the capture path (the tee under `~/.tpm/runs/`) doesn't always
// land each event on its own line — observed shapes include `{...}{...}` on
// the same line, and the whole transcript on one line with no `\n` at all.
// So the parser walks each input line with a brace-depth tokenizer and emits
// each top-level object independently. Anything we can't recognize we degrade
// to `raw` so the panel still shows *something* when the schema shifts.

export type RunEvent =
  | { kind: "system"; subtype: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; inputPreview: string }
  | { kind: "tool_result"; preview: string; isError: boolean }
  | { kind: "result"; subtype: string; isError: boolean; preview: string; durationMs?: number; totalCostUsd?: number }
  | { kind: "raw"; line: string };

export interface ParsedRunLog {
  events: RunEvent[];
  parsed: number;  // top-level JSON objects that parsed cleanly
  skipped: number; // brace-spans that didn't parse, or unclosed tails
  // Resolved format used to interpret events (header wins, then opts.format,
  // then the back-compat default of claude-stream-json).
  format: AgentOutputFormat;
  // Header metadata when present — useful to the viewer for surfacing the
  // agent name in the panel chrome ("Last run · copilot").
  header?: RunLogHeader;
  // The agent's coding-session id, lifted from the first event that carries a
  // top-level `session_id` (claude's `system/init` and `result` events both
  // do; copilot's NDJSON carries one too). Lets a human resume the exact
  // session the orchestrator spawned (`claude --resume <id>`). Undefined when
  // the capture never recorded one. Format-agnostic on purpose — it's a
  // top-level field across the dialects we've seen, so we don't thread it
  // through the per-format interpreters.
  sessionId?: string;
}

export interface ParseRunLogOpts {
  // Fallback format when no header is present. Tests / new callers pass this
  // explicitly; defaults to claude-stream-json so a pre-092 capture (no
  // header) keeps parsing exactly as it did before.
  format?: AgentOutputFormat;
}

export function parseLine(line: string, format: AgentOutputFormat = "claude-stream-json"): RunEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (format === "text") {
    return [{ kind: "raw", line: truncate(trimmed, 200) }];
  }
  const split = splitJsonObjects(trimmed);
  if (split.objects.length === 0 && !split.hasBraces) {
    // No JSON-shaped content at all — surface as raw so the panel still shows it.
    return [{ kind: "raw", line: truncate(trimmed, 200) }];
  }
  const out: RunEvent[] = [];
  for (const slice of split.objects) {
    let obj: unknown;
    try {
      obj = JSON.parse(slice);
    } catch {
      continue; // malformed object — parseRunLog tracks the count for the banner
    }
    for (const ev of interpretFor(format, obj, slice)) out.push(ev);
  }
  return out;
}

// Parse a whole NDJSON buffer to a flat event stream + counts. The counts let
// the renderer surface "N parsed, M skipped" when a file is truncated or
// corrupted, instead of silently dropping events.
//
// Format resolution: header > opts.format > claude-stream-json. A header
// like `# tpm-run agent=copilot outputFormat=copilot-json` on the first
// non-empty line wins over any caller-provided default — that's the path
// the orchestrator writes when it spawns a non-claude agent.
export function parseRunLog(text: string, opts: ParseRunLogOpts = {}): ParsedRunLog {
  let header: RunLogHeader | undefined;
  let format: AgentOutputFormat = opts.format ?? "claude-stream-json";
  const events: RunEvent[] = [];
  let parsed = 0;
  let skipped = 0;
  let sessionId: string | undefined;
  let headerConsumed = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!headerConsumed) {
      headerConsumed = true;
      const h = parseRunLogHeader(trimmed);
      if (h) {
        header = h;
        if (h.outputFormat) format = h.outputFormat;
        continue;
      }
    }
    if (format === "text") {
      events.push({ kind: "raw", line: truncate(trimmed, 200) });
      continue;
    }
    const split = splitJsonObjects(trimmed);
    if (split.objects.length === 0 && !split.hasBraces) {
      events.push({ kind: "raw", line: truncate(trimmed, 200) });
      continue;
    }
    for (const slice of split.objects) {
      let obj: unknown;
      try {
        obj = JSON.parse(slice);
      } catch {
        skipped++;
        continue;
      }
      parsed++;
      if (sessionId === undefined) sessionId = sessionIdOf(obj);
      for (const ev of interpretFor(format, obj, slice)) events.push(ev);
    }
    if (split.unclosedTail) skipped++;
  }
  return { events, parsed, skipped, format, header, sessionId };
}

// Pull a top-level session id off a parsed NDJSON object. Accepts both the
// snake_case `session_id` (claude, copilot) and a camelCase fallback in case a
// future dialect uses it. Returns undefined for non-objects, missing keys, or
// empty/blank values.
function sessionIdOf(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const key of ["session_id", "sessionId"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length) return v;
  }
  return undefined;
}

// Backwards-compatible flat-stream view over parseRunLog.
export function parseEvents(text: string, opts: ParseRunLogOpts = {}): RunEvent[] {
  return parseRunLog(text, opts).events;
}

interface SplitResult {
  objects: string[];      // each entry is a top-level `{...}` slice
  unclosedTail: boolean;  // saw `{` but never matched it before EOL
  hasBraces: boolean;     // line contained at least one `{`
}

// Brace-depth walker. Emits one slice per top-level `{...}` pair. Ignores text
// outside braces (handles `{...}{...}` and `garbage{...}more` alike) and
// respects JSON string semantics so a `}{` literal inside a value doesn't
// split the surrounding object.
function splitJsonObjects(s: string): SplitResult {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  let hasBraces = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      hasBraces = true;
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          objects.push(s.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return { objects, unclosedTail: depth > 0, hasBraces };
}

// Dispatch on format. claude has a richer interpreter (system/text/tool_use/
// tool_result/result event kinds); copilot starts as a minimal common
// renderer that pulls role + text from common JSON shapes and degrades the
// rest to a JSON preview. Per-agent richer rendering is a follow-up.
function interpretFor(format: AgentOutputFormat, obj: unknown, slice: string): RunEvent[] {
  if (format === "claude-stream-json") return interpret(obj);
  if (format === "copilot-json") {
    const events = interpretCopilot(obj);
    if (events.length > 0) return events;
    // Unknown shape — keep it visible as a raw JSON preview so a stuck
    // copilot run isn't a blank panel.
    return [{ kind: "raw", line: truncate(slice, 200) }];
  }
  // `text` format never reaches here (parseLine / parseRunLog short-circuit),
  // but be defensive: fall through to raw.
  return [{ kind: "raw", line: truncate(slice, 200) }];
}

// Generic "role + text" extractor for copilot-json. Tries shapes documented
// or observed in the wild: `{role, content}` (assistant chat-style),
// `{event, message}` / `{kind, message}` (event-stream-style). When nothing
// matches, returns [] and the caller surfaces a raw JSON preview.
function interpretCopilot(j: unknown): RunEvent[] {
  if (!j || typeof j !== "object") return [];
  const obj = j as Record<string, unknown>;
  // `{role, content}` — chat-message shape. Content can be a string or an
  // array of typed parts (matching anthropic-style blocks). Either way we
  // surface a `say` event so the panel reads like a transcript.
  if (typeof obj.role === "string") {
    const text = extractText(obj.content);
    if (text) return [{ kind: "text", text: truncate(`${obj.role}: ${text}`, 240) }];
  }
  // `{event|kind|type, message}` — observed wrapper around a message blob.
  for (const key of ["event", "kind", "type"] as const) {
    const tag = obj[key];
    if (typeof tag !== "string") continue;
    const text = extractText(obj.message);
    if (text) return [{ kind: "text", text: truncate(`${tag}: ${text}`, 240) }];
  }
  return [];
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    return t.length ? t : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      if (typeof raw === "string") { parts.push(raw); continue; }
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.text === "string") parts.push(item.text);
    }
    const joined = parts.join(" ").trim();
    return joined.length ? joined : null;
  }
  return null;
}

function interpret(j: unknown): RunEvent[] {
  if (!j || typeof j !== "object") return [];
  const obj = j as Record<string, unknown>;
  switch (obj.type) {
    case "system":
      return [{
        kind: "system",
        subtype: typeof obj.subtype === "string" ? obj.subtype : "",
        model: typeof obj.model === "string" ? obj.model : undefined,
      }];
    case "assistant":
      return interpretAssistant(obj.message);
    case "user":
      return interpretUser(obj.message);
    case "result":
      return [{
        kind: "result",
        subtype: typeof obj.subtype === "string" ? obj.subtype : "",
        isError: obj.is_error === true,
        preview: typeof obj.result === "string" ? truncate(obj.result, 240) : "",
        durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : undefined,
        totalCostUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
      }];
  }
  return [];
}

function interpretAssistant(message: unknown): RunEvent[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: RunEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) out.push({ kind: "text", text: truncate(text, 240) });
    } else if (item.type === "tool_use" && typeof item.name === "string") {
      out.push({ kind: "tool_use", name: item.name, inputPreview: previewInput(item.input) });
    }
  }
  return out;
}

function interpretUser(message: unknown): RunEvent[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  // The initial prompt arrives as a string; we don't surface it (it's just
  // `/tpm <slug>`). Tool results arrive as an array of typed parts.
  if (!Array.isArray(content)) return [];
  const out: RunEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "tool_result") {
      out.push({
        kind: "tool_result",
        preview: previewToolResult(item.content),
        isError: item.is_error === true,
      });
    }
  }
  return out;
}

function previewInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input, 100);
  try {
    return truncate(JSON.stringify(input), 100);
  } catch {
    return "";
  }
}

function previewToolResult(content: unknown): string {
  if (typeof content === "string") return truncate(content, 120);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
    if (parts.length) return truncate(parts.join(" "), 120);
  }
  return "";
}

function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= n) return collapsed;
  return collapsed.slice(0, n - 1) + "…";
}
