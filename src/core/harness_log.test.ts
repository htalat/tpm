// Side-effect import: re-homes this process before config.ts (loaded
// transitively by time.ts) is evaluated.
import "./_test_helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskLogEntries } from "./harness_log.ts";

test("parseTaskLogEntries: parses the canonical `- <wall>: <msg>` shape", () => {
  const body = [
    "## Log",
    "- 2026-05-15 13:56 PDT: started",
    "- 2026-05-15 13:58 PDT: opened PR https://github.com/htalat/tpm/pull/66",
    "- 2026-05-15 14:13 PDT: closed",
    "",
    "## Outcome",
    "shipped",
  ].join("\n");
  const entries = parseTaskLogEntries(body, "America/Los_Angeles");
  assert.equal(entries.length, 3);
  assert.equal(entries[0].timestamp, "2026-05-15T13:56:00-07:00");
  assert.equal(entries[0].message, "started");
  assert.equal(entries[0].script, "task-log");
  assert.equal(entries[0].source, "task-log");
  assert.equal(entries[1].message, "opened PR https://github.com/htalat/tpm/pull/66");
  assert.equal(entries[2].message, "closed");
});

test("parseTaskLogEntries: returns [] when no ## Log section", () => {
  const body = "## Context\nfoo\n\n## Plan\n- step 1\n";
  assert.deepEqual(parseTaskLogEntries(body, "America/Los_Angeles"), []);
});

test("parseTaskLogEntries: returns [] when ## Log section is empty", () => {
  const body = "## Log\n\n## Outcome\n";
  assert.deepEqual(parseTaskLogEntries(body, "America/Los_Angeles"), []);
});

test("parseTaskLogEntries: skips malformed bullets (silent drop, not garbage rendering)", () => {
  const body = [
    "## Log",
    "- 2026-05-15 13:56 PDT: started",
    "- some hand-written note without a timestamp",
    "free-form line missing the dash",
    "- 2026-05-15 14:13 PDT: closed",
  ].join("\n");
  const entries = parseTaskLogEntries(body, "America/Los_Angeles");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, "started");
  assert.equal(entries[1].message, "closed");
});

test("parseTaskLogEntries: handles messages containing `:`", () => {
  const body = [
    "## Log",
    "- 2026-05-15 13:56 PDT: status -> review (PR opened, awaiting review)",
    "- 2026-05-15 14:13 PDT: poller — merged https://github.com/x/y/pull/1",
  ].join("\n");
  const entries = parseTaskLogEntries(body, "America/Los_Angeles");
  assert.equal(entries[0].message, "status -> review (PR opened, awaiting review)");
  assert.equal(entries[1].message, "poller — merged https://github.com/x/y/pull/1");
});

test("parseTaskLogEntries: respects DST (winter wall time → -08:00)", () => {
  const body = "## Log\n- 2026-01-15 09:00 PST: started\n";
  const [entry] = parseTaskLogEntries(body, "America/Los_Angeles");
  assert.equal(entry.timestamp, "2026-01-15T09:00:00-08:00");
});

test("parseTaskLogEntries: skips lines with unparseable wall-clock", () => {
  const body = "## Log\n- not-a-date: a message\n- 2026-05-15 13:56 PDT: ok\n";
  const entries = parseTaskLogEntries(body, "America/Los_Angeles");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "ok");
});
