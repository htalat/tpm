import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrUrl, prCacheDir, readPrCache, writePrCache } from "./pr_cache.ts";

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "tpm-prcache-"));
}

test("parsePrUrl: GitHub URL routes via the github adapter", () => {
  assert.deepEqual(parsePrUrl("https://github.com/htalat/tpm/pull/50"), {
    host: "github",
    cachePath: "htalat/tpm/50.json",
    displayId: "#50",
  });
});

test("parsePrUrl: ADO URL routes via the ado adapter", () => {
  assert.deepEqual(parsePrUrl("https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/9"), {
    host: "ado",
    cachePath: "ado/myorg/myproj/myrepo/9.json",
    displayId: "!9",
  });
});

test("parsePrUrl: GitHub URL with trailing /files still parses", () => {
  assert.deepEqual(parsePrUrl("https://github.com/octo-org/some.repo/pull/7/files"), {
    host: "github",
    cachePath: "octo-org/some.repo/7.json",
    displayId: "#7",
  });
});

test("parsePrUrl: returns null for URLs no host claims", () => {
  assert.equal(parsePrUrl("https://github.com/htalat/tpm/issues/12"), null);
  assert.equal(parsePrUrl("https://gitlab.com/x/y/merge_requests/1"), null);
  assert.equal(parsePrUrl("not a url"), null);
  assert.equal(parsePrUrl(""), null);
});

test("writePrCache + readPrCache: round-trips a GitHub payload with fetchedAt + host", () => {
  const base = tmpBase();
  try {
    const url = "https://github.com/htalat/tpm/pull/42";
    const pr = { url, state: "OPEN", isDraft: false, reviewDecision: "APPROVED" };
    const at = new Date("2026-05-11T08:00:00.000Z");
    assert.equal(writePrCache(url, pr, { baseDir: base, now: () => at }), true);

    const file = join(prCacheDir(base), "htalat", "tpm", "42.json");
    assert.ok(existsSync(file));

    const entry = readPrCache(url, { baseDir: base });
    assert.ok(entry);
    assert.equal(entry!.fetchedAt, "2026-05-11T08:00:00.000Z");
    assert.equal(entry!.host, "github");
    assert.deepEqual(entry!.pr, pr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writePrCache + readPrCache: round-trips an ADO payload under ado/<org>/<project>/<repo>/<id>.json", () => {
  const base = tmpBase();
  try {
    const url = "https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/9";
    const pr = { pullRequestId: 9, status: "active", title: "Try it" };
    assert.equal(writePrCache(url, { pr }, { baseDir: base }), true);

    const file = join(prCacheDir(base), "ado", "myorg", "myproj", "myrepo", "9.json");
    assert.ok(existsSync(file));

    const entry = readPrCache(url, { baseDir: base });
    assert.ok(entry);
    assert.equal(entry!.host, "ado");
    assert.deepEqual(entry!.pr, { pr });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writePrCache: no-op (returns false) for a URL no host claims", () => {
  const base = tmpBase();
  try {
    assert.equal(writePrCache("https://gitlab.com/x/y/merge_requests/1", { state: "OPEN" }, { baseDir: base }), false);
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

test("readPrCache: legacy entry without host field defaults to host='github'", () => {
  // Cache files written before task 052 had no host field. The reader falls
  // back to the host inferred from the URL so old GitHub snapshots stay
  // readable across the rollout.
  const base = tmpBase();
  try {
    const url = "https://github.com/htalat/tpm/pull/1";
    const dir = join(prCacheDir(base), "htalat", "tpm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), JSON.stringify({
      fetchedAt: "2026-05-01T00:00:00Z",
      pr: { url, state: "OPEN" },
    }));
    const entry = readPrCache(url, { baseDir: base });
    assert.equal(entry?.host, "github");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readPrCache: returns null for a URL no host claims", () => {
  assert.equal(readPrCache("https://gitlab.com/whatever"), null);
});
