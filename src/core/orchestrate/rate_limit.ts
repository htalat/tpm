// Agent rate-limit / usage-limit / credit-exhaustion handling.
//
// When the spawned agent (claude et al.) dies because the account hit a usage
// cap or ran out of credit, the run-log audit caught the orchestrator
// relaunching a doomed stub *every ~5 min with no backoff* — four consecutive
// "You're out of extra usage" runs, each a silent re-entry into a half-done
// run. A rate limit is account-global, so the next launch is just as doomed.
//
// Two pieces live here:
//   - detection: scan the captured run-log tail for known usage/credit
//     signatures, and (best-effort) an explicit reset time.
//   - a cross-process backoff marker under ~/.tpm so every worker and every
//     re-spawned `tpm orchestrate` skips claiming until the window clears.
//     The marker auto-expires; a clean (non-rate-limited) run clears it.

import { existsSync, readFileSync, writeFileSync, openSync, fstatSync, readSync, closeSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { CONFIG_DIR } from "../config.ts";

export const RATE_LIMIT_BACKOFF_PATH = resolve(CONFIG_DIR, "rate-limit-backoff.json");

// Default cooldown when the run output carries no parseable reset time. Long
// enough to break the ~5-min relaunch storm the audit flagged, short enough
// that recovery is prompt once the window rolls over — each retry re-detects
// and re-arms, so this is self-correcting, not a hard wait.
export const DEFAULT_RATE_LIMIT_BACKOFF_MINUTES = 30;

// Cap on an honored reset time. A garbled/hostile "reset at <far future>" must
// not park the whole orchestrator for days.
export const MAX_RATE_LIMIT_BACKOFF_MINUTES = 6 * 60;

// Only the tail of the run log matters: the usage-limit message and the final
// result event land at the very end. Reading a bounded window keeps this cheap
// even on a multi-MB NDJSON transcript.
const TAIL_BYTES = 64 * 1024;

// Signatures for the usage/credit death class. Kept specific so an unrelated
// mention (e.g. a GitHub API rate-limit note in tool output) doesn't trip the
// backoff — we match the agent's own limit messaging and the Anthropic API
// error types, not the bare phrase "rate limit".
const SIGNATURES: RegExp[] = [
  /out of extra usage/i,        // the run-log audit's exact string
  /usage limit reached/i,
  /claude usage limit/i,
  /\d+-hour limit reached/i,    // Claude Code's rolling-window message ("5-hour limit reached")
  /weekly limit reached/i,
  /\brate_limit_error\b/i,      // Anthropic API error type
  /credit balance is too low/i, // Anthropic billing error
  /\bout_of_credits\b/i,
  /insufficient.{0,12}credit/i,
];

export interface RateLimitDetection {
  limited: boolean;
  // Absolute epoch-ms the limit window is said to reset, when the output
  // carried a machine-unambiguous form. Undefined → caller uses the default
  // cooldown.
  resetAtMs?: number;
}

export function detectRateLimitText(text: string): RateLimitDetection {
  if (!SIGNATURES.some((re) => re.test(text))) return { limited: false };
  return { limited: true, resetAtMs: parseResetAtMs(text) };
}

// Parse an explicit, absolute reset time if present. Only machine-unambiguous
// forms are honored — a unix epoch (seconds or ms) or an ISO-8601 timestamp
// following a "reset" keyword. Human strings like "3pm" are deliberately not
// parsed (locale/timezone-ambiguous); those fall back to the default cooldown.
export function parseResetAtMs(text: string): number | undefined {
  const iso = text.match(
    /reset[^0-9]{0,40}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const epoch = text.match(/reset[^0-9]{0,40}(\d{10,13})/i);
  if (epoch) {
    const digits = epoch[1];
    const n = Number(digits);
    if (Number.isFinite(n) && n > 0) return digits.length <= 10 ? n * 1000 : n;
  }
  return undefined;
}

// Detect from a captured run-log file by scanning its tail. Any read error
// (missing file, no-capture run) means "not detected" — the caller falls
// through to its normal disposition.
export function detectRateLimitInLog(logFile: string): RateLimitDetection {
  let text: string;
  try {
    text = readTail(logFile, TAIL_BYTES);
  } catch {
    return { limited: false };
  }
  return detectRateLimitText(text);
}

function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const start = size - len;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

export interface BackoffState {
  untilMs: number;
  armedAtMs: number;
  reason: "rate-limit";
}

// Resolve the window the marker should hold: honor a parsed reset time (clamped
// to the max), else the default cooldown.
export function resolveBackoffUntil(detection: RateLimitDetection, nowMs: number): number {
  const maxUntil = nowMs + MAX_RATE_LIMIT_BACKOFF_MINUTES * 60_000;
  if (detection.resetAtMs && detection.resetAtMs > nowMs) {
    return Math.min(detection.resetAtMs, maxUntil);
  }
  return nowMs + DEFAULT_RATE_LIMIT_BACKOFF_MINUTES * 60_000;
}

export function armRateLimitBackoff(
  detection: RateLimitDetection,
  nowMs: number,
  path: string = RATE_LIMIT_BACKOFF_PATH,
): BackoffState {
  const state: BackoffState = {
    untilMs: resolveBackoffUntil(detection, nowMs),
    armedAtMs: nowMs,
    reason: "rate-limit",
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch { /* best-effort — a marker we can't persist just means no backoff */ }
  return state;
}

export function readRateLimitBackoff(path: string = RATE_LIMIT_BACKOFF_PATH): BackoffState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BackoffState>;
    if (typeof raw?.untilMs !== "number" || !Number.isFinite(raw.untilMs)) return null;
    return {
      untilMs: raw.untilMs,
      armedAtMs: typeof raw.armedAtMs === "number" ? raw.armedAtMs : raw.untilMs,
      reason: "rate-limit",
    };
  } catch {
    return null;
  }
}

export function clearRateLimitBackoff(path: string = RATE_LIMIT_BACKOFF_PATH): void {
  try { rmSync(path, { force: true }); } catch { /* best-effort */ }
}

// Is a backoff currently in effect? Returns the live state, or null once the
// window has passed (clearing the expired marker as a side effect so the tree
// doesn't accumulate stale files).
export function rateLimitBackoffActive(
  nowMs: number,
  path: string = RATE_LIMIT_BACKOFF_PATH,
): BackoffState | null {
  const state = readRateLimitBackoff(path);
  if (!state) return null;
  if (nowMs >= state.untilMs) {
    clearRateLimitBackoff(path);
    return null;
  }
  return state;
}
