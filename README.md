# tpm

Markdown-based task & project manager. CLI-driven, agent-friendly. Zero deps — runs on Node 22.18+ via native TypeScript.

## Layout

```
bin/tpm                            CLI entry (bash shim → src/cli.ts)
src/                               TypeScript implementation
.tpm/templates/                    project & task templates (in this repo, the install-default tree)
skills/tpm/SKILL.md                Claude Code skill (symlink target)
projects/<slug>/project.md         goals, context, notes  (data lives in your tree, not the repo)
projects/<slug>/tasks/NNN-*.md     one task per file (frontmatter + markdown)
projects/<slug>/notes/             free-form scratch
reports/index.html                 generated rollup
```

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
tpm init                                      # default: ~/tpm  →  ~/.tpm/config.json
# or: tpm init ~/Dropbox/tpm                  # put data wherever you want it synced
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
tpm new task <project> <slug> [--title "Pretty Title"]
tpm ls [--status open] [--project <slug>]
tpm context <task | project/task>
tpm report [--md]
tpm root                                  # print the tree root
tpm path <project | task | project/task>  # print the local checkout path
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

## Frontmatter schema

**project.md**
```yaml
name: Pretty Name
slug: my-project
status: active        # active | paused | done | archived
created: 2026-04-25
repo:
  remote: https://github.com/owner/repo
  local:  /Users/you/code/repo
tags: []
```

**task.md**
```yaml
title: Refactor auth middleware
slug: refactor-auth
project: my-project
status: open          # open | in-progress | blocked | done | dropped
type: pr              # pr | investigation | spike | chore
created: 2026-04-25
closed:               # YYYY-MM-DD when status flips to done
prs: []               # list of PR URLs
tags: []
```

Edit the markdown freely — frontmatter is the source of truth for `tpm ls` and `tpm report`. The body uses `## Context / ## Plan / ## Log / ## Outcome` sections.

## Delegating to a coding agent

```sh
tpm context my-project/refactor-auth | claude
# or paste the output into any chat agent
```

`tpm context` emits a self-contained briefing: project goal, task body, file path, and a working agreement that tells the agent where to log progress and update status.

## Reports

```sh
tpm report           # writes reports/index.html (open it in a browser)
tpm report --md      # writes reports/index.md
```

The HTML report is one self-contained file with no external assets. Dark mode supported via `prefers-color-scheme`.
