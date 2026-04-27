---
name: tpm
description: Drive the tpm CLI (markdown-based task & project tracker). Invoke when the user types /tpm to discover open work, load a task briefing, start working on a task, scaffold new projects/tasks, or close one out.
---

# tpm

You are operating `tpm` — a markdown-based task & project tracker. The CLI is `tpm`. The tree lives wherever `~/.tpm/config.json` points (set by `tpm init`). Markdown frontmatter is the source of truth.

This skill is the Claude Code dispatch wrapper. The action procedures (situational awareness, start a task, shape an open task, pick the next ready task, close out, scaffold, fold) are defined in the agent-neutral guide at `AGENTS.md` in the tpm repo (at the repo root). The dispatch surface and the procedures are mirrored below for self-containment; if they ever drift, AGENTS.md is canonical.

## CLI

Run `tpm --help` to discover every subcommand and flag. The action procedures below name the specific commands they need.

## Schema

- **Project frontmatter**: `name, slug, status, created, repo: {remote, local}, tags`
- **Task frontmatter**: `title, slug, project, status, type, created, closed, prs, tags` (inherits `repo` from project; can override by adding own `repo:` block). Optional `parent: <parent-slug>` marks the task as a child within a folder-form parent.
- **Task shapes** — a task is either:
  - **File form** (default): `tasks/NNN-slug.md`. Single file.
  - **Folder form**: `tasks/NNN-slug/task.md` plus optional `NNN-<sub>.md` siblings (each with `parent: NNN-slug` in frontmatter) and any other files (scratch notes, screenshots, design docs). The directory name is the parent's slug.
- A task with any children is a **container**: not actionable, never returned by `tpm next`, can't be discussed/started directly.
- **Statuses**: `open | ready | in-progress | blocked | done | dropped`
  - `open` = the user's queue (not yet shaped for an agent).
  - `ready` = agent's queue (Plan is well-specified, an agent can pick it up). Promoted via `/tpm discuss`.
  - Parent containers display a roll-up status (all children done → done; any in-progress → in-progress; else parent's declared status). The roll-up is display only — not written to frontmatter.
- **Types**: `pr | investigation | spike | chore`
- **Task body**: `## Context`, `## Plan`, `## Log`, `## Outcome`

## Slug resolution

- A bare slug works when it's globally unambiguous (e.g., `/tpm 017-hierarchical-tasks` or `/tpm hierarchical-tasks`).
- If a bare slug matches multiple tasks (e.g., two children named `discuss` under different parents), the CLI errors and asks you to qualify it.
- Qualified forms: `<project>/<task>`, `<parent>/<child>`, `<project>/<parent>/<child>`. Use whichever disambiguates.

## Slash command → action mapping

| Slash command                       | Action                                |
|-------------------------------------|---------------------------------------|
| `/tpm`                              | Situational awareness (no specific task) |
| `/tpm <slug>`                       | Start a task                          |
| `/tpm discuss <slug>`               | Shape an open task                    |
| `/tpm next`                         | Pick the next ready task and run it   |
| `/tpm done <slug>`                  | Close out                             |
| `/tpm new <project> <slug>`         | Scaffold a task                       |
| `/tpm new project <slug>`           | Scaffold a project                    |
| `/tpm fold <slug>`                  | Fold a task to folder-form            |
| `/tpm ls`, `/tpm report`, `/tpm root`, `/tpm path`, `/tpm context`, `/tpm init` | Pass through to the corresponding `tpm` subcommand |

Read `$ARGUMENTS` and pick the matching action. If empty, default to "situational awareness".

## Action procedures

### Situational awareness
1. Run `tpm ls --status in-progress`, then `tpm ls --status ready`, then `tpm ls --status open`.
2. Show a one-screen summary: what's live (`in-progress`), what's queued for an agent (`ready`), and what's awaiting shaping (`open`).
3. Ask which task to work on, or whether to scaffold a new one.

### Start a task (`/tpm <slug>` or `/tpm <project>/<slug>`)
This is the primary mode.
1. Run `tpm context <arg>`. Read the briefing in full.
2. If `tpm context` reports the task is a parent container (has children), don't try to work it directly. Print the children (`tpm ls --project <p>`) and ask the user which child to pick up.
3. If the task's status is `open` or `ready`, edit the task file (path is in the briefing): set `status: in-progress` in frontmatter and append `- $(tpm now): started` to the `## Log` section.
4. `cd "$(tpm path <arg>)"` — that's where the work happens. If `tpm path` errors because no local path is set, ask the user for the path and offer to populate `repo.local` in the project (or task) file.
5. **Resolve the workflow doc.** This tells you how to validate, how to ship, and when to close.
   - If the briefing has a `Workflow:` line, read that file (path is relative to the repo root).
   - Else look for `AGENTS.md`, then `CLAUDE.md`, in the repo root.
   - Else ask the user before each shipping step (commit, push, PR, close).
6. Read the task body and execute the Plan. If the type is `investigation`, your output is findings — write them into the body, not just chat.
7. As you make meaningful progress, append `- $(tpm now): <what changed>` to `## Log`.
8. **To ship**, follow the workflow doc verbatim: validate (run any checks/tests it names), commit, push, open PR if directed, close the task if directed. If you open a PR, append its URL to the `prs:` list in the task's frontmatter. If the workflow says "close after merge" (the default for `type: pr`), leave the task `in-progress` and stop after pushing the PR — the user (or a follow-up `/tpm done <task>`) closes it once merged.
9. If you hit a blocker you can't resolve: set `status: blocked`, log why, and surface it to the user instead of guessing.

### Shape an open task (`/tpm discuss <slug>`)
Shape a task's Plan before any execution. Pure conversation that lands in the task body — never edits code, never `cd`s into the repo, never flips status to `in-progress`.
1. Run `tpm context <arg>`. Read the briefing in full.
2. If the task is a parent container (has children), discuss is not applicable — list the children and ask which one to shape instead.
3. **Do not** `cd`. **Do not** edit code in `repo.local`. **Do not** set `status: in-progress`.
4. Read `## Context` and `## Plan`. If thin or missing key details, ask clarifying questions: scope, constraints, what "done" looks like, dependencies on other tasks, open decisions.
5. As alignment forms, write back to the task body — `## Context` for facts and background, `## Plan` for the agreed approach, optionally a `## Done =` section. Append `- $(tpm now): <what was discussed/decided>` to `## Log` when meaningful progress lands.
6. (Optional) Ask whether the task is safe to run unattended. If yes, set `allow_orchestrator: true` in the frontmatter — relevant once scheduled orchestration ships, harmless before then.
7. End condition: the user signals alignment ("okay let's go", "that looks right", "yes start it"). At that point, edit the frontmatter to `status: ready`, append `- $(tpm now): promoted to ready` to `## Log`, and stop. Final hand-off message: `Ready. Run /tpm <slug> to execute.`
8. If discussion concludes the task isn't worth doing: set `status: dropped`, fill `## Outcome` with the reason, log it, and don't promote.

Discuss mode is the canonical way to move a task from `open` to `ready`. A human can also flip the status manually, but `/tpm discuss` encodes the discipline (Context/Plan populated, Log timestamped, explicit confirmation).

### Pick the next ready task and run it (`/tpm next`)
Auto-select mode. Resolves the next eligible leaf task (parents are skipped) and dispatches the **start a task** mode on it.
1. Run `tpm next` (optionally with `--project <slug>`). It prints a qualified slug (`<project>/<slug>` or `<project>/<parent>/<child>`) on success or exits non-zero if nothing is ready.
2. If non-zero, surface the message ("No ready tasks…") and stop. Don't fall back to `open` tasks — the human needs to promote one via `/tpm discuss` first.
3. On success, dispatch the **start a task** mode on the returned slug — same flow as if the user had typed `/tpm <slug>` directly (flip status to `in-progress`, `cd`, execute Plan, log progress, open PR).

`/tpm next` is the manual path. Use `tpm next --autonomous` only from scheduled/unattended runs (filters to tasks with `allow_orchestrator: true`); the manual `/tpm next` skill mode does not pass `--autonomous`.

### Close out (`/tpm done <slug>`)
1. Read the task file.
2. **Verify PR merge status** if `prs:` is non-empty. For each PR URL, run `gh pr view <url> --json state --jq '.state'`.
   - At least one `MERGED` → proceed.
   - All `OPEN` or `CLOSED` (none merged) → ask once: "PR not merged; close anyway?" Respect the answer. This is the only legitimate ask in close-out.
   - `gh` not installed or not auth'd → fall back to the same ask. Don't fail hard.
   - `prs:` empty (direct-push task) → skip merge detection.
3. Fill `## Outcome` with what shipped, what changed, what was learned. Reference PRs.
4. Set `status: done` and `closed: $(tpm now)` in frontmatter.
5. Append `- $(tpm now): closed` to `## Log`.
6. Run `tpm archive <task>` to move the completed task under `tasks/archive/`.
7. **Cleanup local branch** (when at least one linked PR was merged). For each merged PR:
   - `BRANCH=$(gh pr view <url> --json headRefName --jq '.headRefName')`. Skip if `BRANCH` equals the project's default branch (typically `main`).
   - `cd "$(tpm path <task>)"`. If the local branch doesn't exist (`git rev-parse --verify "$BRANCH"` fails), skip — already cleaned up.
   - `git checkout main && git pull --ff-only`.
   - `git branch -d "$BRANCH"`. **Use `-d`, not `-D`** — if git refuses (e.g., you kept working on the branch after merge), surface the message and let the user decide. Don't force-delete.
   - Check the remote: `git ls-remote --heads origin "$BRANCH"`. If it still exists (GitHub's auto-delete-head-branches isn't on for this repo), print the one-liner `git push origin --delete <BRANCH>` for the user to copy/paste. Don't run it silently.
8. Print a one-line confirmation: new status, archive path, and the remote-delete hint if applicable.

### Scaffold (`/tpm new <project> <slug>`)
Two args after `new` ⇒ task. Three with leading `project` ⇒ project.
1. Run the appropriate `tpm new ...` with `--title`/`--name` if the user hinted at one.
2. Open the new file. Either populate Context/Plan from the user's request or ask for them.
3. For `new project`, also ask about `--repo` and `--path` if not provided.
4. To create a child task, pass `--parent <parent-slug>` to `tpm new task`. The parent is folded automatically if it isn't already.

### Fold a task to folder-form (`/tpm fold <slug>`)
Use when a task needs supporting files (subtasks, scratch notes, screenshots) alongside it. `tpm fold <task>` rewrites `tasks/NNN-slug.md` to `tasks/NNN-slug/task.md`. Idempotent. Children can then be added with `tpm new task <project> <child> --parent <slug>`.

### Pass-through (`/tpm ls`, `/tpm report`, `/tpm root`, `/tpm path`, `/tpm context`, `/tpm init`)
Just run the corresponding `tpm` subcommand and print the result.

## Conventions

- When editing task files, only touch the frontmatter and the four canonical sections. Preserve key order in frontmatter.
- Timestamps: use `tpm now` (format `YYYY-MM-DD HH:MM <ZZZ>` in the configured TZ — defaults to Pacific). Don't guess or hand-format.
- Don't manually create project/task files where `tpm new` would do it.
- If `tpm` errors with "No tpm tree configured", offer to run `tpm init` (default `~/tpm`).
- Keep edits to the user's actual code repos separate from edits to task files — task files are tracker state, not code.
- Surface CLI errors directly; don't paper over them.
