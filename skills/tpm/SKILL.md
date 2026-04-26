---
name: tpm
description: Drive the tpm CLI (markdown-based task & project tracker). Invoke when the user types /tpm to discover open work, load a task briefing, start working on a task, scaffold new projects/tasks, or close one out.
---

# tpm

You are operating Hassan's `tpm` — a markdown-based task & project tracker. The CLI is `tpm`. The tree lives wherever `~/.tpm/config.json` points (set by `tpm init`). Markdown frontmatter is the source of truth.

## CLI cheatsheet

```
tpm root                                            print the tree root
tpm ls [--all] [--archived] [--status open|in-progress|blocked|done|dropped] [--project <slug>]
tpm context <task | project/task>                   full briefing (file path, project goal, body, working agreement)
tpm path <project | task | project/task>            print local repo checkout
tpm archive <task | project/task>                   move a done/dropped task to tasks/archive/
tpm new project <slug> [--name "..."] [--repo <url>] [--path <local-dir>]
tpm new task <project> <slug> [--title "..."]
tpm report [--md]                                   reports/index.html
tpm now                                             timestamp in the configured timezone
tpm init [<dir>]                                    bootstrap a tree (default ~/tpm)
```

## Schema

- **Project frontmatter**: `name, slug, status, created, repo: {remote, local}, tags`
- **Task frontmatter**: `title, slug, project, status, type, created, closed, prs, tags` (inherits `repo` from project; can override by adding own `repo:` block)
- **Statuses**: `open | in-progress | blocked | done | dropped`
- **Types**: `pr | investigation | spike | chore`
- **Task body**: `## Context`, `## Plan`, `## Log`, `## Outcome`

## Dispatch

Read `$ARGUMENTS` and pick a mode. If empty, default to "no args".

### No args — situational awareness
1. Run `tpm ls --status in-progress` then `tpm ls --status open`.
2. Show a one-screen summary of what's live and what's queued.
3. Ask which task to work on, or whether to scaffold a new one.

### `<task>` or `<project>/<task>` — start working on a task
This is the primary mode.
1. Run `tpm context <arg>`. Read the briefing in full.
2. If the task's status is `open`, edit the task file (path is in the briefing): set `status: in-progress` in frontmatter and append `- $(tpm now): started` to the `## Log` section.
3. `cd "$(tpm path <arg>)"` — that's where the work happens. If `tpm path` errors because no local path is set, ask the user for the path and offer to populate `repo.local` in the project (or task) file.
4. Read the task body and execute the Plan. If the type is `investigation`, your output is findings — write them into the body, not just chat.
5. As you make meaningful progress, append `- $(tpm now): <what changed>` to `## Log`.
6. If you open a PR, append its URL to the `prs:` list in the task's frontmatter.
7. If you hit a blocker you can't resolve: set `status: blocked`, log why, and surface it to the user instead of guessing.

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
