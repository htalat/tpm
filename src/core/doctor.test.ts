import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { checkJournal, checkLegacyStatuses, checkLocks, checkSpaBuild, checkTree, formatDoctor } from "./doctor.ts";

function tree(withTask = true): string {
  const root = mkTempDir("tpm-doctor-");
  mkdirSync(join(root, ".tpm"), { recursive: true });
  mkdirSync(join(root, "alpha", "tasks"), { recursive: true });
  writeFileSync(join(root, "alpha", "project.md"), "---\nname: alpha\nslug: alpha\nstatus: active\n---\n\n# alpha\n");
  if (withTask) {
    writeFileSync(join(root, "alpha", "tasks", "001-a.md"), "---\ntitle: A\nslug: a\nproject: alpha\nstatus: ready\ntype: pr\n---\n\n# A\n");
  }
  return root;
}

test("doctor: tree + statuses report counts and legacy-vocab tasks", () => {
  const root = tree();
  try {
    assert.equal(checkTree(root).level, "ok");
    assert.match(checkTree(root).detail, /1 projects, 1 tasks/);
    assert.equal(checkLegacyStatuses(root).level, "ok");
    writeFileSync(join(root, "alpha", "tasks", "002-old.md"), "---\ntitle: O\nslug: o\nproject: alpha\nstatus: needs-review\ntype: pr\n---\n\n# O\n");
    const legacy = checkLegacyStatuses(root);
    assert.equal(legacy.level, "warn");
    assert.match(legacy.detail, /tpm migrate/);
  } finally {
    rmTempDir(root);
  }
});

test("doctor: journal warns past the size threshold", () => {
  const root = tree(false);
  try {
    assert.match(checkJournal(root).detail, /no journal yet/);
    writeFileSync(join(root, ".tpm", "events.ndjson"), "x".repeat(11 * 1024 * 1024));
    assert.equal(checkJournal(root).level, "warn");
  } finally {
    rmTempDir(root);
  }
});

test("doctor: locks report stale holders", () => {
  const root = tree(false);
  try {
    assert.equal(checkLocks(root).level, "ok");
    const locksDir = join(root, ".tpm", "locks");
    mkdirSync(locksDir, { recursive: true });
    const lock = join(locksDir, "alpha--001-a.lock");
    writeFileSync(lock, "agent-id: w1\npid: 1\nacquired: 2026-01-01 00:00 PDT\nheartbeat: 2026-01-01 00:00 PDT\n");
    const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
    utimesSync(lock, old, old);
    const r = checkLocks(root);
    assert.equal(r.level, "warn");
    assert.match(r.detail, /release-stale/);
  } finally {
    rmTempDir(root);
  }
});

test("doctor: spa build freshness compares src vs dist mtimes", () => {
  const base = mkTempDir("tpm-doctor-spa-");
  try {
    const dist = join(base, "dist");
    assert.equal(checkSpaBuild(dist).level, "warn"); // no build at all
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html>");
    writeFileSync(join(base, "src", "app.tsx"), "code");
    const past = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(join(dist, "index.html"), past, past); // src newer than dist
    assert.equal(checkSpaBuild(dist).level, "warn");
    const future = (Date.now() + 60 * 60 * 1000) / 1000;
    utimesSync(join(dist, "index.html"), future, future);
    assert.equal(checkSpaBuild(dist).level, "ok");
  } finally {
    rmTempDir(base);
  }
});

test("doctor: formatter aligns names and marks levels", () => {
  const out = formatDoctor([
    { name: "a", level: "ok", detail: "fine" },
    { name: "longer", level: "warn", detail: "hmm" },
    { name: "x", level: "fail", detail: "broken" },
  ]);
  assert.match(out, /✓ a {7}fine/);
  assert.match(out, /! longer {2}hmm/);
  assert.match(out, /✗ x {7}broken/);
});
