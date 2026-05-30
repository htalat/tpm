# Contributing to the tpm CLI

This file is the workflow doc for tasks run **inside this repo** — building tpm itself. The tpm project's `project.md` points its `workflow:` at this file, so when an agent runs `tpm context <task>` for a tpm task, the briefing tells it to follow these rules. (`AGENTS.md` is the agent-neutral guide for *using* tpm in any repo — it's deliberately free of repo-specific shipping rules.)

## Validate before committing
- `npm test` must pass. The suite is fast (~200ms) and zero-dep — no excuse to skip.
- If you added new behavior, add a test for it first. Aim for tests that would catch a real regression, not one-line getter exercises.

## Ship via PR
Every change — behavior, docs, tests, comment edits — goes via PR. Branch off `main`, push, `gh pr create`. Append the PR URL to the task's `prs:` frontmatter list.

**Before cutting the feature branch, refresh `main`** (`git checkout main && git pull --ff-only`); on a dirty tree or non-fast-forward, `tpm block` the task instead of pushing through. The agent-neutral long form is in [`AGENTS.md`](AGENTS.md#start-a-task) step 4 — same rule, same reason: PR #120 hit the "branched off stale local main → conflict at merge time" failure mode, and the only clean way to avoid it is to never let it start.

## Wait for CI green before merge (humans only)
After pushing the PR, the `test` workflow runs against the branch. **Don't merge until it's green.** If it fails, fix the underlying issue (don't disable the check, don't merge anyway). `gh pr checks <PR>` polls the status from the terminal; the PR page surfaces it too.

**Agents: after `tpm pr`, your turn ends.** Don't run `gh pr checks` (or any CI poll) from inside an orchestrator-spawned run — that's the PR-signal poller's job (`tpm poll`), and burning the time bound waiting for CI is the canonical 050/053 failure mode. If CI fails, the poller flips the task to `needs-feedback` and the next orchestrator tick re-picks it.

## Closing the task
After opening the PR, run `tpm pr <slug> <url>` — the CLI flips status to `needs-review` automatically (your handoff to the human). **Don't stamp `done` on PR open.** After the PR merges, the poller closes it inline (per the task 045 close-out path); manual `/tpm done <task>` is the escape hatch if the auto-Outcome can't be derived.

The close-out action checks PR merge status before closing (asks once if not merged) and, after a merged close, switches back to `main`, pulls, and runs `git branch -d <branch>` locally — no prompt. The remote branch isn't deleted automatically; if GitHub's "auto-delete head branches" toggle isn't on for this repo, the agent surfaces a `git push origin --delete <branch>` one-liner for you to run.

## Commit hygiene
- Use a HEREDOC for multi-line commit messages so formatting survives.
- Commit messages explain *why*. The diff already shows *what*.

## Skill scoping

Two locations, decide deliberately. `skills/<name>/SKILL.md` is **user-scoped** — useful from any repo (e.g. `/tpm`); symlinked into `~/.claude/skills/` at setup. `.claude/skills/<name>/SKILL.md` is **repo-scoped** — only useful inside this repo (e.g. `/release`); auto-loaded by Claude Code when cwd is here, no symlink. If a new skill is useful outside the repo, user-scope it; otherwise repo-scope. Don't add a third category.
