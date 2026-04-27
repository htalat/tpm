# Agent guide for tpm

If you (an AI coding agent) are working with `tpm` — reading state from a tpm tree, executing a task on behalf of the user, scaffolding new work — start here.

This doc is the canonical, agent-neutral guide for **using tpm**. It's deliberately scope-free of any specific repo's shipping rules: each repo has its own workflow doc (`AGENTS.md` / `CLAUDE.md` / a `workflow:` pointer in `project.md`), and the action procedures below tell you to resolve and follow that workflow when shipping. So this file is safe to symlink or copy into other repos as ambient context — it won't bleed this repo's `npm test`/PR conventions into theirs.

The Claude Code dispatch surface (`/tpm`, `/tpm discuss`, …) lives in `skills/tpm/SKILL.md`; it mirrors the action procedures below. Agents that don't have slash commands (Codex CLI, GitHub Copilot, plain SDK loops) follow these procedures directly when the user asks for the equivalent action in natural language. See `docs/agents/` for per-agent setup.

For shipping rules specific to **this repo** (the tpm CLI itself), see `CONTRIBUTING.md`.

## CLI cheatsheet

```
tpm root                                            print the tree root
tpm ls [--all] [--archived] [--flat] [--status open|ready|in-progress|blocked|done|dropped] [--project <slug>]
tpm context <task | project/task | parent/child>    full briefing (file path, project goal, body, working agreement)
tpm path <project | task | project/task>            print local repo checkout
tpm archive <task | project/task>                   move a done/dropped task (or whole folder-form parent) to tasks/archive/
tpm fold <task | project/task>                      promote a file-form task to folder-form (idempotent)
tpm next [--project <slug>] [--autonomous]          print the next ready leaf task (oldest first)
tpm new project <slug> [--name "..."] [--repo <url>] [--path <local-dir>]
tpm new task <project> <slug> [--title "..."] [--parent <parent-slug>]
tpm report [--md]                                   reports/index.html
tpm now                                             timestamp in the configured timezone
tpm init [<dir>]                                    bootstrap a tree (default ~/tpm)
```

## Schema

- **Project frontmatter**: `name, slug, status, created, repo: {remote, local}, tags`
- **Task frontmatter**: `title, slug, project, status, type, created, closed, prs, tags` (inherits `repo` from project; can override by adding own `repo:` block). Optional `parent: <parent-slug>` marks the task as a child within a folder-form parent.
- **Task shapes**:
  - **File form** (default): `tasks/NNN-slug.md`. Single file.
  - **Folder form**: `tasks/NNN-slug/task.md` plus optional `NNN-<sub>.md` siblings (each with `parent: NNN-slug` in frontmatter) and any other files (scratch notes, screenshots, design docs). The directory name is the parent's slug.
- A task with any children is a **container**: not actionable, never returned by `tpm next`, can't be discussed/started directly.
- **Statuses**: `open | ready | in-progress | blocked | done | dropped`
  - `open` = author's queue (not yet shaped for an agent).
  - `ready` = agent's queue (Plan is well-specified, an agent can pick it up). Promoted via the **shape an open task** action.
  - Parent containers display a roll-up status (all children done → done; any in-progress → in-progress; else parent's declared status). The roll-up is display only — never written to frontmatter.
- **Types**: `pr | investigation | spike | chore`
- **Task body**: `## Context`, `## Plan`, `## Log`, `## Outcome`
- Code work happens in `repo.local`. `tpm context` calls this out; `tpm path <target>` prints it for shell composition (`cd $(tpm path my-task)`).
- For an agent-friendly briefing on a single task, run `tpm context <task>` or `tpm context <project>/<task>`.

## Slug resolution

- A bare slug works when it's globally unambiguous (e.g., `017-hierarchical-tasks` or `hierarchical-tasks`).
- If a bare slug matches multiple tasks (e.g., two children named `discuss` under different parents), the CLI errors and asks you to qualify it.
- Qualified forms: `<project>/<task>`, `<parent>/<child>`, `<project>/<parent>/<child>`. Use whichever disambiguates.

## Actions

When the user asks for one of these — by slash command, natural language, or a CLI invocation — follow the procedure. The Claude Code skill (`skills/tpm/SKILL.md`) maps slash commands to these same actions.

### Situational awareness (no specific task)
1. Run `tpm ls --status in-progress`, then `tpm ls --status ready`, then `tpm ls --status open`.
2. Show a one-screen summary: what's live (`in-progress`), what's queued for an agent (`ready`), and what's awaiting shaping (`open`).
3. Ask which task to work on, or whether to scaffold a new one.

### Start a task
This is the primary action.
1. Run `tpm context <slug>`. Read the briefing in full.
2. If `tpm context` reports the task is a parent container (has children), don't try to work it directly. Print the children (`tpm ls --project <p>`) and ask the user which child to pick up.
3. If the task's status is `open` or `ready`, edit the task file (path is in the briefing): set `status: in-progress` in frontmatter and append `- $(tpm now): started` to the `## Log` section.
4. `cd "$(tpm path <slug>)"` — that's where the work happens. If `tpm path` errors because no local path is set, ask the user for the path and offer to populate `repo.local` in the project (or task) file.
5. **Resolve the workflow doc.** This tells you how to validate, how to ship, and when to close.
   - If the briefing has a `Workflow:` line, read that file (path is relative to the repo root).
   - Else look for `AGENTS.md`, then `CLAUDE.md`, in the repo root.
   - Else ask the user before each shipping step (commit, push, PR, close).
6. Read the task body and execute the Plan. If the type is `investigation`, your output is findings — write them into the body, not just chat.
7. As you make meaningful progress, append `- $(tpm now): <what changed>` to `## Log`.
8. **To ship**, follow the workflow doc verbatim: validate (run any checks/tests it names), commit, push, open PR if directed, close the task if directed. If you open a PR, append its URL to the `prs:` list in the task's frontmatter. If the workflow says "close after merge" (the default for `type: pr`), leave the task `in-progress` and stop after pushing the PR — the user (or a follow-up **close out** action) closes it once merged.
9. If you hit a blocker you can't resolve: set `status: blocked`, log why, and surface it to the user instead of guessing.

### Shape an open task (pre-execution discussion)
Shape a task's Plan before any execution. Pure conversation that lands in the task body — never edits code, never `cd`s into the repo, never flips status to `in-progress`.
1. Run `tpm context <slug>`. Read the briefing in full.
2. If the task is a parent container (has children), shaping is not applicable — list the children and ask which one to shape instead.
3. **Do not** `cd`. **Do not** edit code in `repo.local`. **Do not** set `status: in-progress`.
4. Read `## Context` and `## Plan`. If thin or missing key details, ask clarifying questions: scope, constraints, what "done" looks like, dependencies on other tasks, open decisions.
5. As alignment forms, write back to the task body — `## Context` for facts and background, `## Plan` for the agreed approach, optionally a `## Done =` section. Append `- $(tpm now): <what was discussed/decided>` to `## Log` when meaningful progress lands.
6. (Optional) Ask whether the task is safe to run unattended. If yes, set `allow_orchestrator: true` in the frontmatter — relevant once scheduled orchestration ships, harmless before then.
7. End condition: the user signals alignment ("okay let's go", "that looks right", "yes start it"). At that point, edit the frontmatter to `status: ready`, append `- $(tpm now): promoted to ready` to `## Log`, and stop. Tell the user the task is ready to execute.
8. If discussion concludes the task isn't worth doing: set `status: dropped`, fill `## Outcome` with the reason, log it, and don't promote.

This is the canonical way to move a task from `open` to `ready`. A human can also flip the status manually, but the shaping action encodes the discipline (Context/Plan populated, Log timestamped, explicit confirmation).

### Pick the next ready task and run it
Auto-select mode. Resolves the next eligible leaf task (parents are skipped) and dispatches the **start a task** action on it.
1. Run `tpm next` (optionally with `--project <slug>`). It prints a qualified slug (`<project>/<slug>` or `<project>/<parent>/<child>`) on success or exits non-zero if nothing is ready.
2. If non-zero, surface the message ("No ready tasks…") and stop. Don't fall back to `open` tasks — the human needs to promote one via the shaping action first.
3. On success, dispatch the **start a task** action on the returned slug.

`tpm next --autonomous` is for scheduled/unattended runs only — it filters to tasks with `allow_orchestrator: true`. Manual invocations don't pass `--autonomous`.

### Close out
1. Read the task file.
2. **Verify PR merge status** if `prs:` is non-empty. For each PR URL, run `gh pr view <url> --json state --jq '.state'`.
   - At least one `MERGED` → proceed.
   - All `OPEN` or `CLOSED` (none merged) → ask once: "PR not merged; close anyway?" Respect the answer. This is the only legitimate ask in close-out.
   - `gh` not installed or not auth'd → fall back to the same ask. Don't fail hard.
   - `prs:` empty (direct-push task) → skip merge detection.
3. Fill `## Outcome` with what shipped, what changed, what was learned. Reference PRs.
4. Set `status: done` and `closed: $(tpm now)` in frontmatter.
5. Append `- $(tpm now): closed` to `## Log`.
6. Run `tpm archive <slug>` to move the completed task under `tasks/archive/`.
7. **Cleanup local branch** (when at least one linked PR was merged). For each merged PR:
   - `BRANCH=$(gh pr view <url> --json headRefName --jq '.headRefName')`. Skip if `BRANCH` equals the project's default branch (typically `main`).
   - `cd "$(tpm path <slug>)"`. If the local branch doesn't exist (`git rev-parse --verify "$BRANCH"` fails), skip — already cleaned up.
   - `git checkout main && git pull --ff-only`.
   - `git branch -d "$BRANCH"`. **Use `-d`, not `-D`** — if git refuses (e.g., you kept working on the branch after merge), surface the message and let the user decide. Don't force-delete.
   - Check the remote: `git ls-remote --heads origin "$BRANCH"`. If it still exists (GitHub's auto-delete-head-branches isn't on for this repo), print the one-liner `git push origin --delete <BRANCH>` for the user to copy/paste. Don't run it silently.
8. Print a one-line confirmation: new status, archive path, and the remote-delete hint if applicable.

### Scaffold a project or task
- New project: `tpm new project <slug> [--name "..."] [--repo <url>] [--path <local-dir>]`. Ask about `--repo` and `--path` if not provided.
- New task: `tpm new task <project> <slug> [--title "..."]`. Use `--parent <parent-slug>` to create a child task; the parent is folded automatically if it isn't already.
- After scaffolding, populate Context/Plan from the user's request or ask for them.

### Fold a task to folder-form
Use when a task needs supporting files (subtasks, scratch notes, screenshots) alongside it. `tpm fold <slug>` rewrites `tasks/NNN-slug.md` to `tasks/NNN-slug/task.md`. Idempotent. Children can then be added with `tpm new task <project> <child> --parent <slug>`.

## Conventions

- When editing task files, only touch the frontmatter and the four canonical sections (`## Context`, `## Plan`, `## Log`, `## Outcome`). Preserve key order in frontmatter.
- Don't reformat unrelated frontmatter or rename slugs.
- Don't delete the `## Outcome` section even if empty — it's a closing prompt.
- Don't rewrite project goals without explicit approval.
- Timestamps: use `tpm now` (format `YYYY-MM-DD HH:MM <ZZZ>` in the configured TZ — defaults to Pacific). Don't guess or hand-format.
- Don't manually create project/task files where `tpm new` would do it.
- If `tpm` errors with "No tpm tree configured", offer to run `tpm init` (default `~/tpm`).
- Keep edits to the user's actual code repos separate from edits to task files — task files are tracker state, not code.
- Surface CLI errors directly; don't paper over them.
