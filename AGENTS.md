# Agent guide for tpm trees

If you (an AI coding agent) are dropped into a tpm tree, here's how to interact with it.

## Reading state
- Each project lives at `projects/<slug>/project.md` with YAML frontmatter (`name`, `slug`, `status`, `created`, `repo: {remote, local}`, `tags`) and markdown body (`## Goal`, `## Context`, `## Notes`).
- Each task lives at `projects/<slug>/tasks/NNN-<slug>.md` with frontmatter (`title`, `slug`, `project`, `status`, `type`, `created`, `closed`, `prs`, `tags`) and body (`## Context`, `## Plan`, `## Log`, `## Outcome`). Tasks inherit `repo` from their project unless they declare their own.
- Code work happens in `repo.local`. `tpm context` calls this out; `tpm path <target>` prints it for shell composition (`cd $(tpm path my-task)`).
- Statuses: `open | in-progress | blocked | done | dropped`. Types: `pr | investigation | spike | chore`.
- For an agent-friendly briefing on a single task, run `tpm context <task>` or `tpm context <project>/<task>`.

## Writing state
- Append progress to a task's `## Log` section as `- YYYY-MM-DD: <what happened>`.
- Set `status: in-progress` in the frontmatter when you start. Set `status: done`, fill `## Outcome`, and stamp `closed: YYYY-MM-DD` when finished.
- If you open a PR, append its URL to the `prs:` list.
- Surface blockers explicitly: set `status: blocked` and explain why in `## Log`.

## Don'ts
- Don't reformat unrelated frontmatter or rename slugs.
- Don't delete the `## Outcome` section even if empty — it's a closing prompt.
- Don't rewrite project goals without explicit approval.
