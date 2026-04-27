# tpm with OpenAI Codex CLI

Codex CLI auto-loads `AGENTS.md` from the repo root. tpm's [`AGENTS.md`](../../AGENTS.md) is already the canonical, agent-neutral guide — Codex picks it up with no extra setup when you run it inside the tpm repo.

## Install

1. Make sure the `tpm` CLI is on `$PATH` (see the [README setup](../../README.md#setup-on-a-new-device)).
2. `cd` into a repo whose root has tpm's `AGENTS.md` (this repo, or any repo where you've copied/symlinked it).
3. Run `codex` as you normally would.

To use Codex with tpm from another working repo, copy or symlink `AGENTS.md` into that repo's root. Codex doesn't recurse into parent dirs.

```sh
# from the other repo's root
ln -s /path/to/tpm/AGENTS.md AGENTS.md
```

## Usage

Codex doesn't have slash commands; invoke actions in natural language. The agent reads `AGENTS.md`, finds the matching action, and executes it.

| You say                                | Action triggered           |
|----------------------------------------|----------------------------|
| "what's open in tpm?" / "tpm status"   | Situational awareness      |
| "start task 011-agent-agnostic"        | Start a task               |
| "discuss task 011" / "shape task 011"  | Shape an open task         |
| "pick the next ready task"             | Pick the next ready task   |
| "close task 011" / "tpm done 011"      | Close out                  |
| "create a new task in tpm called X"    | Scaffold                   |

The agent should still run `tpm context <slug>` to load the briefing before acting — that's step 1 of every action.

## Caveats

- Codex's automation level varies by version and config. The action procedures in `AGENTS.md` assume the agent can run shell commands (`tpm`, `git`, `gh`) and edit files. If your Codex setup blocks any of those, the agent will surface the blocker.
- If two agents (e.g. Codex and Claude Code) work the same task simultaneously, they can collide on the file edits. Don't run both on the same slug at once.
