import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSameRepoStrategy,
  worktreePath,
  worktreeBranch,
  DEFAULT_SAME_REPO_STRATEGY,
} from "./strategy.ts";
import type { Project } from "../tree.ts";

function project(extra: Record<string, unknown> = {}): Project {
  return {
    slug: "alpha",
    path: "/x/alpha/project.md",
    dir: "/x/alpha",
    data: { slug: "alpha", status: "active", ...extra },
    body: "",
    tasks: [],
  };
}

test("resolveSameRepoStrategy: defaults to serialize when absent", () => {
  assert.equal(resolveSameRepoStrategy(project()), "serialize");
  assert.equal(DEFAULT_SAME_REPO_STRATEGY, "serialize");
});

test("resolveSameRepoStrategy: accepts explicit serialize", () => {
  assert.equal(resolveSameRepoStrategy(project({ same_repo_strategy: "serialize" })), "serialize");
});

test("resolveSameRepoStrategy: accepts explicit worktree", () => {
  assert.equal(resolveSameRepoStrategy(project({ same_repo_strategy: "worktree" })), "worktree");
});

test("resolveSameRepoStrategy: ignores unknown values, falls back to default", () => {
  assert.equal(resolveSameRepoStrategy(project({ same_repo_strategy: "garbage" })), "serialize");
  assert.equal(resolveSameRepoStrategy(project({ same_repo_strategy: 42 })), "serialize");
  assert.equal(resolveSameRepoStrategy(project({ same_repo_strategy: null })), "serialize");
});

test("worktreePath: under repo.local/.git-worktrees/<flattened-slug>", () => {
  assert.equal(
    worktreePath("/Users/me/repo", "tpm/030-foo"),
    "/Users/me/repo/.git-worktrees/tpm--030-foo",
  );
  assert.equal(
    worktreePath("/repo", "tpm/018-parent/003-child"),
    "/repo/.git-worktrees/tpm--018-parent--003-child",
  );
});

test("worktreeBranch: tpm/<flattened-slug>", () => {
  assert.equal(worktreeBranch("tpm/030-foo"), "tpm/tpm--030-foo");
  assert.equal(worktreeBranch("alpha/001-bar"), "tpm/alpha--001-bar");
});
