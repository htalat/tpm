// Persistent cache of host-native PR snapshots, keyed by PR URL.
//
// Why this exists: the PR-signal poller (scripts/recurring/check-pr-signal.sh)
// already fetches per-PR JSON every poll tick. `tpm serve`'s task page wants
// to show that state (open/merged, CI, review, mergeable) without blocking
// the render on a 0.5-2s `gh` / `az` network call. So the poller writes each
// snapshot here and the renderer reads it back — stale-while-revalidate,
// with max staleness bounded by the poll interval.
//
// Layout: <CONFIG_DIR>/pr-cache/<host-namespaced-path>
//   github → <owner>/<repo>/<number>.json
//   ado    → ado/<org>/<project>/<repo>/<id>.json
//   ...    → whatever cachePath the adapter returns
// GitHub keeps its existing flat layout (no `github/` prefix) so v0
// snapshots stay readable across the rollout.
//
// Each file: { fetchedAt: <ISO 8601>, host: <name>, pr: <wire JSON> }.
// `host` was added in task 052; reads without it default to 'github' so old
// cache files keep working until the poller overwrites them next tick.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { hostFor } from "./pr_signal.ts";
import type { PrRef } from "./hosts/types.ts";

export interface PrCacheEntry {
  fetchedAt: string;        // ISO 8601 — when the poller last fetched this PR
  host: string;             // 'github' | 'ado' | ... — see src/hosts/<name>.ts
  pr: unknown;              // raw host-native payload — shape depends on host
}

// Parse a PR URL via the host registry. Returns the ref (host + cachePath +
// short displayId) or null when no host claims the URL — callers fall back
// to a no-data placeholder.
export function parsePrUrl(url: string): PrRef | null {
  const host = hostFor(url);
  if (!host) return null;
  return host.parse(url);
}

export function prCacheDir(baseDir: string = CONFIG_DIR): string {
  return resolve(baseDir, "pr-cache");
}

function cacheFilePath(ref: PrRef, baseDir: string): string {
  return join(prCacheDir(baseDir), ref.cachePath);
}

export interface WriteOpts {
  baseDir?: string;
  now?: () => Date;
  host?: string; // override the host inferred from the URL (defensive — usually inferred)
}

// Persist a wire payload for the given PR URL. Returns false (no-op) when no
// host adapter claims the URL. Best-effort: callers should not let a cache
// write failure abort the poll. `now` and `host` are injectable for tests.
export function writePrCache(url: string, pr: unknown, opts: WriteOpts = {}): boolean {
  const ref = parsePrUrl(url);
  if (!ref) return false;
  const baseDir = opts.baseDir ?? CONFIG_DIR;
  const file = cacheFilePath(ref, baseDir);
  mkdirSync(dirname(file), { recursive: true });
  const entry: PrCacheEntry = {
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    host: opts.host ?? ref.host,
    pr,
  };
  writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
  return true;
}

// Read a cached snapshot. Returns null on cache miss, unrecognized URL, or a
// malformed file — the renderer then shows a placeholder. Never throws.
// Files written before the host field existed default to host='github'.
export function readPrCache(url: string, opts: { baseDir?: string } = {}): PrCacheEntry | null {
  const ref = parsePrUrl(url);
  if (!ref) return null;
  const baseDir = opts.baseDir ?? CONFIG_DIR;
  const file = cacheFilePath(ref, baseDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.fetchedAt !== "string") return null;
    if (!obj.pr || typeof obj.pr !== "object") return null;
    const host = typeof obj.host === "string" && obj.host.length ? obj.host : ref.host;
    return { fetchedAt: obj.fetchedAt, host, pr: obj.pr };
  } catch {
    return null;
  }
}
