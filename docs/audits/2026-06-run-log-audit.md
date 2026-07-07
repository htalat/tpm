# tpm improvement report — mined from agent run logs

Source: NDJSON run-log transcripts from recent tasks across 4 projects (June 2026):
`tpm/147-add-session-id`, `tpm/093-cross-platform-support` (19 logs), `tpm/148–152`
(serve/UI batch), `agrotech/001–004` (PR + investigation), `awaz/001-monorepo-restructure`.
Findings are about **tpm the tool** (CLI, workflow/status model, orchestrator, `tpm serve`,
AGENTS.md/skill), not the code the agents were writing. Each theme aggregates corroborating
evidence across multiple slices; the count of slices that independently hit it is the strongest
signal.

---

## Top themes (ranked by leverage)

### 1. The agent can't reach its own briefing — task tree lives outside the sandbox  ★ HIGH, 3 slices
The task tree (`~/Documents/projects/...`) is outside the agent's working dir / sandbox
(`~/Developer/<repo>`), so agents that try to read task state by shelling into it get blocked.
- `cat .../148.../task.md` → "may only concatenate files from /Users/htalat/Developer/tpm" (148, 151).
- Parent of 093 tried `ls`/`find` under its task dir → blocked; fell back to `tpm ls --all | grep`.
- **Project `## Notes` never reach the agent at all**: in 3 of 4 agrotech threads the agent
  declared "No workflow doc found" and re-derived the dist/master/`serve.js` facts that were
  *already written in the project Notes* (work-from-dist, branch-off-master, validate with
  `node serve.js` + Playwright). Wasted effort + real risk of ignoring conventions.

**Fix:**
- Make `tpm context <task>` the complete, self-sufficient briefing and steer agents to it
  exclusively (never `cat task.md`). It should include the parent project's `## Notes`
  (the de-facto Workflow doc), the children list, and current branch/working state.
- Add `tpm children <slug>` (or `tpm ls --under <slug>`) so parents never shell into the tree.
- Ensure `tpm` is on PATH in the agent env (agents kept falling back to `./bin/tpm`, which then
  hit permission prompts).

### 2. Tasks strand at `in-progress` on abnormal exit  ★ HIGH, 3 slices
A run that dies or resumes without shipping leaves the task at `in-progress` — `tpm next` then
skips it (presumed claimed) and it sits.
- `awaz/001`: died on credit exhaustion mid-verification; no tpm call, `prs: []`, still in-progress.
- `093/004-windows-symlink-fallback`: full run died mid-task ("Now update the help text"),
  then the orchestrator relaunched a rate-limited stub **every ~5 min with no backoff** (4
  consecutive "You're out of extra usage" runs) — each a silent re-entry, not a clean re-claim.
- `147`: a feedback-resumed run "never replied to the reviewer and never flipped status back
  out of in-progress"; a later agent had to detect and fix the state.

The existing lock-expiry sweep (db3e06c / task 145) only reverts to `ready` on lock expiry;
it doesn't cover (a) run-ended-with-open-PR-but-still-in-progress, or (b) rate-limit death.

**Fix:**
- Detect a run that ended with an open PR but status still `in-progress` → auto-flip to review.
- Detect rate-limit / `out_of_credits` exit → back off until the reset time instead of relaunching
  every interval; revert the child to `ready` / release its lock so the relaunch is a clean
  re-claim rather than a silent re-entry into a half-done run.

### 3. `tpm pr` is not idempotent and doesn't advance status when the URL is already linked  ★ HIGH, 2 slices
- agrotech 001 & 002: the agent wrote `prs:` itself, then `tpm pr` short-circuited with
  "PR already linked" **and skipped the in-progress→review flip**. Both agents then ran
  `tpm --help` hunting for "the right status command" and fell back to manual `tpm status`.
- No tpm-supported path for a re-opened/superseded PR: agrotech 002's PR #11 auto-closed when
  its stacked base merged; the agent opened #12 and again fell back to `tpm status` (not `tpm pr`).
- 147: an agent spent ~10 grep/find commands reading `cli.ts`/`VALID_STATUSES` just to learn
  how to flip a task to review — there's no discoverable verb.

**Fix:**
- `tpm pr` should perform the in-progress→review transition even when the URL is already present
  (idempotent), and should append/replace a new URL + re-flip (covers reopened/superseded PRs).
- When it genuinely no-ops, the message should name the exact follow-up command.
- Add a discoverable `tpm review <task>` verb for re-flagging.

### 4. CLI vocabulary mismatches the docs and isn't discoverable at runtime  ★ MEDIUM, 3 slices
- `tpm done` is **not a real verb** — `tpm done linux-scheduler-adapter` → "Unknown command:
  done", retry with `tpm complete`. Yet AGENTS.md and the skill reference `/tpm done <slug>`
  everywhere (the slash-command alias). Predictable trap.
- Stale status words: agents consistently emitted `needs-review`/`needs-feedback` (pre-June-2026
  names) because the skill/AGENTS guidance still teaches them — risks invalid status writes
  post-migration.
- No runtime listing of the valid status vocabulary or transition verbs.

**Fix:**
- Add `done` as an alias for `complete` (or an "did you mean `tpm complete`?" hint).
- `tpm status` with no arg should print valid statuses + transition verbs (single source of
  truth — agents stop reading source).
- Audit AGENTS.md + the skill for stale status vocabulary.

### 5. New-project / first-task setup has no guardrails  ★ HIGH, 1 slice (but systemic)
From `awaz/001` (a brand-new project's first task):
- It was `type: pr` on a repo with **no remote and zero commits** — a PR can never be produced.
  Agent: "this is a fresh repo with zero commits and no remote… the 'refresh main / pull
  --ff-only' rule doesn't map."
- Doubled local path `repo.local: …/awaz/awaz`; the sandbox root pins there, so `rm`/`rmdir`
  of `src/` outside it was blocked.
- (Related, earlier in agrotech: tpm assumed `main` while the repo's default branch was `master`.)

**Fix:**
- At scaffold, if `repo.remote` is empty, warn / steer to a local task type, or block orchestrator
  claim of a `type: pr` task until a remote exists.
- Detect the repo's actual default branch instead of assuming `main`.
- Validate `repo.local` for a suspicious doubled trailing segment.
- AGENTS.md should special-case the empty-repo / first-commit pre-flight (establish a baseline
  commit; skip the ff-only pull).

### 6. Resume runs have zero awareness they're resuming  ★ HIGH, 1 slice
`093/004` resume cold-started (`git status`, `cat CONTRIBUTING.md`, `ls skills/`, re-onboard) and
**landed on another task's branch (`refresh-skills`) with that task's uncommitted work in the
tree** — never flagged it was a resume.

**Fix:** when `tpm start`/`next` picks a task already `in-progress` with prior run logs, surface a
"resuming — N prior runs, branch X, uncommitted changes present" banner and a branch-hygiene check
so the agent reconciles state before working.

### 7. Serve UI changes are never smoke-tested against a running server  ★ MEDIUM, 1 slice
All four serve-UI tasks (148, 149, 151, 152) verified **only** via `npm test`. None ran
`tpm serve`, bound a port, or curled a route/redirect — rendered-HTML and redirect behavior went
unexercised end-to-end. (Notably, the 152 numeric-id route and 151 session-id rendering shipped
without a live check.)

**Fix:** document a deterministic serve smoke-test in AGENTS.md/skill (start on a free port, curl
the route + assert status/redirect), or ship a fixture-tree harness.

### 8. Umbrella close-out doesn't check `Done =` against children  ★ MEDIUM, 1 slice
093's umbrella required `notify-send` in its Linux-phase "Done =", but no child task covered it;
all 6 children merged while the umbrella goal was unmet. The agent only caught it by reading
`notify.ts`.

**Fix:** rollup/close-out should diff the parent's `Done =` checklist against completed children
and warn before letting the umbrella flip to review/done.

---

## Lower-priority / cross-cutting

- **Permission churn** (LOW, harness-adjacent but tpm-actionable, 3 slices): awaz had 17
  "command requires approval" errors (compound bash, pnpm), `tpm pr`/`./bin/tpm` prompted in 149.
  tpm could ship a `.claude/settings.json` allowlist (read-only git/node/pnpm + safe tpm verbs)
  at project-scaffold time.
- **Child slug addressing inconsistency** (LOW, 093): agents used short, doubled
  (`002-002-…`), and fully-qualified forms interchangeably. Have `tpm next`/`start` echo the exact
  canonical slug to reuse, and document one preferred child-addressing form.
- **Dev invocation unclear** (LOW, 147): `node bin/tpm help` → SyntaxError (bin/tpm is a shell
  wrapper). Document the dev invocation in AGENTS.md.

## Already addressed (for context)
- `tpm session <slug>` couldn't resolve archived tasks → fixed by task 150 (PR #156).
- Stale-lock revert-to-ready → db3e06c / task 145 (partial coverage of theme 2).

---

## Suggested next actions (highest leverage first)
1. **Fold project `## Notes` + children + branch state into `tpm context`** and make it the
   only briefing path (themes 1, partially 6). Single change, kills the most recurring friction.
2. **Make `tpm pr` idempotent + add `tpm review`** (theme 3).
3. **Close the in-progress strand gaps**: open-PR-at-exit auto-review, and rate-limit backoff +
   clean re-claim (theme 2).
4. **`tpm done` alias + runtime status listing + AGENTS.md vocab audit** (theme 4).
5. New-project guardrails (theme 5); resume banner (6); serve smoke-test doc (7); umbrella
   Done=-vs-children check (8).
