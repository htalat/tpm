# Agent guide for tpm trees

If you (an AI coding agent) are dropped into a tpm tree, here's how to interact with it.

## Reading state
- Each project lives at `projects/<slug>/project.md` with YAML frontmatter (`name`, `slug`, `status`, `created`, `repo: {remote, local}`, `tags`) and markdown body (`## Goal`, `## Context`, `## Notes`).
- Each active task lives at `projects/<slug>/tasks/NNN-<slug>.md`; archived tasks live at `projects/<slug>/tasks/archive/NNN-<slug>.md`. Both use frontmatter (`title`, `slug`, `project`, `status`, `type`, `created`, `closed`, `prs`, `tags`) and body (`## Context`, `## Plan`, `## Log`, `## Outcome`). Tasks inherit `repo` from their project unless they declare their own.
- Code work happens in `repo.local`. `tpm context` calls this out; `tpm path <target>` prints it for shell composition (`cd $(tpm path my-task)`).
- Statuses: `open | ready | in-progress | blocked | done | dropped`. Types: `pr | investigation | spike | chore`.
  - `open` = author's queue (not yet specified for an agent). `ready` = agent's queue (Plan is well-formed, an agent can pick it up).
- For an agent-friendly briefing on a single task, run `tpm context <task>` or `tpm context <project>/<task>`.

## Writing state
- Append progress to a task's `## Log` section as `- YYYY-MM-DD: <what happened>`.
- Set `status: in-progress` in the frontmatter when you start. Set `status: done`, fill `## Outcome`, stamp `closed: YYYY-MM-DD`, then run `tpm archive <task>` when finished.
- If you open a PR, append its URL to the `prs:` list.
- Surface blockers explicitly: set `status: blocked` and explain why in `## Log`.

## Don'ts
- Don't reformat unrelated frontmatter or rename slugs.
- Don't delete the `## Outcome` section even if empty — it's a closing prompt.
- Don't rewrite project goals without explicit approval.

## Workflow

This section is the workflow doc that the tpm skill resolves to when working on the **tpm CLI repo itself** (i.e., a `/tpm <task>` run inside `/Users/htalat/Developer/tpm`). Other repos have their own `AGENTS.md` / `CLAUDE.md` / `workflow:` pointer; tpm doesn't dictate.

### Validate before committing
- `npm test` must pass. The suite is fast (~200ms) and zero-dep — no excuse to skip.
- If you added new behavior, add a test for it first. Aim for tests that would catch a real regression, not one-line getter exercises.

### Ship via PR
Every change — behavior, docs, tests, comment edits — goes via PR. Branch off `main`, push, `gh pr create`. Append the PR URL to the task's `prs:` frontmatter list.

### Wait for CI green before merge
After pushing the PR, the `test` workflow runs against the branch. **Don't merge until it's green.** If it fails, fix the underlying issue (don't disable the check, don't merge anyway). `gh pr checks <PR>` polls the status from the terminal; the PR page surfaces it too.

### Closing the task
Leave the task as `in-progress` after opening the PR. **Don't stamp `done` on PR open.** After the PR merges, run `/tpm done <task>` to close + archive.

### Commit hygiene
- Use a HEREDOC for multi-line commit messages so formatting survives.
- Commit messages explain *why*. The diff already shows *what*.
