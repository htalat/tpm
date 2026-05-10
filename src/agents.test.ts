// Side-effect import: re-homes this process before agents.ts is evaluated,
// so AGENTS_PATH points at a throwaway directory.
import "./_test_helpers.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  AGENTS_PATH,
  readAgentsRegistry,
  writeAgentsRegistry,
  affinityFor,
  setAgent,
  removeAgent,
} from "./agents.ts";

beforeEach(() => {
  if (existsSync(AGENTS_PATH)) rmSync(AGENTS_PATH);
});

test("readAgentsRegistry: returns empty when file missing", () => {
  assert.deepEqual(readAgentsRegistry(), { agents: {} });
});

test("readAgentsRegistry + writeAgentsRegistry: round-trip", () => {
  const reg = {
    agents: {
      "nightly-runner": { prefer_repos: ["tpm"], comment: "fires at 3am" },
      "laptop": { prefer_repos: [] },
    },
  };
  writeAgentsRegistry(reg);
  assert.deepEqual(readAgentsRegistry(), reg);
});

test("readAgentsRegistry: throws on malformed JSON", () => {
  writeFileSync(AGENTS_PATH, "{not json");
  assert.throws(() => readAgentsRegistry(), /Failed to parse/);
});

test("readAgentsRegistry: throws on non-object root", () => {
  writeFileSync(AGENTS_PATH, "[]");
  assert.throws(() => readAgentsRegistry(), /must be a JSON object/);
});

test("readAgentsRegistry: throws on prefer_repos with non-string entries", () => {
  writeFileSync(AGENTS_PATH, JSON.stringify({ agents: { x: { prefer_repos: ["ok", 42] } } }));
  assert.throws(() => readAgentsRegistry(), /prefer_repos\[1\] must be a string/);
});

test("affinityFor: returns prefer_repos for known agent", () => {
  writeAgentsRegistry({ agents: { "nightly-runner": { prefer_repos: ["tpm", "acme"] } } });
  assert.deepEqual(affinityFor("nightly-runner"), ["tpm", "acme"]);
});

test("affinityFor: returns [] for unknown agent (no affinity = pick anything)", () => {
  writeAgentsRegistry({ agents: { "nightly-runner": { prefer_repos: ["tpm"] } } });
  assert.deepEqual(affinityFor("some-other-agent"), []);
});

test("affinityFor: returns [] when registry missing (no affinity configured)", () => {
  assert.deepEqual(affinityFor("any-agent"), []);
});

test("affinityFor: returns [] (graceful) when registry is malformed", () => {
  // Missing/malformed registry shouldn't kill `tpm next --claim`; the user
  // will see the explicit error when they run `tpm agents`.
  writeFileSync(AGENTS_PATH, "{not json");
  assert.deepEqual(affinityFor("any-agent"), []);
});

test("setAgent: creates a new entry when none exists", () => {
  setAgent("nightly-runner", "tpm");
  assert.deepEqual(affinityFor("nightly-runner"), ["tpm"]);
});

test("setAgent: appends another repo without duplicating", () => {
  setAgent("nightly-runner", "tpm");
  setAgent("nightly-runner", "acme");
  setAgent("nightly-runner", "tpm"); // dup
  assert.deepEqual(affinityFor("nightly-runner"), ["tpm", "acme"]);
});

test("setAgent: comment updates on subsequent calls", () => {
  setAgent("nightly-runner", "tpm", "first");
  setAgent("nightly-runner", "acme", "second");
  assert.equal(readAgentsRegistry().agents["nightly-runner"].comment, "second");
});

test("removeAgent: drops the entry", () => {
  setAgent("nightly-runner", "tpm");
  assert.equal(removeAgent("nightly-runner"), true);
  assert.deepEqual(affinityFor("nightly-runner"), []);
});

test("removeAgent: returns false when the entry doesn't exist", () => {
  assert.equal(removeAgent("never-seen"), false);
});
