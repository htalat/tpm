import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";

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
  if (!existsSync(dir)) return null;
  const prefix = `${encodeSlug(slug)}--`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const matches = entries.filter(f => f.startsWith(prefix) && f.endsWith(".log"));
  if (matches.length === 0) return null;
  matches.sort();
  return resolve(dir, matches[matches.length - 1]);
}

// Path-traversal guard for the `/runs/<file>` route. A valid name is
// `<kebab-slug>--<compact-utc>.log` and nothing else — no slashes, no `..`,
// no leading dots.
export function isValidRunLogName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*--\d{8}T\d{6}Z\.log$/i.test(name);
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
// Anything we don't recognize we degrade to `raw` so the panel still shows
// *something* — better than a silently empty tail when the schema shifts.

export type RunEvent =
  | { kind: "system"; subtype: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; inputPreview: string }
  | { kind: "tool_result"; preview: string; isError: boolean }
  | { kind: "result"; subtype: string; isError: boolean; preview: string; durationMs?: number; totalCostUsd?: number }
  | { kind: "raw"; line: string };

export function parseLine(line: string): RunEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [{ kind: "raw", line: truncate(trimmed, 200) }];
  }
  return interpret(json);
}

// Parse a whole NDJSON buffer to a flat event stream. Used by the serve panel
// to tail the latest log.
export function parseEvents(text: string): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const ev of parseLine(line)) out.push(ev);
  }
  return out;
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
