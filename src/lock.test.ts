import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { acquire, release, status, lockPath } from "./lock.ts";

// PIDs that won't exist on any sane machine. Picked high to avoid collision
// with real processes; verified at test setup time below.
const DEAD_PID = 999_999_999;

function setupRoot(): string {
  const root = mkTempDir();
  mkdirSync(join(root, ".tpm"), { recursive: true });
  return root;
}

function writeLockFile(root: string, pid: number, startedAt = "2026-01-01 00:00 PDT"): void {
  writeFileSync(lockPath(root), JSON.stringify({ pid, started_at: startedAt }, null, 2) + "\n");
}

test("acquire: creates lock file with our pid and a timestamp", () => {
  const root = setupRoot();
  try {
    const r = acquire(root);
    assert.equal(r.acquired, true);
    assert.equal(r.takeover, undefined);
    const data = JSON.parse(readFileSync(lockPath(root), "utf8"));
    assert.equal(data.pid, process.pid);
    assert.match(data.started_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+/);
  } finally {
    rmTempDir(root);
  }
});

test("acquire: refuses when lock held by a live pid", () => {
  const root = setupRoot();
  try {
    writeLockFile(root, process.pid);
    const r = acquire(root);
    assert.equal(r.acquired, false);
    assert.match(r.reason ?? "", new RegExp(`pid ${process.pid}`));
  } finally {
    rmTempDir(root);
  }
});

test("acquire: takes over a stale lock (dead pid)", () => {
  const root = setupRoot();
  try {
    // Sanity-check the dead PID is actually dead.
    let dead = false;
    try { process.kill(DEAD_PID, 0); } catch { dead = true; }
    assert.equal(dead, true, "expected DEAD_PID to be dead on this system");

    writeLockFile(root, DEAD_PID, "2026-01-01 00:00 PDT");
    const r = acquire(root);
    assert.equal(r.acquired, true);
    assert.equal(r.takeover, true);
    assert.equal(r.prior?.pid, DEAD_PID);
    const data = JSON.parse(readFileSync(lockPath(root), "utf8"));
    assert.equal(data.pid, process.pid);
  } finally {
    rmTempDir(root);
  }
});

test("acquire: takes over an unreadable/malformed lock file", () => {
  const root = setupRoot();
  try {
    writeFileSync(lockPath(root), "this is not json\n");
    const r = acquire(root);
    assert.equal(r.acquired, true);
    assert.equal(r.takeover, true);
    assert.equal(r.prior, undefined);
  } finally {
    rmTempDir(root);
  }
});

test("release: removes our own lock", () => {
  const root = setupRoot();
  try {
    acquire(root);
    const r = release(root);
    assert.equal(r.released, true);
    assert.equal(existsSync(lockPath(root)), false);
  } finally {
    rmTempDir(root);
  }
});

test("release: no-op when no lock file exists", () => {
  const root = setupRoot();
  try {
    const r = release(root);
    assert.equal(r.released, false);
    assert.match(r.message, /no lock file/);
  } finally {
    rmTempDir(root);
  }
});

test("release: refuses to remove a lock held by another live pid (without --force)", () => {
  const root = setupRoot();
  try {
    writeLockFile(root, process.pid + 0); // This process IS process.pid; use a sibling pid trick:
    // We need a pid that's "another live pid." Easiest: use the test process's parent pid (PPID).
    // But that's still us-ish. The cleanest fake: write our own pid then mutate it to ppid (assumed live).
    const ppid = process.ppid ?? process.pid;
    if (ppid === process.pid) {
      // No usable parent; skip the live-other-pid check by simulation.
      return;
    }
    writeLockFile(root, ppid);
    const r = release(root, false);
    assert.equal(r.released, false);
    assert.match(r.message, /held by another live pid/);
    assert.ok(existsSync(lockPath(root)), "lock should remain on disk after refusal");
  } finally {
    rmTempDir(root);
  }
});

test("release --force: removes the lock even when held by another live pid", () => {
  const root = setupRoot();
  try {
    const ppid = process.ppid ?? process.pid;
    writeLockFile(root, ppid);
    const r = release(root, true);
    assert.equal(r.released, true);
    assert.equal(existsSync(lockPath(root)), false);
  } finally {
    rmTempDir(root);
  }
});

test("release: removes a stale lock (dead pid) without --force", () => {
  const root = setupRoot();
  try {
    writeLockFile(root, DEAD_PID);
    const r = release(root, false);
    assert.equal(r.released, true);
    assert.equal(existsSync(lockPath(root)), false);
  } finally {
    rmTempDir(root);
  }
});

test("status: 'no lock' when no file", () => {
  const root = setupRoot();
  try {
    assert.equal(status(root), "no lock");
  } finally {
    rmTempDir(root);
  }
});

test("status: live lock", () => {
  const root = setupRoot();
  try {
    writeLockFile(root, process.pid, "2026-04-29 00:35 PDT");
    const s = status(root);
    assert.match(s, new RegExp(`pid=${process.pid}`));
    assert.match(s, /\(live\)/);
  } finally {
    rmTempDir(root);
  }
});

test("status: stale lock", () => {
  const root = setupRoot();
  try {
    writeLockFile(root, DEAD_PID, "2026-04-29 00:35 PDT");
    const s = status(root);
    assert.match(s, /\(stale\)/);
  } finally {
    rmTempDir(root);
  }
});
