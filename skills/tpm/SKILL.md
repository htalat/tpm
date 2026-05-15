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

- **Project frontmatter**: `name, slug, status, created, repo: {remote, local}, host, tags`. `host` is `github` (default) or `ado` — see the dispatch bullet under Conventions.
- **Task frontmatter**: `title, slug, project, status, type, created, closed, prs, tags` (inherits `repo` from project; can override by adding own `repo:` block). Optional `parent: <parent-slug>` marks the task as a child within a folder-form parent.
- **Task shapes** — a task is either:
  - **File form** (default): `tasks/NNN-slug.md`. Single file.
  - **Folder form**: `tasks/NNN-slug/task.md` plus optional `NNN-<sub>.md` siblings (each with `parent: NNN-slug` in frontmatter) and any other files (scratch notes, screenshots, design docs). The directory name is the parent's slug.
- A task with any children is a **container**: not actionable, never returned by `tpm next`, can't be discussed/started directly.
- **Statuses**: `open | ready | in-progress | needs-feedback | needs-close | needs-review | blocked | done | dropped`
  - `open` = user's queue (not yet shaped for an agent).
  - `ready` = agent's queue. Promoted via `/tpm discuss`.
  - `in-progress` = work in flight (for `type: pr` tasks, this includes the PR-open / awaiting-merge phase).
  - `needs-feedback` = agent's queue for in-flight PRs. Routes to `/tpm feedback`. Set by the PR-signal poller (merge conflict, CI red, behind main, open threads) or by the agent during a feedback round.
  - `needs-close` = transient/escape-hatch state. The PR-signal poller flips a task here on a MERGED PR then immediately auto-closes inline via `tpm complete --outcome "<derived>"` in the same tick, so the task is usually `done` by the time anyone looks. A task lingers at `needs-close` only when the inline auto-close fails (empty PR body, Outcome already filled, lock contention) — surface those with `tpm ls --status needs-close` and run `/tpm done <slug>` manually.
  - `needs-review` = human's queue. Agent escalated (design pushback, `CHANGES_REQUESTED`, a merge conflict the agent couldn't resolve). Surfaced via `tpm inbox`.
  - `blocked` = human's queue, external dep. Surfaced via `tpm inbox`.
  - Parent containers display a roll-up status (all children done → done; any in-progress → in-progress; else parent's declared status). The roll-up is display only — not written to frontmatter.
- **Types**: `pr | investigation | spike | chore`
- **Project body**: `## Goal`, `## Context`, `## Notes`, `## Log` (project-level timeline for cross-task events — pivots, milestones, decisions spanning tasks; keep per-task events in the task's own Log).
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
| `/tpm feedback <slug>`              | Handle PR feedback (in-flight)        |
| `/tpm done <slug>`                  | Close out                             |
| `/tpm new <project> <slug>`         | Scaffold a task                       |
| `/tpm new project <slug>`           | Scaffold a project                    |
| `/tpm fold <slug>`                  | Fold a task to folder-form            |
| `/tpm reparent <slug> <new-parent \| --top>` | Reparent a task                |
| `/tpm ls`, `/tpm inbox`, `/tpm report`, `/tpm root`, `/tpm path`, `/tpm context`, `/tpm init` | Pass through to the corresponding `tpm` subcommand |

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
3. **Dispatch by current status** (so an autonomous `/tpm <slug>` invocation does the right thing whatever state the poller has left the task in):
   - `needs-feedback` → switch to **Handle PR feedback** mode below. Stop the start flow.
   - `needs-close` → switch to **Close out** mode below. Stop the start flow.
   - `open` or `ready` → run `tpm start <arg>` to flip to `in-progress` and stamp a `started` Log entry. (Idempotent: already-`in-progress` is a no-op.)
   - anything else (`in-progress`, `needs-review`, `blocked`, terminal) → leave status alone and proceed.
4. `cd "$(tpm path <arg>)"` — that's where the work happens. If `tpm path` errors because no local path is set, ask the user for the path and offer to populate `repo.local` in the project (or task) file.
5. **Resolve the workflow doc.** This tells you how to validate, how to ship, and when to close.
   - If the briefing has a `Workflow:` line, read that file (path is relative to the repo root).
   - Else look for `AGENTS.md`, then `CLAUDE.md`, in the repo root.
   - Else ask the user before each shipping step (commit, push, PR, close).
6. Read the task body and execute the Plan. If the type is `investigation`, your output is findings — write them into the body, not just chat.
7. As you make meaningful progress, run `tpm log <slug> "<what changed>"` to append a timestamped Log entry. Don't load the task file just to write a Log line.
8. **To ship**, follow the workflow doc verbatim: validate (run any checks/tests it names), commit, push, open PR if directed, close the task if directed. If you open a PR, run `tpm pr <slug> <url>` — that adds the URL to `prs:`, logs the open, and auto-flips `in-progress → needs-review` (the handoff to the human). If the workflow says "close after merge" (the default for `type: pr`), stop after `tpm pr` — the poller closes the task inline when the PR merges; manual `/tpm done <task>` is the escape hatch.
9. If you hit a blocker you can't resolve: run `tpm block <slug> "<reason>"` to set `status: blocked` and log the reason. Then surface to the user instead of guessing.
10. **Never exit while the task is still `in-progress`.** A task at `in-progress` with no active agent is stranded — `tpm next` excludes it (presumed claimed), no one picks it up, it sits forever until a human notices. On every exit path, leave the task in a recoverable state:
    - **Work shipped** (PR opened, investigation findings written into the body, etc.): the relevant CLI call (`tpm pr`, `tpm complete`) has already flipped the status. Nothing more to do.
    - **Can't proceed but the next round might unblock you** (waiting on a dependency, partial investigation that needs another pass, missing info that may arrive): run `tpm revert <slug> "<reason>"` — flips back to `ready` with a Log line so another orchestrator tick can re-pick it. Investigations that are incomplete after one round especially need this: write what you found into the body, then revert. The orchestrator has a safety net that auto-reverts a clean-exit-at-`in-progress`, but rely on it only as a last resort; an explicit `tpm revert` with a reason is better signal for whoever (or whatever) re-picks the task.
    - **Genuinely blocked** (need a human decision, missing credentials, design pushback): see step 9.

    If you find yourself about to exit while the task is still `in-progress`, stop and pick one of the above first. `tpm revert` is the safe default if you can't make a confident classification.

**Default for unanticipated decisions.** When a fork comes up during implementation that the task body didn't pre-answer, pick the smaller / more local change, ship it, and note the deferred consideration in the Outcome (or file a follow-up task). Don't stop to ask — the user reviews the PR; redirection happens there. The canonical anti-pattern: task 046 (2026-05-10) — the agent finished correct in-scope work, then halted to ask about a related-but-out-of-scope extension; the work sat uncommitted until the user picked it up manually.

Exceptions — halt and surface instead of shipping:
- **Irreversible / destructive actions**: force-push to `main`, `rm -rf` outside the worktree, dropping migrations, deleting non-recoverable state, mass-rewriting user files outside the task scope.
- **Genuinely ambiguous task intent**: if the task body is so unclear you can't tell what to ship, that's a `tpm block` situation (step 9), not "ship smaller and hope."

"I'd like a second opinion before extending scope" is not a blocker. "I can't tell from the task what the scope is" is.

### Shape an open task (`/tpm discuss <slug>`)
Shape a task's Plan before any execution. Pure conversation that lands in the task body — never edits code, never `cd`s into the repo, never flips status to `in-progress`.
1. Run `tpm context <arg>`. Read the briefing in full.
2. If the task is a parent container (has children), discuss is not applicable — list the children and ask which one to shape instead.
3. **Do not** `cd`. **Do not** edit code in `repo.local`. **Do not** set `status: in-progress`.
4. Read `## Context` and `## Plan`. If thin or missing key details, ask clarifying questions: scope, constraints, what "done" looks like, dependencies on other tasks, open decisions.
5. As alignment forms, write back to the task body via direct file edit — `## Context` for facts and background, `## Plan` for the agreed approach, optionally a `## Done =` section. Body authoring is the one place you still edit the task file directly. For the Log line, use `tpm log <arg> "<what was discussed/decided>"` rather than editing manually.
6. (Optional) Ask whether the task is safe to run unattended. If yes, set `allow_orchestrator: true` in the frontmatter — relevant once scheduled orchestration ships, harmless before then.
7. End condition: the user signals alignment ("okay let's go", "that looks right", "yes start it"). Run `tpm ready <arg>` — that flips status to `ready` and logs `promoted to ready` in one call. Then stop. Final hand-off message: `Ready. Run /tpm <slug> to execute.`
8. If discussion concludes the task isn't worth doing: edit `## Outcome` with the reason (file edit; `tpm complete --outcome` would set status to `done` rather than `dropped`), then run `tpm status <arg> dropped`. Don't promote.

**Open questions should be answered, not just enumerated.** A `## Open questions` section that lists questions without defaults turns each one into a halt point for the implementing agent (the "ship the smaller change" rule in **Start a task** only covers decisions the task body didn't mention at all — listed-but-unanswered questions are louder than that). Answer each question with a v0 default, even a tentative one. If a question genuinely can't be decided up front, mark it explicitly: `Decide during implementation; default to <X>.` The implementing agent then has an instruction rather than an open prompt.

Discuss mode is the canonical way to move a task from `open` to `ready`. A human can also flip the status manually, but `/tpm discuss` encodes the discipline (Context/Plan populated, Log timestamped, explicit confirmation).

### Pick the next ready task and run it (`/tpm next`)
Auto-select mode. Resolves the next eligible leaf task (parents are skipped) and dispatches the right mode based on its status. Selection priority: `needs-feedback` > `ready`. (`needs-close` isn't in the priority — the poller auto-closes merged PRs inline. Stragglers go through the manual `/tpm done <slug>` escape hatch.)
1. Run `tpm next` (optionally with `--project <slug>`). It prints a qualified slug on success or exits non-zero if nothing is eligible.
2. If non-zero, surface the message and stop. Don't fall back to `open` tasks — the human needs to promote one via `/tpm discuss` first.
3. On success, look at the task's status (`tpm context <slug>` shows it). Dispatch by status:
   - `ready` → **start a task** mode (same flow as `/tpm <slug>`).
   - `needs-feedback` → **handle PR feedback** mode (same flow as `/tpm feedback <slug>`).

`/tpm next` is the manual path. Use `tpm next --autonomous` only from scheduled/unattended runs (filters to tasks with `allow_orchestrator: true`); the manual `/tpm next` skill mode does not pass `--autonomous`.

### Handle PR feedback (`/tpm feedback <slug>`)
For the in-flight phase of a `type: pr` task — the PR is open, the task is `in-progress` or `needs-feedback`, and a CI failure / stale branch / review thread needs attention. Re-entrant: invoke once per round.

1. Run `tpm context <arg>`. Read the briefing. **Refuse if `prs:` is empty** — there's no PR to give feedback on. If the task is `done`/`dropped`/`blocked`, also refuse.
2. **Gather signal** for each linked PR using the host CLI per `Host:` in the briefing (`gh` for github, `az repos pr` for ado):
   - `gh pr view <url> --json state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,latestReviews`. `reviewThreads` isn't a `gh pr view --json` field — use `gh api graphql` (query `repository.pullRequest.reviewThreads`) or the PR page if you need resolution state.
   - Surface review state (APPROVED / CHANGES_REQUESTED / COMMENTED / REVIEW_REQUIRED), open review threads (line + body), CI status, mergeability (CLEAN / BEHIND / DIRTY / BLOCKED / UNSTABLE).
3. **Pick what to address** in priority order (rebase first, CI next, threads last) — rebases resolve a class of issues; CI tells you whether the current code even works:
   1. `BEHIND` (stale) or `DIRTY` (conflict)
   2. CI failures
   3. Open review threads
   If nothing is actionable, tell the user and stop. Status unchanged.
4. `cd "$(tpm path <arg>)"` and check out the PR's branch (`gh pr checkout <url>` for github; fetch + checkout the source branch for ado).
5. **Apply the fix:**
   - **Stale (`BEHIND`)**: `git fetch origin main && git rebase origin/main`. Clean → continue; conflicts → use the flow below.
   - **Merge conflict (`DIRTY`)**: rebase and try to resolve. Binary conflict → escalate. Mechanical patterns (both sides added imports, adjacent edits to the same line, rename + edit) → apply the resolution that preserves both sides' intent. **Then run the workflow doc's test command**: tests pass → `git add` + `git rebase --continue`; tests fail → `git rebase --abort` and escalate. Don't commit a resolution you can't verify.
   - **CI failures**: `gh run view <run-id> --log-failed`; fix; commit.
   - **Review threads**: for threads with concrete code suggestions, apply and commit. When the fix matches the suggestion exactly, you may resolve via `gh api .../threads/<id>/resolve`. Ambiguous / design-level / debatable threads → escalate.
6. **Push** the fix: `git push`. After a rebase, `git push --force-with-lease` (never plain `--force` — it can clobber a reviewer's concurrent commit).
7. **Escalate to `needs-review`** when the signal isn't agent-addressable (rebase whose conflict the agent couldn't resolve cleanly, design pushback, ambiguous thread, `CHANGES_REQUESTED` you can't translate to a fix):
   - `tpm status <arg> needs-review`
   - `tpm log <arg> "escalated — <one-line reason; link the thread or run>"`. For a rebase escalation, name the conflicting files so the human knows where to look.
   - Surface to the user and stop. Don't argue with the reviewer in chat.
8. **Log + status** after a successful round:
   - `tpm log <arg> "addressed feedback — <one-line summary>"`
   - If the task was `needs-feedback`, run `tpm status <arg> in-progress`. If already `in-progress`, no-op.
9. The PR-signal poller re-flags the task if a new signal lands. Each round = one more `/tpm feedback <arg>` invocation.

Don't auto-merge, don't reply conversationally without a fix, don't long-poll for CI, don't `--force` push. Always `--force-with-lease` for rewritten history.

### Close out (`/tpm done <slug>`)
1. Read the task file.
2. **Verify PR merge status** if `prs:` is non-empty. For each PR URL, run `gh pr view <url> --json state --jq '.state'`.
   - At least one `MERGED` → proceed.
   - All `OPEN` or `CLOSED` (none merged) → ask once: "PR not merged; close anyway?" Respect the answer. This is the only legitimate ask in close-out.
   - `gh` not installed or not auth'd → fall back to the same ask. Don't fail hard.
   - `prs:` empty (direct-push task) → skip merge detection.
   - **Shortcut:** if the task's current status is `needs-close`, the poller has already verified a linked PR merged — you can skip the `gh pr view ... --jq '.state'` round trip and proceed directly.
3. Fill `## Outcome` with what shipped, what changed, what was learned. Reference PRs. (Free-form prose: edit the file directly. The CLI will refuse to overwrite an Outcome that already has content, so author it before the next step.)
   - **Autonomous fill (status `needs-close`):** when invoked from `/tpm next` on a `needs-close` task, you may fill `## Outcome` from PR signal (title + body + recent commits via `gh pr view <url> --json title,body,commits`) without prompting the user. The merge already shipped; a faithful summary of the PR description is an acceptable Outcome. Reference each merged PR.
4. Run `tpm complete <arg>`. This flips status to `done`, stamps `closed`, appends a `closed` Log line, and **archives by type**: `pr`/`chore` move under `tasks/archive/`; `investigation`/`spike` stay at the canonical path so `tpm ls --status done` and `tpm context <slug>` continue to find them. Override the default with `--archive` or `--no-archive` when needed.
5. **Cleanup local branch** (when at least one linked PR was merged). For each merged PR:
   - `BRANCH=$(gh pr view <url> --json headRefName --jq '.headRefName')`. Skip if `BRANCH` equals the project's default branch (typically `main`).
   - `cd "$(tpm path <task>)"`. If the local branch doesn't exist (`git rev-parse --verify "$BRANCH"` fails), skip — already cleaned up.
   - `git checkout main && git pull --ff-only`.
   - `git branch -d "$BRANCH"`. **Use `-d`, not `-D`** — if git refuses (e.g., you kept working on the branch after merge), surface the message and let the user decide. Don't force-delete.
   - Check the remote: `git ls-remote --heads origin "$BRANCH"`. If it still exists (GitHub's auto-delete-head-branches isn't on for this repo), print the one-liner `git push origin --delete <BRANCH>` for the user to copy/paste. Don't run it silently.
6. Print a one-line confirmation: new status, archive path (or "kept at <path>" for investigations/spikes), and the remote-delete hint if applicable.

### Scaffold (`/tpm new <project> <slug>`)
Two args after `new` ⇒ task. Three with leading `project` ⇒ project.
1. Run the appropriate `tpm new ...` with `--title`/`--name` if the user hinted at one.
2. Open the new file. Either populate Context/Plan from the user's request or ask for them.
3. For `new project`, also ask about `--repo` and `--path` if not provided.
4. To create a child task, pass `--parent <parent-slug>` to `tpm new task`. The parent is folded automatically if it isn't already.

### Fold a task to folder-form (`/tpm fold <slug>`)
Use when a task needs supporting files (subtasks, scratch notes, screenshots) alongside it. `tpm fold <task>` rewrites `tasks/NNN-slug.md` to `tasks/NNN-slug/task.md`. Idempotent. Children can then be added with `tpm new task <project> <child> --parent <slug>`.

### Reparent a task (`/tpm reparent <slug> <new-parent | --top>`)
Use when a task ends up in the wrong place — needs to become a child of an existing parent, move between parents, or be promoted back to top-level.

- `tpm reparent <task> <new-parent>` moves a task under a new parent. Folds the new parent automatically if it's still file-form. Renumbers within the destination container.
- `tpm reparent <task> --top` promotes a child back to top-level (drops `parent:` from frontmatter).

Refuses to move a task that has children (would create grandchildren), a folder-form task (would orphan supporting files — flatten manually first), or any move that would land the task under a child task. Also refuses no-op moves. Cross-project moves aren't supported — `<new-parent>` resolves within the source task's project.

### Pass-through (`/tpm ls`, `/tpm report`, `/tpm root`, `/tpm path`, `/tpm context`, `/tpm init`)
Just run the corresponding `tpm` subcommand and print the result.

## Conventions

- **Prefer CLI verbs over manual file edits for state changes.** `tpm start | ready | complete | block | reopen | revert | log | pr | status | archive | fold | reparent | new` cover frontmatter and Log mutations. Manual file edits are only for body-text authoring (`## Context`, `## Plan`, `## Outcome`).
- When you do edit a task file directly, only touch the four canonical body sections. Preserve key order in frontmatter.
- Timestamps: the CLI verbs stamp `tpm now` automatically. If you need to write one yourself, use `tpm now` (format `YYYY-MM-DD HH:MM <ZZZ>` in the configured TZ — defaults to Pacific). Don't guess or hand-format.
- Don't manually create project/task files where `tpm new` would do it.
- If `tpm` errors with "No tpm tree configured", offer to run `tpm init` (default `~/tpm`).
- Keep edits to the user's actual code repos separate from edits to task files — task files are tracker state, not code.
- Surface CLI errors directly; don't paper over them.
- **PR-related commands dispatch on `Host:` in the briefing.** `github` → `gh` (e.g. `gh pr view`, `gh pr checkout`); `ado` → `az repos pr` (e.g. `az repos pr show`, `az repos pr checkout`). The procedures above show `gh` examples for brevity; substitute the ADO equivalent when the project's host is `ado`. No adapter layer in tpm — agents map commands themselves.
