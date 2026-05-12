#!/usr/bin/env bash
# Poll in-flight PRs and flip task status when a signal lands.
#
# For each watched task with a non-empty `prs:` list, queries the host CLI
# (`gh` for GitHub) for each PR, then hands the gathered JSON to
# `src/pr_signal.ts` for classification. "Watched" = every `in-progress` task,
# plus every `ready` task that still carries a linked PR — see
# `shouldWatchForPrSignal` in src/pr_signal.ts, which this script calls per
# candidate rather than reimplementing the rule. (Why `ready`: a manual
# `needs-review -> ready` revert must not strand a task whose PR then merges —
# task 049.) The classifier returns:
#
#   - any linked PR merged                                 -> needs-close    (then auto-close inline)
#   - merge conflict / CI red / behind main / reviewer cmt -> needs-feedback (agent inbox)
#   - CHANGES_REQUESTED                                    -> needs-review   (human inbox)
#   - otherwise                                            -> leave the status as-is
#
# For the merged case the classifier also emits an OUTCOME block (PR title +
# stripped body + merge link) which this script feeds straight into
# `tpm complete --outcome` so the task closes in the same tick. Skipping the
# claude/skill spawn turns a 90-minute drain into a single poller tick. The
# `needs-close` flip happens first (preserves audit trail; one log line); if
# `tpm complete` fails the task stays at `needs-close` for the manual
# `/tpm done <slug>` escape hatch to pick up.
#
# Side effect: the classifier also writes each PR's JSON to
# ~/.tpm/pr-cache/<owner>/<repo>/<number>.json so `tpm serve`'s task page can
# render PR state (CI / review / mergeable) without its own `gh` round-trip.
#
# Idempotent: re-running over an already-flipped task is a no-op — once
# flipped to needs-feedback / needs-review / needs-close / done the task is no
# longer in the watch set (`in-progress`, or `ready`-with-a-PR), so it's
# excluded.
#
# v0 limitation: only `host: github` is implemented. ADO projects are skipped
# with a warning. Filling that in is the obvious follow-up.
#
# Logs use the structured format from scripts/recurring/_log.sh — one line per
# decision so a `grep 'action=no-signal'` shows everything the classifier
# passed on, not just the gh-failed skips.
#
# Usage: check-pr-signal.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFIER="$SCRIPT_DIR/../../src/pr_signal.ts"

# shellcheck source=_log.sh
. "$SCRIPT_DIR/_log.sh"

command -v tpm  >/dev/null || { log_error "tpm CLI not found"; exit 1; }
command -v gh   >/dev/null || { log_error "gh CLI not found";  exit 1; }
command -v node >/dev/null || { log_error "node not found";    exit 1; }
[ -f "$CLASSIFIER" ] || { log_error "classifier missing at $CLASSIFIER"; exit 1; }

# `gh pr view --json` fields requested per PR — sourced from the classifier
# so the request always matches what `classifyPrs` consumes.
GH_FIELDS=$(node -e "import('$CLASSIFIER').then(m => process.stdout.write(m.PR_JSON_FIELDS.join(',')))")

# Enumerate qualified slugs (`<project>/<task>` or `<project>/<parent>/<child>`)
# of every candidate task: every `in-progress` task, plus every `ready` task
# (the `ready` ones still need a linked PR to be in the watch set — that gets
# checked per task below via shouldWatchForPrSignal, once `tpm context` hands
# us the `prs:` list). Parse `tpm ls --status <S> --flat`:
#   <project name>  (<project-slug>)  [<project-status>]
#     · <status>    <type>           <task-slug>  [prs...]
slugs=$( { tpm ls --status in-progress --flat; tpm ls --status ready --flat; } | awk '
  /^[^ ]/ {
    # 2-arg match() + substr is portable; 3-arg match(..., arr) is gawk-only.
    if (match($0, /\([^)]+\)/)) proj = substr($0, RSTART + 1, RLENGTH - 2)
    next
  }
  /^  · / && proj != "" {
    # field 4 is the task slug after marker(·) status type
    print proj "/" $4
  }
')

flipped=0
no_signal=0
gh_failed=0
checked=0

if [ -z "${slugs:-}" ]; then
  log_info "no tasks to watch"
  exit 0
fi

while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  checked=$((checked + 1))

  err_tmp=$(mktemp)
  briefing=$(tpm context "$slug" 2>"$err_tmp") || {
    rc=$?
    log_warn "skip $slug (tpm context exit=$rc) — $(head -2 "$err_tmp" | tr '\n' ' ')"
    rm -f "$err_tmp"
    gh_failed=$((gh_failed + 1))
    continue
  }
  rm -f "$err_tmp"

  host=$(printf '%s\n' "$briefing" | awk '/^- Host: / { print $3; exit }')
  host=${host:-github}

  if [ "$host" != "github" ]; then
    log_warn "skip $slug (host=$host, not yet implemented)"
    gh_failed=$((gh_failed + 1))
    continue
  fi

  status=$(printf '%s\n' "$briefing" | awk '/^- Status: / { print $3; exit }')
  prs_line=$(printf '%s\n' "$briefing" | awk '/^- PRs: / { sub(/^- PRs: /, ""); print; exit }')

  # Is this task in the watch set? shouldWatchForPrSignal() in src/pr_signal.ts
  # is the single source of truth — pass it the status (read fresh from the
  # briefing; it may have moved since enumeration) and the comma-joined PR list.
  # The classifier path goes in the import() literal (not argv) so the module's
  # `main()` entrypoint guard doesn't fire. rc 0 = watch; 1 = skip (not a
  # watch-worthy status, or `ready` with no PR); 2 = the check itself errored.
  watch_rc=0
  node -e "
    import('$CLASSIFIER').then(({ shouldWatchForPrSignal }) => {
      const prs = String(process.argv[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      process.exit(shouldWatchForPrSignal({ status: process.argv[2], prs }) ? 0 : 1);
    }).catch((e) => { console.error(e); process.exit(2); });
  " "$prs_line" "$status" || watch_rc=$?
  if [ "$watch_rc" -eq 1 ]; then
    no_signal=$((no_signal + 1))
    continue
  elif [ "$watch_rc" -ne 0 ]; then
    log_warn "skip $slug (watch-check exit=$watch_rc)"
    gh_failed=$((gh_failed + 1))
    continue
  fi

  # Watched but no linked PR yet (an `in-progress` task that hasn't opened its
  # PR) — nothing to classify this tick.
  if [ -z "$prs_line" ]; then
    no_signal=$((no_signal + 1))
    continue
  fi

  # PRs may be comma-separated.
  IFS=',' read -ra urls <<< "$prs_line"

  # Collect per-PR JSON into a single array fed to the classifier. Each
  # element is the raw `gh pr view --json ...` payload (which already
  # includes `url`).
  payload="["
  first=1
  gh_error=0

  for raw in "${urls[@]}"; do
    url=$(printf '%s' "$raw" | awk '{$1=$1; print}')
    [ -n "$url" ] || continue

    err_tmp=$(mktemp)
    pr_json=$(gh pr view "$url" --json "$GH_FIELDS" 2>"$err_tmp") || {
      rc=$?
      log_warn "skip $slug (gh exit=$rc for $url) — $(head -2 "$err_tmp" | tr '\n' ' ')"
      rm -f "$err_tmp"
      gh_error=1
      break
    }
    rm -f "$err_tmp"

    if [ "$first" -eq 1 ]; then first=0; else payload+=","; fi
    payload+="$pr_json"
  done
  payload+="]"

  if [ "$gh_error" -eq 1 ]; then
    gh_failed=$((gh_failed + 1))
    continue
  fi

  classifier_out=$(printf '%s' "$payload" | node "$CLASSIFIER") || {
    rc=$?
    log_error "classifier exit=$rc for $slug"
    gh_failed=$((gh_failed + 1))
    continue
  }

  # Parse classifier output: zero or more DECIDE lines, then optionally one
  # FLIP line, then optionally an OUTCOME_BEGIN/_END block (only for
  # needs-close flips with a derivable Outcome). Log every DECIDE as a
  # structured INFO line; capture FLIP + OUTCOME for the mutation step.
  flip_status=""
  flip_reasons=""
  outcome=""
  in_outcome=0
  while IFS= read -r line; do
    if [ "$in_outcome" = "1" ]; then
      if [ "$line" = "OUTCOME_END" ]; then
        in_outcome=0
        continue
      fi
      outcome+="$line"$'\n'
      continue
    fi
    [ -n "$line" ] || continue
    case "$line" in
      "DECIDE "*)
        log_info "decide $slug ${line#DECIDE }"
        ;;
      "FLIP "*)
        rest=${line#FLIP }
        flip_status=${rest%% *}
        flip_reasons=${rest#"$flip_status" }
        ;;
      "OUTCOME_BEGIN")
        in_outcome=1
        ;;
    esac
  done <<< "$classifier_out"

  if [ -z "$flip_status" ]; then
    no_signal=$((no_signal + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    if [ "$flip_status" = "needs-close" ] && [ -n "$outcome" ]; then
      log_info "would auto-close $slug ($flip_reasons)"
    else
      log_info "would flip $slug -> $flip_status ($flip_reasons)"
    fi
    flipped=$((flipped + 1))
    continue
  fi

  tpm status "$slug" "$flip_status" >/dev/null
  tpm log    "$slug" "poller — $flip_reasons" >/dev/null

  # Auto-close inline when a linked PR merged AND we derived an Outcome from
  # the PR body. `tpm complete` flips needs-close -> done, stamps closed,
  # appends the Log line, archives per type. On failure (e.g. Outcome already
  # has content, lock contention) the task stays at needs-close for manual
  # /tpm done <slug>.
  if [ "$flip_status" = "needs-close" ] && [ -n "$outcome" ]; then
    outcome=${outcome%$'\n'}
    err_tmp=$(mktemp)
    if tpm complete "$slug" --outcome "$outcome" >/dev/null 2>"$err_tmp"; then
      rm -f "$err_tmp"
      log_info "auto-closed $slug ($flip_reasons)"
    else
      rc=$?
      log_warn "auto-close failed $slug (tpm complete exit=$rc) — $(head -2 "$err_tmp" | tr '\n' ' ') — leaving at needs-close"
      rm -f "$err_tmp"
    fi
  else
    log_info "flipped $slug -> $flip_status ($flip_reasons)"
  fi
  flipped=$((flipped + 1))
done <<< "$slugs"

dry_suffix=""
[ "$DRY_RUN" = "1" ] && dry_suffix=" (dry-run)"
log_info "summary checked=$checked flipped=$flipped no-signal=$no_signal gh-failed=$gh_failed$dry_suffix"
