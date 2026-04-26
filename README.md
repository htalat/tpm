# tpm

Markdown-based task & project manager. CLI-driven, agent-friendly. Zero deps — runs on Node 22.18+ via native TypeScript.

## Layout

This repo (the CLI install):
```
bin/tpm                            entry (bash shim → src/cli.ts)
src/                               TypeScript implementation
.tpm/templates/                    distributed default templates
skills/tpm/SKILL.md                Claude Code skill (symlink target)
```

A tpm tree (data — lives wherever `tpm init` was run, e.g. `~/Documents/projects/`):
```
<root>/.tpm/templates/                          per-tree templates (copied from defaults)
<root>/reports/index.html                       generated rollup
<root>/<slug>/project.md                        goals, context, notes
<root>/<slug>/tasks/NNN-*.md                    file-form task (one file)
<root>/<slug>/tasks/NNN-*/task.md               folder-form task (a parent)
<root>/<slug>/tasks/NNN-*/NNN-*.md              subtasks (`parent:` in frontmatter)
<root>/<slug>/tasks/NNN-*/...                   any other supporting files
<root>/<slug>/tasks/archive/NNN-*.md            archived file-form task
<root>/<slug>/tasks/archive/NNN-*/              archived folder-form parent (whole folder moved)
<root>/<slug>/tasks/archive/NNN-*/NNN-*.md      archived child of a still-live parent
<root>/<slug>/notes/                            free-form scratch
```

Project directories sit as siblings to `.tpm/` and `reports/` — no inner `projects/` nesting.

## Setup on a new device

Bootstraps the CLI, the data tree, and (optionally) the Claude Code skill from scratch. Steps assume zsh/bash on macOS or Linux. Adjust paths if `~/.local/bin` isn't already in your `$PATH`.

```sh
# 0. Prereq: Node 22.18+ (for native TypeScript execution). Verify:
node --version

# 1. Place the tpm repo somewhere stable.
git clone <your-tpm-remote> ~/Developer/tpm   # or copy/sync the directory
cd ~/Developer/tpm

# 2. Put the CLI on $PATH.
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/tpm" ~/.local/bin/tpm
tpm --help                                    # sanity check

# 3. Bootstrap a data tree and write the user config.
tpm init ~/Documents/projects                 # writes ~/.tpm/config.json -> ~/Documents/projects
# or: tpm init                                # default ~/tpm
# or: tpm init ~/Dropbox/projects             # put data wherever you want it synced
tpm root                                      # confirms the tree root

# 4. (Optional) Install the Claude Code skill.
mkdir -p ~/.claude/skills
ln -sf "$PWD/skills/tpm" ~/.claude/skills/tpm
# Restart any running Claude Code session, then `/tpm` becomes available.

# 5. (Optional) Skip permission prompts for the tpm CLI.
# Add "Bash(tpm:*)" to permissions.allow in ~/.claude/settings.json.
# Easiest way is to ask Claude Code: "add Bash(tpm:*) to my user settings."
```

Verify end-to-end:

```sh
tpm new project sandbox --name "Sandbox" --repo https://github.com/you/sandbox --path ~/code/sandbox
tpm new task sandbox first-thing --title "First thing"
tpm ls
tpm context sandbox/first-thing | head -20
tpm report && open reports/index.html
```

### Syncing data across devices

The data tree (`~/tpm` or wherever) is just markdown. Easiest options:

- **Cloud folder**: put it in iCloud Drive, Dropbox, or similar; `tpm init <path>` on each device.
- **Git**: `git init` inside the tree, push to a private repo; clone on each device, then `tpm init <path>`.

The CLI install (this repo) and the data tree are independent — you can replace either without touching the other. `~/.tpm/config.json` is the only per-device pointer.

### Re-running setup (idempotency)

- `tpm init <path>` is safe to re-run — it only creates missing files and updates the config pointer.
- `ln -sf` overwrites broken symlinks but doesn't touch the target.
- The skill symlink picks up edits to `skills/tpm/SKILL.md` immediately; no restart needed for content changes (only for first install).

## Install (TL;DR)

If you already have the repo and just want the CLI:

```sh
ln -s "$PWD/bin/tpm" ~/.local/bin/tpm
tpm init
```

## Commands

```sh
tpm init [<dir>]                          # bootstrap a tree (default: ~/tpm)
tpm new project <slug> [--name "Pretty Name"] [--repo <url>] [--path <local-dir>]
tpm new task <project> <slug> [--title "Pretty Title"] [--parent <parent-slug>]
tpm ls [--all] [--archived] [--flat] [--status open] [--project <slug>]
tpm context <task | project/task | parent/child>
tpm archive <task | project/task>          # move a done/dropped task (or whole folder-form parent) to tasks/archive/
tpm fold <task | project/task>             # promote a file-form task to folder-form (idempotent)
tpm next [--project <slug>] [--autonomous]  # print the next ready leaf task (oldest first); exits non-zero if none
tpm report [--md]
tpm root                                  # print the tree root
tpm path <project | task | project/task>  # print the local checkout path
tpm now                                   # timestamp in the configured timezone
```

### Linking projects to repos

Each project can record its repo (remote URL + local checkout path). Tasks inherit by default; set `repo:` on a task to override.

```yaml
# projects/<slug>/project.md
repo:
  remote: https://github.com/owner/repo
  local:  /Users/you/code/repo
```

`tpm context` includes both in the briefing and tells the agent to `cd` into the local path. `tpm report` links the remote in each project header. `tpm path some-task` prints the local path so you can `cd $(tpm path some-task)` from the shell.

## Where does my data live?

Wherever `~/.tpm/config.json` says — written by `tpm init`. One source, no overrides. To switch trees, run `tpm init <other-dir>`.

```sh
tpm root              # /Users/you/tpm
cat ~/.tpm/config.json
```

### Config fields

```json
{
  "root": "/Users/you/Documents/projects",
  "timezone": "America/Los_Angeles"
}
```

- `root` — tree root, set by `tpm init <dir>`.
- `timezone` — IANA name (e.g. `America/Los_Angeles`, `Europe/Berlin`, `UTC`); used for `created`, `closed`, log entries, and report timestamps. Handles DST automatically (PST/PDT). Defaults to `America/Los_Angeles` if absent. Run `tpm now` to see the current timestamp in the configured zone.

## Frontmatter schema

**`<root>/<slug>/project.md`**
```yaml
name: Pretty Name
slug: my-project
status: active        # active | paused | done | archived
created: 2026-04-25 09:30 PDT
repo:
  remote: https://github.com/owner/repo
  local:  /Users/you/code/repo
tags: []
```

**`<root>/<slug>/tasks/NNN-<slug>.md`**
```yaml
title: Refactor auth middleware
slug: refactor-auth
project: my-project
status: open          # open | ready | in-progress | blocked | done | dropped
type: pr              # pr | investigation | spike | chore
created: 2026-04-25 09:30 PDT
closed:               # YYYY-MM-DD HH:MM ZZZ when status flips to done
prs: []               # list of PR URLs
tags: []
parent: NNN-foo       # optional: marks this as a child within a folder-form parent
```

Timestamps are written in the timezone from `~/.tpm/config.json` (default `America/Los_Angeles`). Old date-only values (`2026-04-25`) keep parsing — values are display strings only.

Edit the markdown freely — frontmatter is the source of truth for `tpm ls` and `tpm report`. The body uses `## Context / ## Plan / ## Log / ## Outcome` sections.

`tpm ls` hides `done` and `dropped` tasks by default. Use `--all` to include every active task status, `--status done` to query a specific status, or `--archived` to include tasks moved under `tasks/archive/`. `tpm context` and `tpm path` still resolve archived tasks, and new task numbering counts both active and archived task files.

## Hierarchical tasks (folder form)

A task is one of two shapes:

- **File form** (default): `tasks/NNN-slug.md`. One file. Most tasks live here.
- **Folder form**: `tasks/NNN-slug/task.md`. Use this when a task needs more than one file — subtasks, scratch notes, screenshots, supporting design docs.

Subtasks are first-class tasks with their own status, PRs, and log. They live alongside `task.md` inside the parent's folder, with `parent: <parent-slug>` in their frontmatter:

```
tasks/004-orchestrator-hardening/
  task.md                    # parent: high-level overview, links to children
  001-lock-file.md           # parent: 004-orchestrator-hardening
  002-drift-check.md         # parent: 004-orchestrator-hardening
  003-time-bound.md          # parent: 004-orchestrator-hardening
  notes-from-call.md         # arbitrary supporting file — tpm doesn't care
```

A task with any children is a **container**: it isn't actionable, never appears in `tpm next`, and `tpm ls` shows a roll-up status (any child in-progress → in-progress; all children done → done; otherwise the parent's own declared status). The roll-up is display only — `tpm` never auto-changes the parent's frontmatter.

### Working with folder form

```sh
tpm fold <task>                                  # promote NNN-slug.md → NNN-slug/task.md (idempotent)
tpm new task <project> <child> --parent <slug>   # creates a child inside the parent's folder
                                                 # folds the parent automatically if needed
                                                 # numbering is scoped to the parent folder
tpm ls --flat                                    # flatten the tree (skip indentation)
```

Only one level of nesting is supported — `--parent` rejects an attempt to nest under a child task.

### Slug resolution

A bare slug (`/tpm hierarchical-tasks`) works when it's globally unambiguous. If two tasks could match (e.g., two children named `discuss` under different parents), the CLI errors and asks you to qualify it. Qualified forms:

- `<project>/<task>` — top-level task
- `<parent>/<child>` — child within a single project
- `<project>/<parent>/<child>` — fully qualified

### Archive layout

- `tpm archive <task>` on a folder-form parent moves the whole folder to `tasks/archive/<parent>/`. The parent must have no live children.
- `tpm archive <child>` moves just the child file to `tasks/archive/<parent>/<child>.md`. The live parent stays in place.

## Delegating to a coding agent

```sh
tpm context my-project/refactor-auth | claude
# or paste the output into any chat agent
```

`tpm context` emits a self-contained briefing: project goal, task body, file path, and a working agreement that tells the agent where to log progress and update status.

### `open` vs `ready`: the agent gate

`open` is the author's queue — newly-created tasks land here. `ready` is the agent's queue — the Plan is well-specified and an agent can pick up the task without further shaping.

Promotion `open` → `ready` is a deliberate human act. The canonical way is the `/tpm discuss <slug>` skill mode, which shapes the task body via conversation and only flips status on explicit confirmation. Manual frontmatter edits also work.

```sh
tpm next                       # print the next ready task across all projects
tpm next --project my-project  # restrict to one project
tpm next --autonomous          # only ready tasks with `allow_orchestrator: true`
```

`tpm next` exits non-zero with a stderr message if nothing is eligible, so it composes cleanly: `task=$(tpm next) && claude -p "/tpm $task"`.

### Scheduling unattended runs (cron)

`tpm next` composes with cron for hands-off orchestration. To set up:

```sh
which tpm                    # e.g. /opt/homebrew/bin/tpm
which claude                 # e.g. /opt/homebrew/bin/claude
crontab -e
```

Add an entry like:

```cron
# Run tpm orchestrator every 4 hours
0 */4 * * * task=$(/opt/homebrew/bin/tpm next --autonomous) && /opt/homebrew/bin/claude -p "/tpm $task" >> /tmp/tpm-cron.log 2>&1
```

Substitute the absolute paths from `which`. cron has a minimal `PATH`, so absolute paths are required. If `tpm next --autonomous` finds nothing eligible it exits non-zero, the `&&` short-circuits, and Claude isn't invoked.

To opt a task in for unattended runs, set `allow_orchestrator: true` in its frontmatter. Without that flag, `tpm next --autonomous` skips the task even if its status is `ready` — that's the safety boundary between "an agent can run this when I ask" and "an agent can run this while I'm asleep".

The machine must be awake and logged in for cron to fire.

**No safety rails yet.** Cron currently runs without a lock file, drift check, time bound, or notifications — those land in follow-up tasks. Until they ship, be aware:
- A polluted working tree on `main` will be inherited by the agent.
- Two overlapping firings can collide on the same task (use a sparse schedule).
- Wedged runs burn credits until Claude's own session limits trigger.
- Failures are silent — check status via `tpm ls` and `/tmp/tpm-cron.log`.

## Reports

```sh
tpm report           # writes reports/index.html (open it in a browser)
tpm report --md      # writes reports/index.md
```

The HTML report is one self-contained file with no external assets. Dark mode supported via `prefers-color-scheme`.

## Tests

```sh
npm test                                  # runs every src/**/*.test.ts
node --test src/frontmatter.test.ts       # one file
node --test --test-name-pattern=archive src/tree.test.ts
```

Uses Node's built-in test runner (`node --test`) and `node:assert/strict`. No install step — the suite has zero dependencies, same as the CLI. Tests are colocated with source as `*.test.ts` and create their own temp dirs; nothing touches `~/.tpm` because each test file re-homes the process via `src/_test_helpers.ts`.
