// Side-effect import: re-homes this process before config.ts is evaluated.
import "./_test_helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWithOffset, wallToIsoOffset } from "./time.ts";

test("isoWithOffset: PDT instant in America/Los_Angeles → -07:00", () => {
  // 2026-05-15 16:14:23Z is summer in LA (PDT, UTC-7) → 09:14:23 local.
  const d = new Date("2026-05-15T16:14:23Z");
  assert.equal(isoWithOffset(d, "America/Los_Angeles"), "2026-05-15T09:14:23-07:00");
});

test("isoWithOffset: PST instant in America/Los_Angeles → -08:00", () => {
  // 2026-01-15 17:14:23Z is winter in LA (PST, UTC-8) → 09:14:23 local.
  const d = new Date("2026-01-15T17:14:23Z");
  assert.equal(isoWithOffset(d, "America/Los_Angeles"), "2026-01-15T09:14:23-08:00");
});

test("isoWithOffset: UTC tz emits +00:00 (not Z)", () => {
  const d = new Date("2026-05-15T16:14:23Z");
  assert.equal(isoWithOffset(d, "UTC"), "2026-05-15T16:14:23+00:00");
});

test("isoWithOffset: positive offset zone renders with leading +", () => {
  // Europe/Berlin in summer is CEST (UTC+2).
  const d = new Date("2026-07-15T10:00:00Z");
  assert.equal(isoWithOffset(d, "Europe/Berlin"), "2026-07-15T12:00:00+02:00");
});

test("isoWithOffset: half-hour offset zone (IST = +05:30)", () => {
  // Asia/Kolkata is fixed +05:30 year-round — exercises the minute component.
  const d = new Date("2026-05-15T00:00:00Z");
  assert.equal(isoWithOffset(d, "Asia/Kolkata"), "2026-05-15T05:30:00+05:30");
});

test("isoWithOffset: DST fall-back hour resolves consistently to PST (-08:00)", () => {
  // US fall-back is 2026-11-01: 02:00 PDT → 01:00 PST. The post-transition
  // instant (09:30Z = 01:30 PST) must render with the -08:00 offset, not -07.
  const d = new Date("2026-11-01T09:30:00Z");
  assert.equal(isoWithOffset(d, "America/Los_Angeles"), "2026-11-01T01:30:00-08:00");
});

test("isoWithOffset: pre-transition instant in the same fall-back hour stays PDT", () => {
  // 08:30Z on the same day is still PDT (01:30 PDT, one wall-clock hour before
  // the fall-back instant). Offset must be -07:00.
  const d = new Date("2026-11-01T08:30:00Z");
  assert.equal(isoWithOffset(d, "America/Los_Angeles"), "2026-11-01T01:30:00-07:00");
});

test("isoWithOffset: defaults to configured TZ when none passed", () => {
  // _test_helpers re-homes to a fresh dir with no config.json — so
  // configuredTimezone() returns DEFAULT_TIMEZONE (America/Los_Angeles).
  // Pin to a winter instant so the offset is the stable -08:00.
  const d = new Date("2026-01-15T17:14:23Z");
  assert.equal(isoWithOffset(d), "2026-01-15T09:14:23-08:00");
});

test("wallToIsoOffset: PDT wall time in America/Los_Angeles", () => {
  // tpm-now-style input: "YYYY-MM-DD HH:MM <abbrev>". Abbrev is decorative.
  assert.equal(
    wallToIsoOffset("2026-05-15 14:13 PDT", "America/Los_Angeles"),
    "2026-05-15T14:13:00-07:00",
  );
});

test("wallToIsoOffset: PST wall time in America/Los_Angeles", () => {
  assert.equal(
    wallToIsoOffset("2026-01-15 09:14 PST", "America/Los_Angeles"),
    "2026-01-15T09:14:00-08:00",
  );
});

test("wallToIsoOffset: trailing zone abbreviation is ignored (configured tz wins)", () => {
  // Even if a stale abbrev claims "PDT" mid-winter, the configured tz picks
  // the correct -08:00 offset for that wall instant.
  assert.equal(
    wallToIsoOffset("2026-01-15 09:14 PDT", "America/Los_Angeles"),
    "2026-01-15T09:14:00-08:00",
  );
});

test("wallToIsoOffset: positive-offset tz renders with leading +", () => {
  assert.equal(
    wallToIsoOffset("2026-07-15 12:00 CEST", "Europe/Berlin"),
    "2026-07-15T12:00:00+02:00",
  );
});

test("wallToIsoOffset: half-hour-offset tz keeps minute component", () => {
  assert.equal(
    wallToIsoOffset("2026-05-15 05:30 IST", "Asia/Kolkata"),
    "2026-05-15T05:30:00+05:30",
  );
});

test("wallToIsoOffset: accepts T-separator and seconds (idempotent on ISO-shaped input)", () => {
  assert.equal(
    wallToIsoOffset("2026-05-15T14:13:23", "America/Los_Angeles"),
    "2026-05-15T14:13:23-07:00",
  );
});

test("wallToIsoOffset: rejects garbage input", () => {
  assert.equal(wallToIsoOffset("not a date", "America/Los_Angeles"), null);
  assert.equal(wallToIsoOffset("", "America/Los_Angeles"), null);
});

test("wallToIsoOffset: defaults to configured TZ when none passed", () => {
  // Configured TZ defaults to America/Los_Angeles in tests; winter wall time
  // maps to -08:00.
  assert.equal(wallToIsoOffset("2026-01-15 09:14"), "2026-01-15T09:14:00-08:00");
});
