#!/usr/bin/env bash
# Poll in-flight PRs and flip task status when a signal lands.
#
# For each watched task with a non-empty `prs:` list, hands the PR URLs to
# `src/pr_signal.ts`. That module dispatches to a host adapter per URL
# (src/hosts/github.ts → `gh`, src/hosts/ado.ts → `az repos pr`, ...) which
# fetches the wire JSON, maps it to the coarse PrSignal vocabulary, and
# writes the raw payload to the cache. The classifier then aggregates signals
# across all linked PRs and emits:
#
#   - any linked PR merged                                 -> needs-close    (then auto-close inline)
#   - merge conflict / CI red / behind main / reviewer cmt -> needs-feedback (agent inbox)
#   - CHANGES_REQUESTED / abandoned                        -> needs-review   (human inbox)
#   - otherwise                                            -> leave the status as-is
#
# "Watched" = every non-terminal task with a linked PR, plus every
# `in-progress` task (even without a PR yet — round in flight may open one
# mid-tick) — see `shouldWatchForPrSignal` in src/pr_signal.ts, which this
# script calls per candidate rather than reimplementing the rule. The
# enumeration below feeds candidates from each watched status; the per-task
# predicate is the source of truth on whether to actually fetch. Both ends of
# the lifecycle matter: a manual `needs-review -> ready` revert mustn't
# strand a task whose PR then merges (task 049), and a task that has already
# moved past `in-progress` to `needs-review` / `needs-feedback` /
# `needs-close` still has a live PR generating events (task 055).
#
# For the merged case the classifier also emits an OUTCOME block (PR title +
# stripped body + merge link) which this script feeds straight into
# `tpm complete --outcome` so the task closes in the same tick. Skipping the
# claude/skill spawn turns a 90-minute drain into a single poller tick. The
# `needs-close` flip happens first (preserves audit trail; one log line); if
# `tpm complete` fails the task stays at `needs-close` for the manual
# `/tpm done <slug>` escape hatch to pick up.
#
# Side effect: each PR's raw payload is written to
# ~/.tpm/pr-cache/<host-namespaced-path>.json so `tpm serve`'s task page can
# render PR state without its own network round-trip.
#
# Host coverage (task 052): github (via `gh`) and ado (via `az repos pr` +
# `az pipelines runs list`). Per-host CLI presence is checked inside the
# adapter — an ADO-only user doesn't need `gh` installed, and vice versa.
# A misconfigured host on one task is logged per-PR and doesn't poison the
# rest of the tick.
#
# Idempotent: re-running over an already-correctly-statused task is a no-op
# — the classifier returns no-signal when the task's status already matches
# the PR's signal. (Tasks remain in the watch set across non-terminal
# statuses; idempotency comes from the classifier, not the filter.)
#
# Logs use the structured format from scripts/recurring/_log.sh — one line per
# decision so a `grep 'action=no-signal'` shows everything the classifier
# passed on, not just the fetch-failed skips.
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
command -v node >/dev/null || { log_error "node not found";    exit 1; }
[ -f "$CLASSIFIER" ] || { log_error "classifier missing at $CLASSIFIER"; exit 1; }
# Host CLIs (gh / az) are checked per-task inside their adapter — an ADO-only
# user shouldn't need `gh`, and vice versa. Misconfig surfaces as a per-PR
# DECIDE action=error line, not a script-wide abort.

# Enumerate qualified slugs (`<project>/<task>` or `<project>/<parent>/<child>`)
# of every candidate task. Pull from each watched status — the per-task
# predicate (shouldWatchForPrSignal, called below once `tpm context` hands us
# the `prs:` list) is the source of truth on whether to actually fetch; this
# enumeration just has to feed it the right candidates. Parse `tpm ls
# --status <S> --flat`:
#   <project name>  (<project-slug>)  [<project-status>]
#     · <status>    <type>           <task-slug>  [prs...]
slugs=$( {
  tpm ls --status in-progress    --flat
  tpm ls --status ready          --flat
  tpm ls --status needs-review   --flat
  tpm ls --status needs-feedback --flat
  tpm ls --status needs-close    --flat
} | awk '
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
fetch_failed=0
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
    fetch_failed=$((fetch_failed + 1))
    continue
  }
  rm -f "$err_tmp"

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
    fetch_failed=$((fetch_failed + 1))
    continue
  fi

  # Watched but no linked PR yet (an `in-progress` task that hasn't opened its
  # PR) — nothing to classify this tick.
  if [ -z "$prs_line" ]; then
    no_signal=$((no_signal + 1))
    continue
  fi

  # PRs may be comma-separated. Newline-separated list is what the classifier
  # reads from stdin (one URL per line); host dispatch + fetch happens there.
  IFS=',' read -ra urls <<< "$prs_line"
  url_input=""
  for raw in "${urls[@]}"; do
    url=$(printf '%s' "$raw" | awk '{$1=$1; print}')
    [ -n "$url" ] || continue
    url_input+="$url"$'\n'
  done

  if [ -z "$url_input" ]; then
    no_signal=$((no_signal + 1))
    continue
  fi

  classifier_out=$(printf '%s' "$url_input" | node "$CLASSIFIER") || {
    rc=$?
    log_error "classifier exit=$rc for $slug"
    fetch_failed=$((fetch_failed + 1))
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
log_info "summary checked=$checked flipped=$flipped no-signal=$no_signal fetch-failed=$fetch_failed$dry_suffix"
