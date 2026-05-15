import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "./time.ts";

// ---- legacy global lock (one release of overlap; deprecated) ---------------
//
// The single global orchestrator lock. Superseded by per-task locks (below).
// Kept for one release with a deprecation warning printed by the CLI; remove
// when no caller invokes `tpm lock acquire` without a task argument.

export interface LockData {
  pid: number;
  started_at: string;
}

export interface AcquireResult {
  acquired: boolean;
  reason?: string;
  takeover?: boolean;
  prior?: LockData;
}

export interface ReleaseResult {
  released: boolean;
  message: string;
}

export function lockPath(root: string): string {
  return join(root, ".tpm", "orchestrator.lock");
}

export function acquire(root: string): AcquireResult {
  const path = lockPath(root);
  if (existsSync(path)) {
    const existing = readGlobalLock(path);
    if (existing && isLive(existing.pid)) {
      return {
        acquired: false,
        reason: `lock held by pid ${existing.pid} (started ${existing.started_at})`,
        prior: existing,
      };
    }
    writeGlobalLock(path, { pid: process.pid, started_at: now() });
    return { acquired: true, takeover: true, prior: existing ?? undefined };
  }
  writeGlobalLock(path, { pid: process.pid, started_at: now() });
  return { acquired: true };
}

export function release(root: string, force = false): ReleaseResult {
  const path = lockPath(root);
  if (!existsSync(path)) {
    return { released: false, message: "no lock file" };
  }
  if (!force) {
    const existing = readGlobalLock(path);
    if (existing && existing.pid !== process.pid && isLive(existing.pid)) {
      return {
        released: false,
        message: `lock held by another live pid ${existing.pid}; use --force to override`,
      };
    }
  }
  unlinkSync(path);
  return { released: true, message: "released" };
}

export function status(root: string): string {
  const path = lockPath(root);
  if (!existsSync(path)) return "no lock";
  const existing = readGlobalLock(path);
  if (!existing) return `lock file unreadable: ${path}`;
  const live = isLive(existing.pid);
  return `pid=${existing.pid} started=${existing.started_at} ${live ? "(live)" : "(stale)"}`;
}

function readGlobalLock(path: string): LockData | null {
  try {
    const text = readFileSync(path, "utf8");
    const data = JSON.parse(text);
    if (typeof data.pid !== "number" || typeof data.started_at !== "string") return null;
    return { pid: data.pid, started_at: data.started_at };
  } catch {
    return null;
  }
}

function writeGlobalLock(path: string, data: LockData): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// ---- per-task locks (the v2 model) -----------------------------------------

export interface TaskLockData {
  agentId: string;
  pid: number;
  acquired: string;
  heartbeat: string;
}

export interface TaskAcquireResult {
  acquired: boolean;
  reason?: string;
  prior?: TaskLockData;
}

export interface TaskLockEntry {
  qualifiedSlug: string;
  path: string;
  data: TaskLockData;
  // Both ages in minutes. `acquiredAgeMinutes` from file birthtime (creation
  // time, set once on acquire); `ageMinutes` from mtime (refreshed every
  // heartbeat). On filesystems without birthtime, acquiredAgeMinutes falls
  // back to ageMinutes.
  acquiredAgeMinutes: number;
  ageMinutes: number;
}

export function locksDir(root: string): string {
  return join(root, ".tpm", "locks");
}

export function taskLockPath(root: string, qualifiedSlug: string): string {
  // Flatten `<project>/<task>` or `<project>/<parent>/<child>` to a single
  // filename. The slug grammar (lowercase letters, digits, single hyphens)
  // means `--` is a safe separator that can't collide with a slug.
  const flattened = qualifiedSlug.replace(/\//g, "--");
  return join(locksDir(root), `${flattened}.lock`);
}

// Repo-level lock for the `serialize` same-repo strategy. Lives alongside
// per-task locks; lock-file format is identical so `tpm lock list` surfaces
// it the same way. Slug is `repo--<project>` so it sorts naturally with
// per-task locks for the same project.
export function repoLockPath(root: string, projectSlug: string): string {
  return join(locksDir(root), `repo--${projectSlug}.lock`);
}

export function acquireRepo(root: string, projectSlug: string, agentId: string): TaskAcquireResult {
  if (!agentId || !agentId.trim()) {
    throw new Error("tpm lock: --as <agent-id> is required for repo lock");
  }
  const path = repoLockPath(root, projectSlug);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = now();
  const body = renderTaskLock({
    agentId: agentId.trim(),
    pid: process.pid,
    acquired: stamp,
    heartbeat: stamp,
  });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const prior = readTaskLock(path);
      const reason = prior
        ? `repo lock for ${projectSlug} held by ${prior.agentId} (pid ${prior.pid})`
        : `repo lock file exists: ${path}`;
      return { acquired: false, reason, prior: prior ?? undefined };
    }
    throw e;
  }
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return { acquired: true };
}

export function releaseRepo(root: string, projectSlug: string, agentId: string, force = false): ReleaseResult {
  const path = repoLockPath(root, projectSlug);
  if (!existsSync(path)) return { released: false, message: "no repo lock file" };
  if (!force) {
    if (!agentId || !agentId.trim()) {
      throw new Error("tpm lock release-repo: --as <agent-id> is required (or use --force)");
    }
    const existing = readTaskLock(path);
    if (existing && existing.agentId !== agentId.trim()) {
      return {
        released: false,
        message: `repo lock for ${projectSlug} held by ${existing.agentId}, not ${agentId.trim()}`,
      };
    }
  }
  unlinkSync(path);
  return { released: true, message: "released" };
}

// Atomic acquire via O_CREAT | O_EXCL. The first writer wins; subsequent
// callers see EEXIST and report the existing holder.
export function acquireTask(root: string, qualifiedSlug: string, agentId: string): TaskAcquireResult {
  if (!agentId || !agentId.trim()) {
    throw new Error("tpm lock: --as <agent-id> is required (or set TPM_AGENT_ID)");
  }
  const path = taskLockPath(root, qualifiedSlug);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = now();
  const body = renderTaskLock({
    agentId: agentId.trim(),
    pid: process.pid,
    acquired: stamp,
    heartbeat: stamp,
  });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const prior = readTaskLock(path);
      const reason = prior
        ? `lock held by ${prior.agentId} (pid ${prior.pid}, acquired ${prior.acquired})`
        : `lock file exists: ${path}`;
      return { acquired: false, reason, prior: prior ?? undefined };
    }
    throw e;
  }
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return { acquired: true };
}

export function releaseTask(
  root: string,
  qualifiedSlug: string,
  agentId: string,
  force = false,
): ReleaseResult {
  const path = taskLockPath(root, qualifiedSlug);
  if (!existsSync(path)) return { released: false, message: "no lock file" };
  if (!force) {
    if (!agentId || !agentId.trim()) {
      throw new Error("tpm lock release: --as <agent-id> is required (or use --force)");
    }
    const existing = readTaskLock(path);
    if (existing && existing.agentId !== agentId.trim()) {
      return {
        released: false,
        message: `lock held by ${existing.agentId}, not ${agentId.trim()}; use --force to override`,
      };
    }
  }
  unlinkSync(path);
  return { released: true, message: "released" };
}

// Heartbeat refreshes the `heartbeat:` timestamp so stale-lock detection
// doesn't reclaim a long-running task. No-op (returns released=false) if the
// lock isn't ours — heartbeat must never silently take over a sibling's lock.
export function heartbeatTask(
  root: string,
  qualifiedSlug: string,
  agentId: string,
): { ok: boolean; message: string } {
  if (!agentId || !agentId.trim()) {
    throw new Error("tpm lock heartbeat: --as <agent-id> is required");
  }
  const path = taskLockPath(root, qualifiedSlug);
  if (!existsSync(path)) return { ok: false, message: "no lock file" };
  const existing = readTaskLock(path);
  if (!existing) return { ok: false, message: `lock file unreadable: ${path}` };
  if (existing.agentId !== agentId.trim()) {
    return { ok: false, message: `lock held by ${existing.agentId}, not ${agentId.trim()}` };
  }
  existing.heartbeat = now();
  writeFileSync(path, renderTaskLock(existing));
  return { ok: true, message: "heartbeat" };
}

// Cheap "is anyone holding this lock right now?" — just an existsSync. Used by
// queue selection to admit stranded in-progress tasks (status didn't flip out
// on agent exit but the lock did get released). Unlike `statusTask`, no read or
// parse of the file body. Stale locks aren't filtered out here: callers that
// care about TTL should run `releaseStaleTaskLocks` first.
export function hasTaskLock(root: string, qualifiedSlug: string): boolean {
  return existsSync(taskLockPath(root, qualifiedSlug));
}

export function statusTask(root: string, qualifiedSlug: string): string {
  const path = taskLockPath(root, qualifiedSlug);
  if (!existsSync(path)) return "no lock";
  const existing = readTaskLock(path);
  if (!existing) return `lock file unreadable: ${path}`;
  const age = lockAgeMinutes(path);
  return `agent-id=${existing.agentId} pid=${existing.pid} acquired=${existing.acquired} heartbeat=${existing.heartbeat} (age ${age.toFixed(1)}m)`;
}

export function listTaskLocks(root: string): TaskLockEntry[] {
  const dir = locksDir(root);
  if (!existsSync(dir)) return [];
  const out: TaskLockEntry[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".lock")) continue;
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    const data = readTaskLock(path);
    if (!data) continue;
    const stem = entry.replace(/\.lock$/, "");
    // Keep `repo--<project>` literal so it reads distinctly from task slugs;
    // task slug filenames (`<project>--<task>` etc.) un-flatten back to slashes.
    const slug = stem.startsWith("repo--") ? stem : stem.replace(/--/g, "/");
    out.push({
      qualifiedSlug: slug,
      path,
      data,
      ageMinutes: lockAgeMinutes(path),
      acquiredAgeMinutes: lockAcquiredAgeMinutes(path),
    });
  }
  return out;
}

// Walk the locks dir and remove anything whose heartbeat hasn't been touched
// in `ttlMinutes`. Idempotent: safe to call on every orchestrator startup as a
// hygiene step before the agent attempts its own claim.
export function releaseStaleTaskLocks(root: string, ttlMinutes: number): TaskLockEntry[] {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new Error("releaseStaleTaskLocks: ttlMinutes must be a positive number");
  }
  const removed: TaskLockEntry[] = [];
  for (const entry of listTaskLocks(root)) {
    if (entry.ageMinutes > ttlMinutes) {
      try {
        unlinkSync(entry.path);
        removed.push(entry);
      } catch {
        // Race with another process clearing the same lock; ignore.
      }
    }
  }
  return removed;
}

// ---- internals -------------------------------------------------------------

function readTaskLock(path: string): TaskLockData | null {
  try {
    const text = readFileSync(path, "utf8");
    const out: Partial<TaskLockData> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^([a-zA-Z_-]+):\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2];
      if (key === "agent-id") out.agentId = value;
      else if (key === "pid") out.pid = Number(value);
      else if (key === "acquired") out.acquired = value;
      else if (key === "heartbeat") out.heartbeat = value;
    }
    if (typeof out.agentId !== "string" || !out.agentId
        || typeof out.pid !== "number" || !Number.isFinite(out.pid)
        || typeof out.acquired !== "string"
        || typeof out.heartbeat !== "string") {
      return null;
    }
    return out as TaskLockData;
  } catch {
    return null;
  }
}

function renderTaskLock(data: TaskLockData): string {
  return [
    `agent-id: ${data.agentId}`,
    `pid: ${data.pid}`,
    `acquired: ${data.acquired}`,
    `heartbeat: ${data.heartbeat}`,
    "",
  ].join("\n");
}

// Use the lock file's mtime as the authoritative "last heartbeat" — it's
// updated on every write (acquire and heartbeat), it's monotonic, and it
// avoids parsing the human-readable timestamp inside the file. The
// `heartbeat:` field stays in the file for diagnostic readability.
function lockAgeMinutes(path: string): number {
  try {
    const mtime = statSync(path).mtimeMs;
    return (Date.now() - mtime) / 60_000;
  } catch {
    return Infinity;
  }
}

// File birthtime: creation time, set once on acquire. macOS APFS exposes it
// reliably; some Linux filesystems return 0. Fall back to mtime when birthtime
// is unavailable so the column always renders something useful.
function lockAcquiredAgeMinutes(path: string): number {
  try {
    const st = statSync(path);
    const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return (Date.now() - birth) / 60_000;
  } catch {
    return Infinity;
  }
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}
