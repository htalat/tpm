# tpm with GitHub Copilot

GitHub Copilot Chat reads `.github/copilot-instructions.md` from the repo root as ambient context. tpm's [`AGENTS.md`](../../AGENTS.md) is the canonical guide; symlink it into Copilot's expected location once and Copilot Chat will load it automatically.

## Install

1. Make sure the `tpm` CLI is on `$PATH` (see the [README setup](../../README.md#setup-on-a-new-device)).
2. From the tpm repo root:

   ```sh
   mkdir -p .github
   ln -sfn ../AGENTS.md .github/copilot-instructions.md
   ```

   On Windows or filesystems without symlink support, copy the file instead and re-sync when `AGENTS.md` changes.

3. Open the repo in your editor (VS Code or another Copilot-supported IDE) and start Copilot Chat. The instructions are loaded automatically; no slash command, no restart needed.

To use Copilot with tpm from another working repo, do the same thing in that repo's root with an absolute path. tpm's `AGENTS.md` is scope-clean (its repo-specific shipping rules live in `CONTRIBUTING.md`), so propagating it doesn't bleed tpm conventions into the other repo.

```sh
# from the other repo's root
mkdir -p .github
ln -sfn /path/to/tpm/AGENTS.md .github/copilot-instructions.md
```

If the other repo already has a `.github/copilot-instructions.md`, append tpm's content to it instead of replacing.

## Usage

Like Codex, Copilot doesn't have a tpm-specific slash command. Invoke actions in natural language; the agent reads the instructions and follows the matching procedure.

| You say                                | Action triggered           |
|----------------------------------------|----------------------------|
| "what's open in tpm?"                  | Situational awareness      |
| "start tpm task 011-agent-agnostic"    | Start a task               |
| "discuss tpm task 011"                 | Shape an open task         |
| "close tpm task 011"                   | Close out                  |

Copilot should run `tpm context <slug>` to load the briefing before acting — that's step 1 of every action.

## Caveats

- Copilot Chat's terminal/file-write capabilities depend on your IDE and plan. If Copilot can't run shell commands directly, paste `tpm` output into the chat and let it reason about next steps; for file edits, accept inline suggestions.
- `.github/copilot-instructions.md` is the canonical Copilot file as of writing — if GitHub renames it, update the symlink target.
- Don't run Copilot and another agent (Claude Code, Codex) on the same task slug simultaneously. They'll collide on file edits.
