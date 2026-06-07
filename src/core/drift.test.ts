import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { checkDrift } from "./drift.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function setupRepo(): string {
  const dir = mkTempDir();
  git(dir, ["init", "--initial-branch=main", "--quiet"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial", "--quiet"]);
  return dir;
}

test("checkDrift: not a git repo -> not clean", () => {
  const dir = mkTempDir();
  try {
    const r = checkDrift(dir);
    assert.equal(r.clean, false);
    assert.match(r.reason ?? "", /not a git repository/);
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: clean tree on default branch -> clean", () => {
  const dir = setupRepo();
  try {
    const r = checkDrift(dir);
    assert.equal(r.clean, true, `expected clean; got: ${r.reason}`);
    assert.equal(r.branch, "main");
    assert.equal(r.expected, "main");
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: dirty tree on default branch -> not clean", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "README.md"), "modified\n");
    const r = checkDrift(dir);
    assert.equal(r.clean, false);
    assert.match(r.reason ?? "", /working tree dirty/);
    assert.equal(r.branch, "main");
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: untracked file counts as dirty", () => {
  const dir = setupRepo();
  try {
    writeFileSync(join(dir, "scratch.txt"), "ad-hoc\n");
    const r = checkDrift(dir);
    assert.equal(r.clean, false);
    assert.match(r.reason ?? "", /working tree dirty/);
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: on a feature branch -> not clean", () => {
  const dir = setupRepo();
  try {
    git(dir, ["checkout", "-b", "feature/foo", "--quiet"]);
    const r = checkDrift(dir);
    assert.equal(r.clean, false);
    assert.match(r.reason ?? "", /not on default branch/);
    assert.equal(r.branch, "feature/foo");
    assert.equal(r.expected, "main");
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: detached HEAD -> not clean (current is short SHA, not 'main')", () => {
  const dir = setupRepo();
  try {
    git(dir, ["checkout", "--detach", "--quiet"]);
    const r = checkDrift(dir);
    assert.equal(r.clean, false);
    assert.match(r.reason ?? "", /not on default branch/);
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: dirty + wrong branch surfaces the branch mismatch first", () => {
  const dir = setupRepo();
  try {
    git(dir, ["checkout", "-b", "feature/foo", "--quiet"]);
    writeFileSync(join(dir, "README.md"), "modified on feature\n");
    const r = checkDrift(dir);
    assert.equal(r.clean, false);
    assert.match(r.reason ?? "", /not on default branch/);
  } finally {
    rmTempDir(dir);
  }
});

test("checkDrift: respects origin/HEAD when set to a non-main default", () => {
  const dir = setupRepo();
  try {
    // Rename main -> trunk to simulate a non-default-named default branch.
    git(dir, ["branch", "-m", "trunk"]);
    // Create a fake origin remote pointing at this same dir, then set its HEAD.
    const remote = setupRepo();
    git(remote, ["branch", "-m", "trunk"]);
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["fetch", "origin", "--quiet"]);
    git(dir, ["remote", "set-head", "origin", "trunk"]);
    const r = checkDrift(dir);
    assert.equal(r.clean, true, `expected clean; got: ${r.reason}`);
    assert.equal(r.branch, "trunk");
    assert.equal(r.expected, "trunk");
    rmTempDir(remote);
  } finally {
    rmTempDir(dir);
  }
});
