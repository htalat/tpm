---
name: tpm
description: Drive the tpm CLI (markdown-based task & project tracker). Invoke when the user types /tpm to discover open work, load a task briefing, start working on a task, scaffold new projects/tasks, or close one out.
---

# tpm

You are operating Hassan's `tpm` — a markdown-based task & project tracker. The CLI is `tpm`. The tree lives wherever `~/.tpm/config.json` points (set by `tpm init`). Markdown frontmatter is the source of truth.

## CLI cheatsheet

```
tpm root                                            print the tree root
tpm ls [--all] [--archived] [--status open|ready|in-progress|blocked|done|dropped] [--project <slug>]
tpm context <task | project/task>                   full briefing (file path, project goal, body, working agreement)
tpm path <project | task | project/task>            print local repo checkout
tpm archive <task | project/task>                   move a done/dropped task to tasks/archive/
tpm next [--project <slug>] [--autonomous]          print the next ready task (oldest first)
tpm new project <slug> [--name "..."] [--repo <url>] [--path <local-dir>]
tpm new task <project> <slug> [--title "..."]
tpm report [--md]                                   reports/index.html
tpm now                                             timestamp in the configured timezone
tpm init [<dir>]                                    bootstrap a tree (default ~/tpm)
```

## Schema

- **Project frontmatter**: `name, slug, status, created, repo: {remote, local}, tags`
- **Task frontmatter**: `title, slug, project, status, type, created, closed, prs, tags` (inherits `repo` from project; can override by adding own `repo:` block)
- **Statuses**: `open | ready | in-progress | blocked | done | dropped`
  - `open` = Hassan's queue (not yet shaped for an agent).
  - `ready` = agent's queue (Plan is well-specified, an agent can pick it up). Promoted via `/tpm discuss`.
- **Types**: `pr | investigation | spike | chore`
- **Task body**: `## Context`, `## Plan`, `## Log`, `## Outcome`

## Dispatch

Read `$ARGUMENTS` and pick a mode. If empty, default to "no args".

### No args — situational awareness
1. Run `tpm ls --status in-progress`, then `tpm ls --status ready`, then `tpm ls --status open`.
2. Show a one-screen summary: what's live (`in-progress`), what's queued for an agent (`ready`), and what's awaiting shaping (`open`).
3. Ask which task to work on, or whether to scaffold a new one.

### `<task>` or `<project>/<task>` — start working on a task
This is the primary mode.
1. Run `tpm context <arg>`. Read the briefing in full.
2. If the task's status is `open` or `ready`, edit the task file (path is in the briefing): set `status: in-progress` in frontmatter and append `- $(tpm now): started` to the `## Log` section.
3. `cd "$(tpm path <arg>)"` — that's where the work happens. If `tpm path` errors because no local path is set, ask the user for the path and offer to populate `repo.local` in the project (or task) file.
4. Read the task body and execute the Plan. If the type is `investigation`, your output is findings — write them into the body, not just chat.
5. As you make meaningful progress, append `- $(tpm now): <what changed>` to `## Log`.
6. If you open a PR, append its URL to the `prs:` list in the task's frontmatter.
7. If you hit a blocker you can't resolve: set `status: blocked`, log why, and surface it to the user instead of guessing.

### `discuss <task>` or `discuss <project>/<task>` — pre-execution discussion
Shape a task's Plan before any execution. Pure conversation that lands in the task body — never edits code, never `cd`s into the repo, never flips status to `in-progress`.
1. Run `tpm context <arg>`. Read the briefing in full.
2. **Do not** `cd`. **Do not** edit code in `repo.local`. **Do not** set `status: in-progress`.
3. Read `## Context` and `## Plan`. If thin or missing key details, ask clarifying questions: scope, constraints, what "done" looks like, dependencies on other tasks, open decisions.
4. As alignment forms, write back to the task body — `## Context` for facts and background, `## Plan` for the agreed approach, optionally a `## Done =` section. Append `- $(tpm now): <what was discussed/decided>` to `## Log` when meaningful progress lands.
5. (Optional) Ask whether the task is safe to run unattended. If yes, set `allow_orchestrator: true` in the frontmatter — relevant once scheduled orchestration ships, harmless before then.
6. End condition: the user signals alignment ("okay let's go", "that looks right", "yes start it"). At that point, edit the frontmatter to `status: ready`, append `- $(tpm now): promoted to ready` to `## Log`, and stop. Final hand-off message: `Ready. Run /tpm <slug> to execute.`
7. If discussion concludes the task isn't worth doing: set `status: dropped`, fill `## Outcome` with the reason, log it, and don't promote.

Discuss mode is the canonical way to move a task from `open` to `ready`. A human can also flip the status manually, but `/tpm discuss` encodes the discipline (Context/Plan populated, Log timestamped, explicit confirmation).

### `next` — pick the next ready task and run it
Auto-select mode. Resolves the next eligible task and dispatches the primary `<task>` mode on it.
1. Run `tpm next` (optionally with `--project <slug>`). It prints `<project>/<slug>` on success or exits non-zero if nothing is ready.
2. If non-zero, surface the message ("No ready tasks…") and stop. Don't fall back to `open` tasks — the human needs to promote one via `/tpm discuss` first.
3. On success, dispatch the primary `<task>` mode on the returned slug — same flow as if the user had typed `/tpm <slug>` directly (flip status to `in-progress`, `cd`, execute Plan, log progress, open PR).

`/tpm next` is the manual path. Use `tpm next --autonomous` only from scheduled/unattended runs (filters to tasks with `allow_orchestrator: true`); the manual `/tpm next` skill mode does not pass `--autonomous`.

### `done <task>` — close out
1. Read the task file.
2. Fill `## Outcome` with what shipped, what changed, what was learned. Reference PRs.
3. Set `status: done` and `closed: $(tpm now)` in frontmatter.
4. Append `- $(tpm now): closed` to `## Log`.
5. Run `tpm archive <task>` to move the completed task under `tasks/archive/`.
6. Print a one-line confirmation with the new status and archive path.

### `new <project> <slug>` — scaffold a task (shorthand)
Two args after `new` ⇒ task. Three with leading `project` ⇒ project.
1. Run the appropriate `tpm new ...` with `--title`/`--name` if the user hinted at one.
2. Open the new file. Either populate Context/Plan from the user's request or ask for them.
3. For `new project`, also ask about `--repo` and `--path` if not provided.

### Pass-through (`ls`, `report`, `root`, `path`, `context`, `init`)
Just run the corresponding `tpm` subcommand and print the result.

## Conventions

- When editing task files, only touch the frontmatter and the four canonical sections. Preserve key order in frontmatter.
- Timestamps: use `tpm now` (format `YYYY-MM-DD HH:MM <ZZZ>` in the configured TZ — defaults to Pacific). Don't guess or hand-format.
- Don't manually create project/task files where `tpm new` would do it.
- If `tpm` errors with "No tpm tree configured", offer to run `tpm init` (default `~/tpm`).
- Keep edits to the user's actual code repos separate from edits to task files — task files are tracker state, not code.
- Surface CLI errors directly; don't paper over them.
