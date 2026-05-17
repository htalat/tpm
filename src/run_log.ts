import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import type { AgentOutputFormat } from "./agent_cli.ts";

// Per-run logs live under `~/.tpm/runs/`. One file per orchestrator-spawned
// claude session. The orchestrator pipes the child's stdout/stderr into the
// file; `tpm serve` tails the most recent file for the task's detail page.
//
// File naming: `<slug-encoded>--<utc-iso-compact>.log`
//   - slug-encoded: `/` → `-` so the slug survives as a basename.
//     `tpm/057-foo` → `tpm-057-foo`.
//   - utc-iso-compact: `YYYYMMDDTHHMMSSZ`. Sorts lexicographically by time, so
//     a `readdir().sort().reverse()` gives newest-first without a stat call.
//   - Separator is `--` (two dashes) — slugs are kebab-case (single dashes), so
//     this is unambiguous to split on if we ever need the slug back out.

export function runsDir(): string {
  return resolve(CONFIG_DIR, "runs");
}

export function encodeSlug(slug: string): string {
  return slug.replace(/[\/\\]/g, "-");
}

// `2026-05-15T23:05:44.123Z` → `20260515T230544Z`.
export function compactUtc(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

export function newRunLogPath(slug: string, when: Date = new Date()): string {
  return resolve(runsDir(), `${encodeSlug(slug)}--${compactUtc(when)}.log`);
}

// Most recent run log for a slug, or null if none exist. Sorts by filename
// (compact UTC sorts chronologically); no fs.stat per file.
export function latestRunLog(slug: string, dir: string = runsDir()): string | null {
  const all = allRunLogs(slug, dir);
  return all.length ? all[0] : null;
}

// All run logs for a slug, newest-first (compact-UTC suffix sorts
// chronologically). Returns absolute paths; callers can `basename()` for
// display. Empty array when the runs dir doesn't exist or the slug has no
// runs — the page renders a "never dispatched" placeholder either way.
export function allRunLogs(slug: string, dir: string = runsDir()): string[] {
  if (!existsSync(dir)) return [];
  const prefix = `${encodeSlug(slug)}--`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const matches = entries.filter(f => f.startsWith(prefix) && f.endsWith(".log"));
  matches.sort();
  matches.reverse();
  return matches.map(name => resolve(dir, name));
}

// Path-traversal guard for the `/runs/<file>` route. A valid name is
// `<kebab-slug>--<compact-utc>.log` and nothing else — no slashes, no `..`,
// no leading dots.
export function isValidRunLogName(name: string): boolean {
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
      for (const ev of interpretFor(format, obj, slice)) events.push(ev);
    }
    if (split.unclosedTail) skipped++;
  }
  return { events, parsed, skipped, format, header };
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
