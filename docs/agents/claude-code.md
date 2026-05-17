# tpm with Claude Code

Claude Code dispatches tpm via a slash command (`/tpm`). The skill at `skills/tpm/SKILL.md` is the dispatch surface; it mirrors the action procedures from [`AGENTS.md`](../../AGENTS.md).

## Install

`tpm` ships its own user-scoped Claude Code skill. After cloning the repo, run:

```sh
tpm refresh-skills
# Restart any running Claude Code session, then `/tpm` becomes available.
```

This walks every directory under `skills/` and installs it into `~/.claude/skills/`. On macOS/Linux it creates symlinks so edits to `SKILL.md` flow live; on Windows (where symlinks need admin or Developer Mode) it does a recursive copy — re-run `tpm refresh-skills` after editing a `SKILL.md` to refresh the copy. The command is idempotent and safe to re-run any time.

## Usage

| You type            | What happens                                                |
|---------------------|-------------------------------------------------------------|
| `/tpm`              | Situational awareness — what's in-progress, ready, open     |
| `/tpm <slug>`       | Start a task: flip status to in-progress, `cd`, execute Plan |
| `/tpm discuss <slug>` | Shape an open task (no code edits, no status flip yet)    |
| `/tpm next`         | Pick the oldest ready task and run it                       |
| `/tpm done <slug>`  | Close out a merged PR task: outcome, archive, branch cleanup |
| `/tpm new <project> <slug>` | Scaffold a task                                     |
| `/tpm fold <slug>`  | Promote file-form task to folder-form                       |
| `/tpm reparent <slug> <new-parent \| --top>` | Move a task under a new parent (or to top-level) |
| `/tpm ls`, `/tpm report`, `/tpm path`, … | Pass-throughs to the CLI                |

See `skills/tpm/SKILL.md` for the full action procedures.

## Permissions

To skip permission prompts for the tpm CLI, add `Bash(tpm:*)` to `permissions.allow` in `~/.claude/settings.json`. The easiest path: ask Claude Code "add `Bash(tpm:*)` to my user settings."

## Repo-scoped skills

This repo also ships `/release` at `.claude/skills/release/`. Repo-scoped skills are auto-loaded by Claude Code when cwd is inside the repo — no symlink needed. See the [skill scoping convention](../../README.md#skill-scoping) in the README.
