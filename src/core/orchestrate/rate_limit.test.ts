import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  detectRateLimitText,
  detectRateLimitInLog,
  parseResetAtMs,
  resolveBackoffUntil,
  armRateLimitBackoff,
  readRateLimitBackoff,
  clearRateLimitBackoff,
  rateLimitBackoffActive,
  DEFAULT_RATE_LIMIT_BACKOFF_MINUTES,
  MAX_RATE_LIMIT_BACKOFF_MINUTES,
} from "./rate_limit.ts";

const MIN = 60_000;

function tmp(): string {
  return mkdtempSync(resolve(tmpdir(), "tpm-ratelimit-"));
}

// ---- detection ----

test("detectRateLimitText: 'out of extra usage' → limited", () => {
  assert.equal(detectRateLimitText("You're out of extra usage. Try later.").limited, true);
});

test("detectRateLimitText: 'usage limit reached' → limited", () => {
  assert.equal(detectRateLimitText("Claude usage limit reached.").limited, true);
});

test("detectRateLimitText: Claude Code rolling-window message → limited", () => {
  assert.equal(detectRateLimitText("5-hour limit reached ∙ resets 3pm").limited, true);
});

test("detectRateLimitText: weekly limit message → limited", () => {
  assert.equal(detectRateLimitText("Weekly limit reached.").limited, true);
});

test("detectRateLimitText: anthropic rate_limit_error type → limited", () => {
  assert.equal(
    detectRateLimitText('{"type":"error","error":{"type":"rate_limit_error"}}').limited,
    true,
  );
});

test("detectRateLimitText: credit-balance message → limited", () => {
  assert.equal(
    detectRateLimitText("Your credit balance is too low to access the API.").limited,
    true,
  );
});

test("detectRateLimitText: out_of_credits token → limited", () => {
  assert.equal(detectRateLimitText('"stop_reason":"out_of_credits"').limited, true);
});

test("detectRateLimitText: a normal successful transcript → not limited", () => {
  const transcript =
    '{"type":"result","subtype":"success","is_error":false,"result":"Opened PR #42"}';
  assert.equal(detectRateLimitText(transcript).limited, false);
});

test("detectRateLimitText: a bare 'rate limit' mention (e.g. GitHub API) does NOT trip", () => {
  // Specificity guard: tool output mentioning a GitHub rate limit must not arm
  // the agent-usage backoff.
  assert.equal(
    detectRateLimitText("gh: API rate limit note — best-effort, continuing").limited,
    false,
  );
});

// ---- reset-time parsing ----

test("parseResetAtMs: ISO-8601 after 'reset' is honored", () => {
  const ms = parseResetAtMs("Your limit will reset at 2026-06-28T23:00:00Z.");
  assert.equal(ms, Date.parse("2026-06-28T23:00:00Z"));
});

test("parseResetAtMs: epoch seconds after 'reset' are scaled to ms", () => {
  const ms = parseResetAtMs("limit resets 1750000000");
  assert.equal(ms, 1750000000 * 1000);
});

test("parseResetAtMs: epoch ms after 'reset' pass through", () => {
  const ms = parseResetAtMs("reset_at: 1750000000000");
  assert.equal(ms, 1750000000000);
});

test("parseResetAtMs: a human '3pm' string is NOT parsed (too ambiguous)", () => {
  assert.equal(parseResetAtMs("Your limit resets at 3pm today."), undefined);
});

// ---- backoff window ----

test("resolveBackoffUntil: no reset time → default cooldown", () => {
  const now = 1_000_000;
  assert.equal(
    resolveBackoffUntil({ limited: true }, now),
    now + DEFAULT_RATE_LIMIT_BACKOFF_MINUTES * MIN,
  );
});

test("resolveBackoffUntil: a near-future reset time is honored verbatim", () => {
  const now = 1_000_000;
  const reset = now + 10 * MIN;
  assert.equal(resolveBackoffUntil({ limited: true, resetAtMs: reset }, now), reset);
});

test("resolveBackoffUntil: a far-future reset time is clamped to the max window", () => {
  const now = 1_000_000;
  const reset = now + 1000 * MIN; // way past the 6h cap
  assert.equal(
    resolveBackoffUntil({ limited: true, resetAtMs: reset }, now),
    now + MAX_RATE_LIMIT_BACKOFF_MINUTES * MIN,
  );
});

test("resolveBackoffUntil: a past reset time falls back to the default cooldown", () => {
  const now = 1_000_000;
  assert.equal(
    resolveBackoffUntil({ limited: true, resetAtMs: now - MIN }, now),
    now + DEFAULT_RATE_LIMIT_BACKOFF_MINUTES * MIN,
  );
});

// ---- marker round-trip ----

test("arm / read / active / expire round-trip", () => {
  const dir = tmp();
  const path = resolve(dir, "backoff.json");
  const now = 10_000_000;
  try {
    const state = armRateLimitBackoff({ limited: true }, now, path);
    assert.equal(state.untilMs, now + DEFAULT_RATE_LIMIT_BACKOFF_MINUTES * MIN);
    assert.ok(existsSync(path));

    // read echoes the persisted window
    assert.equal(readRateLimitBackoff(path)?.untilMs, state.untilMs);

    // active inside the window
    assert.ok(rateLimitBackoffActive(now + 5 * MIN, path));

    // past the window → null, and the stale marker is swept
    assert.equal(rateLimitBackoffActive(state.untilMs + 1, path), null);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRateLimitBackoff: missing file → null", () => {
  const dir = tmp();
  try {
    assert.equal(readRateLimitBackoff(resolve(dir, "nope.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRateLimitBackoff: malformed JSON → null (never throws)", () => {
  const dir = tmp();
  const path = resolve(dir, "backoff.json");
  try {
    writeFileSync(path, "{not json");
    assert.equal(readRateLimitBackoff(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearRateLimitBackoff removes the marker and is safe when absent", () => {
  const dir = tmp();
  const path = resolve(dir, "backoff.json");
  try {
    armRateLimitBackoff({ limited: true }, 1, path);
    clearRateLimitBackoff(path);
    assert.equal(existsSync(path), false);
    // no-throw on a second clear
    clearRateLimitBackoff(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- detection from a log file (tail scan) ----

test("detectRateLimitInLog: finds the signature near the end of a large transcript", () => {
  const dir = tmp();
  const path = resolve(dir, "run.log");
  try {
    const filler = "x".repeat(200_000) + "\n";
    writeFileSync(path, filler + "You're out of extra usage.\n");
    assert.equal(detectRateLimitInLog(path).limited, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRateLimitInLog: clean transcript → not limited", () => {
  const dir = tmp();
  const path = resolve(dir, "run.log");
  try {
    writeFileSync(path, '{"type":"result","subtype":"success"}\n');
    assert.equal(detectRateLimitInLog(path).limited, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRateLimitInLog: missing file → not limited (no throw)", () => {
  assert.equal(detectRateLimitInLog("/no/such/run.log").limited, false);
});
