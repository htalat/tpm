# Contributing to the tpm CLI

This file is the workflow doc for tasks run **inside this repo** — building tpm itself. The tpm project's `project.md` points its `workflow:` at this file, so when an agent runs `tpm context <task>` for a tpm task, the briefing tells it to follow these rules. (`AGENTS.md` is the agent-neutral guide for *using* tpm in any repo — it's deliberately free of repo-specific shipping rules.)

## Validate before committing
- `npm test` must pass. The suite is fast (~200ms) and zero-dep — no excuse to skip.
- If you added new behavior, add a test for it first. Aim for tests that would catch a real regression, not one-line getter exercises.

## Ship via PR
Every change — behavior, docs, tests, comment edits — goes via PR. Branch off `main`, push, `gh pr create`. Append the PR URL to the task's `prs:` frontmatter list.

## Wait for CI green before merge
After pushing the PR, the `test` workflow runs against the branch. **Don't merge until it's green.** If it fails, fix the underlying issue (don't disable the check, don't merge anyway). `gh pr checks <PR>` polls the status from the terminal; the PR page surfaces it too.

## Closing the task
Leave the task as `in-progress` after opening the PR. **Don't stamp `done` on PR open.** After the PR merges, run the **close out** action (`/tpm done <task>` in Claude Code) to close + archive.

The close-out action checks PR merge status before closing (asks once if not merged) and, after a merged close, switches back to `main`, pulls, and runs `git branch -d <branch>` locally — no prompt. The remote branch isn't deleted automatically; if GitHub's "auto-delete head branches" toggle isn't on for this repo, the agent surfaces a `git push origin --delete <branch>` one-liner for you to run.

## Commit hygiene
- Use a HEREDOC for multi-line commit messages so formatting survives.
- Commit messages explain *why*. The diff already shows *what*.

## Skill scoping

Two locations, decide deliberately. `skills/<name>/SKILL.md` is **user-scoped** — useful from any repo (e.g. `/tpm`); symlinked into `~/.claude/skills/` at setup. `.claude/skills/<name>/SKILL.md` is **repo-scoped** — only useful inside this repo (e.g. `/release`); auto-loaded by Claude Code when cwd is here, no symlink. If a new skill is useful outside the repo, user-scope it; otherwise repo-scope. Don't add a third category.
