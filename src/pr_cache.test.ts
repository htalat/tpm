import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrUrl, prCacheDir, readPrCache, writePrCache } from "./pr_cache.ts";

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "tpm-prcache-"));
}

test("parsePrUrl: extracts owner/repo/number from a GitHub PR URL", () => {
  assert.deepEqual(parsePrUrl("https://github.com/htalat/tpm/pull/50"), {
    owner: "htalat", repo: "tpm", number: 50,
  });
  // Trailing path segments (e.g. /files) don't break it.
  assert.deepEqual(parsePrUrl("https://github.com/octo-org/some.repo/pull/7/files"), {
    owner: "octo-org", repo: "some.repo", number: 7,
  });
});

test("parsePrUrl: returns null for non-GitHub-PR URLs", () => {
  assert.equal(parsePrUrl("https://dev.azure.com/org/proj/_git/repo/pullrequest/9"), null);
  assert.equal(parsePrUrl("https://github.com/htalat/tpm/issues/12"), null);
  assert.equal(parsePrUrl("not a url"), null);
  assert.equal(parsePrUrl(""), null);
});

test("writePrCache + readPrCache: round-trips the gh payload with a fetchedAt stamp", () => {
  const base = tmpBase();
  try {
    const url = "https://github.com/htalat/tpm/pull/42";
    const pr = { url, state: "OPEN", isDraft: false, reviewDecision: "APPROVED" };
    const at = new Date("2026-05-11T08:00:00.000Z");
    assert.equal(writePrCache(url, pr, { baseDir: base, now: () => at }), true);

    // File landed at the mirrored path.
    const file = join(prCacheDir(base), "htalat", "tpm", "42.json");
    assert.ok(existsSync(file));

    const entry = readPrCache(url, { baseDir: base });
    assert.ok(entry);
    assert.equal(entry!.fetchedAt, "2026-05-11T08:00:00.000Z");
    assert.deepEqual(entry!.pr, pr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writePrCache: no-op (returns false) for a non-GitHub PR URL", () => {
  const base = tmpBase();
  try {
    assert.equal(writePrCache("https://dev.azure.com/x/y/_git/z/pullrequest/1", { state: "OPEN" }, { baseDir: base }), false);
    assert.ok(!existsSync(prCacheDir(base)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPrCache: returns null on cache miss", () => {
  const base = tmpBase();
  try {
    assert.equal(readPrCache("https://github.com/htalat/tpm/pull/999", { baseDir: base }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPrCache: returns null (never throws) on a corrupt or malformed cache file", () => {
  const base = tmpBase();
  try {
    const dir = join(prCacheDir(base), "htalat", "tpm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), "{ not json");
    assert.equal(readPrCache("https://github.com/htalat/tpm/pull/1", { baseDir: base }), null);

    writeFileSync(join(dir, "2.json"), JSON.stringify({ pr: { state: "OPEN" } })); // missing fetchedAt
    assert.equal(readPrCache("https://github.com/htalat/tpm/pull/2", { baseDir: base }), null);

    writeFileSync(join(dir, "3.json"), JSON.stringify({ fetchedAt: "2026-05-11T00:00:00Z" })); // missing pr
    assert.equal(readPrCache("https://github.com/htalat/tpm/pull/3", { baseDir: base }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPrCache: returns null for a non-GitHub PR URL", () => {
  assert.equal(readPrCache("https://example.com/whatever"), null);
});
