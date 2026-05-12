// Persistent cache of `gh pr view --json` snapshots, keyed by PR URL.
//
// Why this exists: the PR-signal poller (scripts/recurring/check-pr-signal.sh)
// already fetches per-PR JSON every poll tick. `tpm serve`'s task page wants to
// show that state (open/merged, CI, review, mergeable) without blocking the
// render on a 0.5-2s `gh` network call. So the poller writes each snapshot here
// and the renderer reads it back — stale-while-revalidate, with max staleness
// bounded by the poll interval.
//
// Layout: <CONFIG_DIR>/pr-cache/<owner>/<repo>/<number>.json, mirroring the
// GitHub URL structure. Each file: { fetchedAt: <ISO 8601>, pr: <gh json> }.
// v0 only handles GitHub PR URLs; non-GitHub URLs (ADO, issue links, typos)
// are a no-op on write and a cache miss on read.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import type { RawPrJson } from "./pr_signal.ts";

export interface PrCacheEntry {
  fetchedAt: string; // ISO 8601 — when the poller last fetched this PR
  pr: RawPrJson; // raw `gh pr view --json <PR_JSON_FIELDS>` payload
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

// Parse a GitHub PR URL into (owner, repo, number). Returns null for anything
// that doesn't look like a GitHub PR URL — callers fall back to a no-data
// placeholder.
export function parsePrUrl(url: string): PrRef | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function prCacheDir(baseDir: string = CONFIG_DIR): string {
  return resolve(baseDir, "pr-cache");
}

function cacheFilePath(ref: PrRef, baseDir: string): string {
  return join(prCacheDir(baseDir), ref.owner, ref.repo, `${ref.number}.json`);
}

// Persist a `gh pr view --json` payload. Returns false (no-op) when the URL
// isn't a parseable GitHub PR URL. Best-effort: callers should not let a cache
// write failure abort the poll. `now` is injectable for tests.
export function writePrCache(
  url: string,
  pr: RawPrJson,
  opts: { baseDir?: string; now?: () => Date } = {},
): boolean {
  const ref = parsePrUrl(url);
  if (!ref) return false;
  const baseDir = opts.baseDir ?? CONFIG_DIR;
  const file = cacheFilePath(ref, baseDir);
  mkdirSync(dirname(file), { recursive: true });
  const entry: PrCacheEntry = {
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    pr,
  };
  writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
  return true;
}

// Read a cached snapshot. Returns null on cache miss, non-GitHub URL, or an
// unparseable / malformed file — the renderer then shows a placeholder. Never
// throws.
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
    return { fetchedAt: obj.fetchedAt, pr: obj.pr as RawPrJson };
  } catch {
    return null;
  }
}
