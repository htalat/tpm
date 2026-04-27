// Side-effect import: re-homes this process before config.ts is evaluated,
// so CONFIG_DIR/CONFIG_PATH point at a throwaway directory.
import { TEMP_HOME } from "./_test_helpers.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_TIMEZONE,
  readConfig,
  writeConfig,
} from "./config.ts";
import { configuredTimezone, now } from "./time.ts";

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

test("CONFIG_DIR points under HOME (isolated)", () => {
  assert.equal(CONFIG_DIR, join(TEMP_HOME, ".tpm"));
  assert.equal(CONFIG_PATH, join(TEMP_HOME, ".tpm", "config.json"));
});

test("readConfig: returns {} when config file is missing", () => {
  assert.deepEqual(readConfig(), {});
});

test("readConfig + writeConfig: round-trip", () => {
  const cfg = { root: "/some/where", timezone: "Europe/Berlin" };
  writeConfig(cfg);
  assert.ok(existsSync(CONFIG_PATH));
  assert.deepEqual(readConfig(), cfg);
});

test("writeConfig: creates parent directory if missing", () => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  assert.ok(!existsSync(CONFIG_DIR));
  writeConfig({ root: "/x" });
  assert.ok(existsSync(CONFIG_DIR));
});

test("writeConfig: writes pretty JSON with trailing newline", () => {
  writeConfig({ root: "/x", timezone: "UTC" });
  const text = readFileSync(CONFIG_PATH, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.match(text, /\n {2}"root": "\/x"/);
});

test("readConfig: throws on malformed JSON with the path in the message", () => {
  writeConfig({ root: "/x" });
  writeFileSync(CONFIG_PATH, "{not json");
  assert.throws(() => readConfig(), new RegExp(`Failed to parse ${CONFIG_PATH.replace(/[/]/g, "\\/")}`));
});

test("readConfig: throws on JSON array (not silently coerced to {})", () => {
  writeConfig({ root: "/x" });
  writeFileSync(CONFIG_PATH, "[]");
  assert.throws(() => readConfig(), /must be a JSON object, got array/);
});

test("readConfig: throws on JSON null with a clear message", () => {
  writeConfig({ root: "/x" });
  writeFileSync(CONFIG_PATH, "null");
  assert.throws(() => readConfig(), /must be a JSON object, got null/);
});

test("readConfig: throws on JSON string with a clear message", () => {
  writeConfig({ root: "/x" });
  writeFileSync(CONFIG_PATH, "\"hello\"");
  assert.throws(() => readConfig(), /must be a JSON object, got string/);
});

test("readConfig: throws on JSON number with a clear message", () => {
  writeConfig({ root: "/x" });
  writeFileSync(CONFIG_PATH, "42");
  assert.throws(() => readConfig(), /must be a JSON object, got number/);
});

test("configuredTimezone: defaults when config missing", () => {
  assert.equal(configuredTimezone(), DEFAULT_TIMEZONE);
});

test("configuredTimezone: defaults when timezone is empty string", () => {
  writeConfig({ root: "/x", timezone: "" });
  assert.equal(configuredTimezone(), DEFAULT_TIMEZONE);
});

test("configuredTimezone: honors configured value", () => {
  writeConfig({ root: "/x", timezone: "Europe/Berlin" });
  assert.equal(configuredTimezone(), "Europe/Berlin");
});

test("now: formats date in configured timezone (deterministic instant)", () => {
  writeConfig({ root: "/x", timezone: "UTC" });
  // 2026-04-26T15:30:00Z
  const fixed = new Date(Date.UTC(2026, 3, 26, 15, 30, 0));
  const formatted = now(fixed);
  assert.match(formatted, /^2026-04-26 15:30 UTC$/);
});

test("now: same instant, different timezones, different output", () => {
  const fixed = new Date(Date.UTC(2026, 3, 26, 15, 30, 0));
  writeConfig({ root: "/x", timezone: "UTC" });
  const utc = now(fixed);
  writeConfig({ root: "/x", timezone: "America/Los_Angeles" });
  const la = now(fixed);
  assert.notEqual(utc, la);
  assert.match(la, /^2026-04-26 08:30 (PDT|GMT-7)$/);
});
