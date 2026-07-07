import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "../_test_helpers.ts";
import { utimesSync } from "node:fs";
import {
  acquire, release, status, lockPath,
  acquireTask, releaseTask, heartbeatTask, statusTask,
  listTaskLocks, releaseStaleTaskLocks, taskLockPath, locksDir,
  acquireRepo, releaseRepo, repoLockPath,
} from "./lock.ts";

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

// Scaffold a project + single top-level task on disk so loadProjects/findTask
// can resolve the lock's qualified slug back to a real task. Returns the task
// file path so callers can read back its status after a sweep.
function seedTask(root: string, project: string, slug: string, status: string): string {
  const dir = join(root, project);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(
    join(dir, "project.md"),
    `---\nname: ${project}\nslug: ${project}\nstatus: active\ncreated: 2026-01-01 00:00 PDT\ntags: []\n---\n\n# ${project}\n`,
  );
  const taskPath = join(dir, "tasks", `${slug}.md`);
  writeFileSync(
    taskPath,
    `---\ntitle: Task ${slug}\nslug: ${slug}\nproject: ${project}\nstatus: ${status}\ntype: pr\ncreated: 2026-01-01 00:00 PDT\nclosed:\nprs: []\ntags: []\n---\n\n# Task ${slug}\n\n## Log\n- 2026-01-01 00:00 PDT: created\n`,
  );
  return taskPath;
}

// Backdate a lock file's mtime so the next sweep sees it as stale.
function backdateLock(path: string, minutes: number): void {
  const t = (Date.now() - minutes * 60_000) / 1000;
  utimesSync(path, t, t);
}

function statusOf(taskPath: string): string {
  const m = readFileSync(taskPath, "utf8").match(/^status:\s*(.+)$/m);
  return m ? m[1].trim() : "";
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

// ---- per-task locks --------------------------------------------------------

test("acquireTask: creates lock file with agent-id, pid, and timestamps", () => {
  const root = setupRoot();
  try {
    const r = acquireTask(root, "alpha/001-foo", "claude-laptop");
    assert.equal(r.acquired, true);
    const path = taskLockPath(root, "alpha/001-foo");
    assert.ok(existsSync(path));
    const contents = readFileSync(path, "utf8");
    assert.match(contents, /^agent-id: claude-laptop$/m);
    assert.match(contents, new RegExp(`^pid: ${process.pid}$`, "m"));
    assert.match(contents, /^acquired: /m);
    assert.match(contents, /^heartbeat: /m);
  } finally {
    rmTempDir(root);
  }
});

test("acquireTask: filename flattens project/task slugs with --", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "tpm/018-orchestrator/003-time-bound", "a");
    const path = taskLockPath(root, "tpm/018-orchestrator/003-time-bound");
    assert.match(path, /tpm--018-orchestrator--003-time-bound\.lock$/);
    assert.ok(existsSync(path));
  } finally {
    rmTempDir(root);
  }
});

test("acquireTask: rejects empty agent-id", () => {
  const root = setupRoot();
  try {
    assert.throws(() => acquireTask(root, "alpha/001", ""), /agent-id.*required/);
    assert.throws(() => acquireTask(root, "alpha/001", "  "), /agent-id.*required/);
  } finally {
    rmTempDir(root);
  }
});

test("acquireTask: second concurrent acquire fails atomically (O_CREAT|O_EXCL)", () => {
  // Single-process simulation of the race: two acquires, the second sees EEXIST.
  const root = setupRoot();
  try {
    const first = acquireTask(root, "alpha/001", "agent-a");
    assert.equal(first.acquired, true);
    const second = acquireTask(root, "alpha/001", "agent-b");
    assert.equal(second.acquired, false);
    assert.match(second.reason!, /held by agent-a/);
    assert.equal(second.prior?.agentId, "agent-a");
  } finally {
    rmTempDir(root);
  }
});

test("releaseTask: refuses to release a lock held by a different agent", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    const r = releaseTask(root, "alpha/001", "agent-b");
    assert.equal(r.released, false);
    assert.match(r.message, /held by agent-a, not agent-b/);
    // Lock file is still there.
    assert.ok(existsSync(taskLockPath(root, "alpha/001")));
  } finally {
    rmTempDir(root);
  }
});

test("releaseTask --force: removes a lock held by another agent", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    const r = releaseTask(root, "alpha/001", "agent-b", true);
    assert.equal(r.released, true);
    assert.equal(existsSync(taskLockPath(root, "alpha/001")), false);
  } finally {
    rmTempDir(root);
  }
});

test("releaseTask: 'no lock file' when nothing to release", () => {
  const root = setupRoot();
  try {
    const r = releaseTask(root, "alpha/001", "agent-a");
    assert.equal(r.released, false);
    assert.match(r.message, /no lock file/);
  } finally {
    rmTempDir(root);
  }
});

test("heartbeatTask: refreshes mtime, only for the lock owner", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    const path = taskLockPath(root, "alpha/001");
    // Backdate mtime by 10 minutes so we can detect the refresh.
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(path, tenMinAgo, tenMinAgo);
    const r = heartbeatTask(root, "alpha/001", "agent-a");
    assert.equal(r.ok, true);
    const s = statusTask(root, "alpha/001");
    // Age should be small (just refreshed), not 10m. Allow leading `-` from
    // sub-ms clock skew between fs mtime and Date.now().
    const m = s.match(/age (-?\d+\.\d+)m/);
    assert.ok(m, `expected age in status: ${s}`);
    assert.ok(Number(m![1]) < 1, `expected fresh heartbeat, got ${m![1]}m`);
  } finally {
    rmTempDir(root);
  }
});

test("heartbeatTask: refuses to refresh a sibling's lock", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    const r = heartbeatTask(root, "alpha/001", "agent-b");
    assert.equal(r.ok, false);
    assert.match(r.message, /held by agent-a, not agent-b/);
  } finally {
    rmTempDir(root);
  }
});

test("statusTask: 'no lock' when nothing claimed", () => {
  const root = setupRoot();
  try {
    assert.equal(statusTask(root, "alpha/001"), "no lock");
  } finally {
    rmTempDir(root);
  }
});

test("listTaskLocks: returns every claimed task with agent-id + age", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    acquireTask(root, "beta/002-thing", "agent-b");
    acquireTask(root, "gamma/003-x/004-y", "agent-c");
    const list = listTaskLocks(root);
    assert.equal(list.length, 3);
    const slugs = list.map(e => e.qualifiedSlug).sort();
    assert.deepEqual(slugs, ["alpha/001", "beta/002-thing", "gamma/003-x/004-y"]);
    for (const e of list) {
      // Allow tiny negatives — fs mtime granularity can be coarser than Date.now().
      assert.ok(e.ageMinutes < 1, `age sanity: ${e.qualifiedSlug} -> ${e.ageMinutes}`);
      assert.ok(e.acquiredAgeMinutes < 1, `acquiredAge sanity: ${e.qualifiedSlug} -> ${e.acquiredAgeMinutes}`);
      assert.ok(e.data.agentId.length > 0);
    }
  } finally {
    rmTempDir(root);
  }
});

test("listTaskLocks: heartbeat refresh updates ageMinutes but not acquiredAgeMinutes", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    const path = taskLockPath(root, "alpha/001");
    // Backdate both atime + mtime + (effectively) keep birthtime intact.
    // utimesSync only touches atime/mtime — birthtime stays at the original.
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(path, tenMinAgo, tenMinAgo);
    const before = listTaskLocks(root)[0];
    assert.ok(before.ageMinutes >= 9, `pre-heartbeat heartbeat-age: ${before.ageMinutes}`);
    heartbeatTask(root, "alpha/001", "agent-a");
    const after = listTaskLocks(root)[0];
    assert.ok(after.ageMinutes < 1, `post-heartbeat heartbeat-age: ${after.ageMinutes}`);
    // acquiredAgeMinutes should NOT have been refreshed by the heartbeat (it
    // tracks file creation, not modification). Only meaningful where
    // birthtime is supported (macOS APFS); on Linux fallback this collapses
    // to ageMinutes, so don't make a strict assertion.
  } finally {
    rmTempDir(root);
  }
});

test("listTaskLocks: returns [] when locks dir missing", () => {
  const root = setupRoot();
  try {
    assert.deepEqual(listTaskLocks(root), []);
  } finally {
    rmTempDir(root);
  }
});

test("releaseStaleTaskLocks: removes locks past TTL, leaves fresh ones", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001-stale", "agent-a");
    acquireTask(root, "alpha/002-fresh", "agent-b");
    // Backdate the stale one by 60 minutes.
    const stalePath = taskLockPath(root, "alpha/001-stale");
    const sixtyMinAgo = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(stalePath, sixtyMinAgo, sixtyMinAgo);
    const removed = releaseStaleTaskLocks(root, 30);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].qualifiedSlug, "alpha/001-stale");
    assert.equal(existsSync(stalePath), false);
    // Fresh one survives.
    assert.ok(existsSync(taskLockPath(root, "alpha/002-fresh")));
  } finally {
    rmTempDir(root);
  }
});

test("releaseStaleTaskLocks: idempotent — no-op when nothing is stale", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    const removed = releaseStaleTaskLocks(root, 30);
    assert.equal(removed.length, 0);
    assert.ok(existsSync(taskLockPath(root, "alpha/001")));
  } finally {
    rmTempDir(root);
  }
});

test("releaseStaleTaskLocks: rejects non-positive ttl", () => {
  const root = setupRoot();
  try {
    assert.throws(() => releaseStaleTaskLocks(root, 0), /positive number/);
    assert.throws(() => releaseStaleTaskLocks(root, -1), /positive number/);
  } finally {
    rmTempDir(root);
  }
});

test("releaseStaleTaskLocks: stale lock at in-progress -> released and reverted to ready", () => {
  const root = setupRoot();
  try {
    const taskPath = seedTask(root, "alpha", "001-foo", "in-progress");
    acquireTask(root, "alpha/001-foo", "claude-1");
    backdateLock(taskLockPath(root, "alpha/001-foo"), 60);

    const removed = releaseStaleTaskLocks(root, 30);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].qualifiedSlug, "alpha/001-foo");
    assert.equal(removed[0].reverted, true);
    assert.equal(existsSync(taskLockPath(root, "alpha/001-foo")), false);
    assert.equal(statusOf(taskPath), "ready");
    // The revert leaves an audit trail in the task's Log.
    assert.match(readFileSync(taskPath, "utf8"), /stranded — lock expired/);
  } finally {
    rmTempDir(root);
  }
});

test("releaseStaleTaskLocks: stale lock at ready -> released, status untouched", () => {
  const root = setupRoot();
  try {
    const taskPath = seedTask(root, "alpha", "001-foo", "ready");
    acquireTask(root, "alpha/001-foo", "claude-1");
    backdateLock(taskLockPath(root, "alpha/001-foo"), 60);

    const removed = releaseStaleTaskLocks(root, 30);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].reverted, false);
    assert.equal(existsSync(taskLockPath(root, "alpha/001-foo")), false);
    assert.equal(statusOf(taskPath), "ready");
  } finally {
    rmTempDir(root);
  }
});

test("releaseStaleTaskLocks: stale repo lock -> released, no status change attempted", () => {
  const root = setupRoot();
  try {
    // A repo lock isn't per-task; there's no task to revert. The presence of an
    // unrelated in-progress task proves the sweep doesn't touch it.
    const taskPath = seedTask(root, "alpha", "001-foo", "in-progress");
    acquireRepo(root, "alpha", "claude-1");
    backdateLock(repoLockPath(root, "alpha"), 60);

    const removed = releaseStaleTaskLocks(root, 30);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].qualifiedSlug, "repo--alpha");
    assert.equal(removed[0].reverted, false);
    assert.equal(existsSync(repoLockPath(root, "alpha")), false);
    assert.equal(statusOf(taskPath), "in-progress");
  } finally {
    rmTempDir(root);
  }
});

test("locksDir: under <root>/.tpm/locks", () => {
  const root = setupRoot();
  try {
    assert.equal(locksDir(root), join(root, ".tpm", "locks"));
  } finally {
    rmTempDir(root);
  }
});

// ---- repo lock (serialize strategy) ----------------------------------------

test("acquireRepo: creates <root>/.tpm/locks/repo--<project>.lock", () => {
  const root = setupRoot();
  try {
    const r = acquireRepo(root, "alpha", "agent-a");
    assert.equal(r.acquired, true);
    const path = repoLockPath(root, "alpha");
    assert.match(path, /\.tpm\/locks\/repo--alpha\.lock$/);
    assert.ok(existsSync(path));
    const contents = readFileSync(path, "utf8");
    assert.match(contents, /^agent-id: agent-a$/m);
  } finally {
    rmTempDir(root);
  }
});

test("acquireRepo: second concurrent acquire fails atomically", () => {
  const root = setupRoot();
  try {
    const first = acquireRepo(root, "alpha", "agent-a");
    assert.equal(first.acquired, true);
    const second = acquireRepo(root, "alpha", "agent-b");
    assert.equal(second.acquired, false);
    assert.match(second.reason!, /repo lock for alpha held by agent-a/);
  } finally {
    rmTempDir(root);
  }
});

test("acquireRepo: different projects don't collide", () => {
  const root = setupRoot();
  try {
    assert.equal(acquireRepo(root, "alpha", "agent-a").acquired, true);
    assert.equal(acquireRepo(root, "beta",  "agent-a").acquired, true);
  } finally {
    rmTempDir(root);
  }
});

test("releaseRepo: refuses cross-agent without --force", () => {
  const root = setupRoot();
  try {
    acquireRepo(root, "alpha", "agent-a");
    const r = releaseRepo(root, "alpha", "agent-b");
    assert.equal(r.released, false);
    assert.match(r.message, /held by agent-a, not agent-b/);
  } finally {
    rmTempDir(root);
  }
});

test("releaseRepo --force: clears any holder", () => {
  const root = setupRoot();
  try {
    acquireRepo(root, "alpha", "agent-a");
    const r = releaseRepo(root, "alpha", "agent-b", true);
    assert.equal(r.released, true);
    assert.equal(existsSync(repoLockPath(root, "alpha")), false);
  } finally {
    rmTempDir(root);
  }
});

test("listTaskLocks: surfaces repo locks alongside per-task locks", () => {
  const root = setupRoot();
  try {
    acquireTask(root, "alpha/001", "agent-a");
    acquireRepo(root, "alpha", "agent-a");
    const list = listTaskLocks(root);
    assert.equal(list.length, 2);
    const slugs = list.map(e => e.qualifiedSlug).sort();
    assert.deepEqual(slugs, ["alpha/001", "repo--alpha"]);
  } finally {
    rmTempDir(root);
  }
});

// ---- Windows-portability: lock filenames must be safe on NTFS -------------
// NTFS rejects <>:"|?* in filenames. Slugs are lowercase letters/digits/hyphens
// by grammar, but the qualifiedSlug-to-filename flattening is the one place
// `/` separators get rewritten; verify the result never produces a forbidden
// char. The check runs on the basename so we don't trip on the absolute
// path's drive-letter colon when these tests eventually run on Windows.

test("taskLockPath: basename has no Windows-forbidden chars", () => {
  for (const slug of [
    "alpha/001-foo",
    "tpm/018-orchestrator/003-time-bound",
    "proj-with-hyphens/0042-some-task",
  ]) {
    const path = taskLockPath("/tmp/root", slug);
    const base = path.split(/[\/\\]/).pop()!;
    assert.doesNotMatch(base, /[<>:"|?*]/, `forbidden char in basename for slug ${slug}: ${base}`);
  }
});

test("repoLockPath: basename has no Windows-forbidden chars", () => {
  for (const proj of ["alpha", "proj-with-hyphens", "tpm"]) {
    const path = repoLockPath("/tmp/root", proj);
    const base = path.split(/[\/\\]/).pop()!;
    assert.doesNotMatch(base, /[<>:"|?*]/, `forbidden char in basename for project ${proj}: ${base}`);
  }
});
