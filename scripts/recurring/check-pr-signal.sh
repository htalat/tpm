#!/usr/bin/env bash
# Poll in-flight PRs and flip task status when a signal lands.
#
# For each `in-progress` task with a non-empty `prs:` list, queries the host
# CLI (`gh` for GitHub) for each PR, then hands the gathered JSON to
# `src/pr_signal.ts` for classification:
#
#   - CI red / behind main / reviewer comments -> needs-feedback (agent inbox)
#   - CHANGES_REQUESTED / merge conflict       -> needs-review   (human inbox)
#   - otherwise                                -> leave in-progress
#
# Idempotent: re-running over an already-flipped task is a no-op (the task is
# no longer `in-progress` once flipped, so the filter excludes it).
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
# of every in-progress task. Parse `tpm ls --status in-progress --flat`:
#   <project name>  (<project-slug>)  [<project-status>]
#     · <status>    <type>           <task-slug>  [prs...]
slugs=$(tpm ls --status in-progress --flat | awk '
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
  log_info "no in-progress tasks"
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

  prs_line=$(printf '%s\n' "$briefing" | awk '/^- PRs: / { sub(/^- PRs: /, ""); print; exit }')
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
  # FLIP line. Log every DECIDE as a structured INFO line; capture FLIP for
  # the mutation step.
  flip_status=""
  flip_reasons=""
  while IFS= read -r line; do
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
    esac
  done <<< "$classifier_out"

  if [ -z "$flip_status" ]; then
    no_signal=$((no_signal + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log_info "would flip $slug -> $flip_status ($flip_reasons)"
    flipped=$((flipped + 1))
    continue
  fi

  tpm status "$slug" "$flip_status" >/dev/null
  tpm log    "$slug" "poller — $flip_reasons" >/dev/null
  log_info "flipped $slug -> $flip_status ($flip_reasons)"
  flipped=$((flipped + 1))
done <<< "$slugs"

dry_suffix=""
[ "$DRY_RUN" = "1" ] && dry_suffix=" (dry-run)"
log_info "summary checked=$checked flipped=$flipped no-signal=$no_signal gh-failed=$gh_failed$dry_suffix"
