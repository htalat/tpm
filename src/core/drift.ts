import { execFileSync } from "node:child_process";

export interface DriftResult {
  clean: boolean;
  reason?: string;
  branch?: string;
  expected?: string;
  repoLocal: string;
}

// Verify the repo at `repoLocal` is on its default branch with a clean working
// tree. Used by the unattended orchestrator before dispatching an agent: a
// dirty / off-branch tree gets inherited by the agent and produces surprising
// commits, so abort cleanly instead.
export function checkDrift(repoLocal: string): DriftResult {
  if (!isGitRepo(repoLocal)) {
    return { clean: false, reason: `${repoLocal} is not a git repository`, repoLocal };
  }
  const expected = defaultBranch(repoLocal);
  const current = currentBranch(repoLocal);
  if (current !== expected) {
    return {
      clean: false,
      reason: `not on default branch (on ${current}, expected ${expected})`,
      branch: current,
      expected,
      repoLocal,
    };
  }
  const dirty = run(repoLocal, ["status", "--porcelain"]).trim();
  if (dirty) {
    return {
      clean: false,
      reason: "working tree dirty (`git status --porcelain` non-empty)",
      branch: current,
      expected,
      repoLocal,
    };
  }
  return { clean: true, branch: current, expected, repoLocal };
}

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isGitRepo(cwd: string): boolean {
  try {
    run(cwd, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function defaultBranch(cwd: string): string {
  // The most reliable source: the symbolic ref pointing at origin/HEAD.
  // (`git remote set-head origin -a` populates it; many repos have it set.)
  try {
    const out = run(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    return out.replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

function currentBranch(cwd: string): string {
  try {
    return run(cwd, ["symbolic-ref", "--short", "HEAD"]).trim();
  } catch {
    // Detached HEAD: fall back to the short commit SHA.
    return run(cwd, ["rev-parse", "--short", "HEAD"]).trim();
  }
}
