---
name: release
description: Cut a tpm release. Reads commits since the last tag, classifies them, recommends a SemVer bump, drafts release notes, dispatches scripts/release.sh. Invoke when the user types /release [patch|minor|major].
---

# release

You are dispatching a tpm release. The mechanical sequence (verify, test, bump, commit, tag, push, GitHub release) lives in `scripts/release.sh`. Your job is the judgment layer on top of it: read what shipped since the last tag, recommend a bump, draft notes that read better than `gh --generate-notes` auto-output.

## Dispatch

Read `$ARGUMENTS`. Pick a mode.

### No args — recommend a bump
1. `cd "$(tpm path tpm)"` (or wherever the repo lives — let the user override if they're cutting a release in a different repo).
2. `LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")`. If empty, the recommendation is `minor` (first real release).
3. List commits since the tag: `git log "${LAST_TAG:+$LAST_TAG..}"HEAD --oneline --no-merges`.
4. Classify each commit by its subject line:
   - **Breaking** (major): mentions schema migration, removes a CLI flag/subcommand, changes a frontmatter field name, anything labeled `BREAKING:`.
   - **Feature** (minor): adds a new CLI subcommand, new flag, new behavior, new field.
   - **Fix** (patch): bug fix, doc-only change, refactor with no behavior change, test-only change.
5. Recommended bump: highest level that appears (any breaking → major; any feature → minor; otherwise patch).
6. Surface to the user:
   - Recommended bump + why.
   - Commit list grouped by category.
   - Draft of release notes (see format below).
   - Ask: "Cut `<bump>` with these notes?"

### `<bump>` — skip the recommendation
Same as above but skip the recommendation step; just draft notes for the requested bump and confirm.

### Releasing
Once the user confirms:
1. Write the drafted notes to `RELEASE_NOTES.md` at the repo root (will be picked up by `--notes`).
2. Run `./scripts/release.sh <bump> --notes RELEASE_NOTES.md`.
3. The script prints the GitHub release URL on success — surface it to the user.
4. Delete `RELEASE_NOTES.md` (it served its purpose; not committed to the repo).

If the script aborts (dirty tree, behind origin, tests fail, tag clash), surface the message verbatim and stop. Don't try to fix the precondition silently.

## Release notes format

```markdown
## v<X.Y.Z> — <YYYY-MM-DD>

### Features
- <one line per feature commit, rewritten for clarity>

### Fixes
- <bug fixes, doc-only changes>

### Other
- <refactors, test additions, anything that doesn't fit above>
```

Keep lines short and active. Drop `(#NN)` suffixes from commit messages — the GitHub release UI links PRs automatically. If a section is empty, omit its heading.

## SemVer cadence (solo project)

- **patch** — bug fixes, doc-only changes, no new behavior.
- **minor** — new features, backward-compatible.
- **major** — breaking schema/CLI changes.
- Stay at 0.x while the schema is in flux; bump to 1.0.0 when frontmatter shape and CLI verbs feel locked.

## Conventions

- Don't reimplement git/gh logic in the skill — delegate to `scripts/release.sh`. Your value is the prose layer.
- Don't auto-confirm. Always show the drafted notes and ask before invoking the script.
- The script is idempotent on preconditions (refuses dirty tree, tag clash, etc.). Trust it; don't pre-check the same things in the skill.
