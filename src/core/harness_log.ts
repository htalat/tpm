// Reader + parser for the structured envelope logs the harness writes under
// `~/.tpm/`. Two families of files:
//
//   ~/.tpm/orchestrator-<agent-id>.log   — one per cron / tmux agent, stdout
//                                          + stderr from `tpm orchestrate`
//                                          and the child claude.
//   ~/.tpm/recurring-<script-name>.log   — one per recurring script (poller,
//                                          intake, etc.).
//
// Each log mixes two kinds of lines:
//   1. Structured (task 042): `<timestamp> <level> <script> <message>` written
//      via `src/log.ts` (used by `tpm orchestrate`, `tpm poll`). A user's own
//      recurring shell scripts can emit the same envelope shape.
//   2. Free-form: anything the child agent or a non-instrumented script wrote
//      to stdout/stderr. We surface those verbatim as `raw` lines so the
//      operator sees the whole tape, not just the structured slice.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { wallToIsoOffset } from "../util/time.ts";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface HarnessLogLine {
  raw: string;
  timestamp?: string;
  level?: LogLevel;
  script?: string;
  message?: string;
  // `task-log` marks entries lifted out of a task body's `## Log` section.
  // They don't carry a structured level; the UI renders them without a level
  // chip and styles the script column to read as a source badge.
  source?: "task-log";
}

export interface HarnessLogSource {
  // Display name, e.g. "orchestrator-laptop" — basename without the `.log`.
  name: string;
  // Absolute path on disk (for the "file: <path>" hint).
  path: string;
  // False when the file is missing — the page still renders an empty panel
  // with the would-be path so the operator knows where to look.
  exists: boolean;
  // Tail of parsed lines (oldest-first within the slice). The page renders
  // bottom-up; consumers don't have to reverse.
  lines: HarnessLogLine[];
  // Total parsed-line count before tailing. Lets the UI say "showing the
  // last N of M" honestly.
  totalLines: number;
}

export interface HarnessLogReadOpts {
  // Max lines per file. Defaults handled by the caller.
  lines: number;
  // Substring filter. Applied per line on the raw text (so it matches both
  // structured fields and free-form output). Case-sensitive — task slugs are
  // kebab-case so this is fine.
  filter?: string;
}

export type HarnessLogReader = (opts: HarnessLogReadOpts) => HarnessLogSource[];

// Structured line: `2026-05-15T18:42:25-07:00  INFO  orchestrate  message…`.
// Timestamp is ISO-8601 with offset (post-task-061) or trailing `Z` (older
// poller entries). One+ spaces between columns.
const STRUCTURED_RE = /^(\S+T\S+)\s+(INFO|WARN|ERROR)\s+(\S+)\s+(.*)$/;

export function parseLine(raw: string): HarnessLogLine {
  const m = STRUCTURED_RE.exec(raw);
  if (!m) return { raw };
  return {
    raw,
    timestamp: m[1],
    level: m[2] as LogLevel,
    script: m[3],
    message: m[4],
  };
}

// Tail the last N lines of a file, applying an optional substring filter.
// Returns the parsed lines (oldest-first) and the total line count before the
// tail (so the UI can honestly report "last N of M").
//
// `readFileSync` + split is fine: these files are plain text, < a few MB in
// practice, no rotation. A backwards-byte tailer would be overkill.
export function tailFile(
  path: string,
  lines: number,
  filter?: string,
): { lines: HarnessLogLine[]; totalLines: number } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { lines: [], totalLines: 0 };
  }
  const all = text.split(/\r?\n/).filter(l => l.length > 0);
  const filtered = filter
    ? all.filter(l => l.includes(filter))
    : all;
  const slice = lines > 0 ? filtered.slice(-lines) : filtered;
  return {
    lines: slice.map(parseLine),
    totalLines: filtered.length,
  };
}

// Discover the harness log files. Names follow the conventions documented in
// README "Recurring scripts" / "Concurrent orchestrators": each agent and each
// recurring script writes to its own file, so a real operator has more than
// the two files the task body called out by name.
//
// Ordering: orchestrator logs first (alphabetically), then recurring logs.
// Operator usually cares about agent activity > poller noise.
export function discoverLogPaths(dir: string = CONFIG_DIR): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const orch: string[] = [];
  const rec: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    if (name.startsWith("orchestrator-")) orch.push(name);
    else if (name.startsWith("recurring-")) rec.push(name);
  }
  orch.sort();
  rec.sort();
  return [...orch, ...rec].map(name => resolve(dir, name));
}

// Default reader (production path). Tests inject an in-memory stub so the
// route stays disk-free.
export function defaultHarnessLogReader(opts: HarnessLogReadOpts): HarnessLogSource[] {
  return discoverLogPaths().map(path => {
    const exists = existsSync(path);
    if (!exists) {
      return { name: basenameWithoutExt(path), path, exists, lines: [], totalLines: 0 };
    }
    // statSync is just a sanity check that the entry is a regular file — a
    // symlink to a non-existing target would have passed the existsSync above.
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        return { name: basenameWithoutExt(path), path, exists: false, lines: [], totalLines: 0 };
      }
    } catch {
      return { name: basenameWithoutExt(path), path, exists: false, lines: [], totalLines: 0 };
    }
    const { lines, totalLines } = tailFile(path, opts.lines, opts.filter);
    return { name: basenameWithoutExt(path), path, exists: true, lines, totalLines };
  });
}

function basenameWithoutExt(path: string): string {
  const b = basename(path);
  return b.endsWith(".log") ? b.slice(0, -4) : b;
}

// Parse a task body's `## Log` section into HarnessLogLine records so the
// `/logs?task=<slug>` view can merge them with envelope-log entries on a
// single chronological timeline. Lines that don't match the canonical
// `- <wall-clock>: <message>` shape are skipped — humans occasionally edit
// the Log section by hand and we'd rather silently drop noise than render
// half-parsed garbage.
//
// Timestamp conversion uses the configured TZ (or `tz` if passed) as the
// authority; the abbreviation in the source (`PDT`, `PST`, etc.) is
// informational and not parsed.
export function parseTaskLogEntries(body: string, tz?: string): HarnessLogLine[] {
  const section = extractLogSection(body);
  if (!section) return [];
  const out: HarnessLogLine[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const m = raw.match(/^-\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*(?:[A-Z]{2,5})?\s*:\s*(.*)$/);
    if (!m) continue;
    const iso = wallToIsoOffset(m[1], tz);
    if (!iso) continue;
    out.push({
      raw,
      timestamp: iso,
      script: "task-log",
      message: m[2],
      source: "task-log",
    });
  }
  return out;
}

function extractLogSection(body: string): string | null {
  const m = body.match(/(?:^|\n)##\s+Log\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  return m ? m[1] : null;
}
