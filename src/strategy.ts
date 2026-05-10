import { join } from "node:path";
import type { Project, Task } from "./tree.ts";

// `same_repo_strategy` controls how tpm coordinates two parallel agents
// claiming different tasks in the same `repo.local`:
//
//   serialize  — repo-level lock alongside each per-task lock. Only one task
//                runs against a repo at a time; siblings in other repos run
//                in parallel. Default; safe for any repo size.
//   worktree   — each claimed task gets its own `git worktree` checkout under
//                `<repo.local>/.git-worktrees/<flattened-slug>/`. Independent
//                branches, no collision. Opt-in: only useful for repos small
//                enough that N full working trees aren't a storage problem.
export type SameRepoStrategy = "serialize" | "worktree";
export const SAME_REPO_STRATEGIES: readonly SameRepoStrategy[] = ["serialize", "worktree"];
export const DEFAULT_SAME_REPO_STRATEGY: SameRepoStrategy = "serialize";

export function resolveSameRepoStrategy(project: Project): SameRepoStrategy {
  const v = project.data.same_repo_strategy;
  if (typeof v === "string" && (SAME_REPO_STRATEGIES as readonly string[]).includes(v)) {
    return v as SameRepoStrategy;
  }
  return DEFAULT_SAME_REPO_STRATEGY;
}

// Worktree dir name per task — flattened qualified slug, same convention as
// the lock file. Lives under `<repo.local>/.git-worktrees/`. Should be
// gitignored in the repo.
export function worktreePath(repoLocal: string, qualifiedSlug: string): string {
  const flattened = qualifiedSlug.replace(/\//g, "--");
  return join(repoLocal, ".git-worktrees", flattened);
}

// Branch name a worktree checks out: `tpm/<flattened-slug>`. Easy to spot in
// `git branch -a` and unlikely to collide with user-named branches.
export function worktreeBranch(qualifiedSlug: string): string {
  return `tpm/${qualifiedSlug.replace(/\//g, "--")}`;
}
