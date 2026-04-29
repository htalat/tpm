import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "./time.ts";

export interface LockData {
  pid: number;
  started_at: string;
}

export interface AcquireResult {
  acquired: boolean;
  reason?: string;
  takeover?: boolean; // true when we displaced a stale lock
  prior?: LockData;   // populated when reason or takeover refers to a prior holder
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
    const existing = readLock(path);
    if (existing && isLive(existing.pid)) {
      return {
        acquired: false,
        reason: `lock held by pid ${existing.pid} (started ${existing.started_at})`,
        prior: existing,
      };
    }
    // Stale lock (file exists but PID is dead, or the file is malformed): take over.
    writeLock(path, { pid: process.pid, started_at: now() });
    return { acquired: true, takeover: true, prior: existing ?? undefined };
  }
  writeLock(path, { pid: process.pid, started_at: now() });
  return { acquired: true };
}

export function release(root: string, force = false): ReleaseResult {
  const path = lockPath(root);
  if (!existsSync(path)) {
    return { released: false, message: "no lock file" };
  }
  if (!force) {
    const existing = readLock(path);
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
  const existing = readLock(path);
  if (!existing) return `lock file unreadable: ${path}`;
  const live = isLive(existing.pid);
  return `pid=${existing.pid} started=${existing.started_at} ${live ? "(live)" : "(stale)"}`;
}

function readLock(path: string): LockData | null {
  try {
    const text = readFileSync(path, "utf8");
    const data = JSON.parse(text);
    if (typeof data.pid !== "number" || typeof data.started_at !== "string") return null;
    return { pid: data.pid, started_at: data.started_at };
  } catch {
    return null;
  }
}

function writeLock(path: string, data: LockData): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we can't signal it — still alive.
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}
