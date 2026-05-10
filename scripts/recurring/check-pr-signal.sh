#!/usr/bin/env bash
# Poll in-flight PRs and flip task status when a signal lands.
#
# For each `in-progress` task with a non-empty `prs:` list, queries the host
# CLI (`gh` for GitHub) and classifies the PR's state:
#
#   - CI red / behind main / open review threads -> needs-feedback (agent inbox)
#   - CHANGES_REQUESTED / merge conflict          -> needs-review   (human inbox)
#   - otherwise                                   -> leave in-progress
#
# Idempotent: re-running over an already-flipped task is a no-op (the task is
# no longer `in-progress` once flipped, so the filter excludes it).
#
# v0 limitation: only `host: github` is implemented. ADO projects are skipped
# with a warning. Filling that in is the obvious follow-up.
#
# Usage: check-pr-signal.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

command -v tpm >/dev/null || { printf 'check-pr-signal: tpm CLI not found\n' >&2; exit 1; }
command -v gh  >/dev/null || { printf 'check-pr-signal: gh CLI not found\n' >&2; exit 1; }
command -v jq  >/dev/null || { printf 'check-pr-signal: jq not found\n' >&2; exit 1; }

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
skipped=0
checked=0

if [ -z "${slugs:-}" ]; then
  printf 'check-pr-signal: no in-progress tasks\n'
  exit 0
fi

while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  checked=$((checked + 1))

  briefing=$(tpm context "$slug" 2>/dev/null) || {
    printf 'check-pr-signal: skip %s (context lookup failed)\n' "$slug" >&2
    skipped=$((skipped + 1))
    continue
  }

  host=$(printf '%s\n' "$briefing" | awk '/^- Host: / { print $3; exit }')
  host=${host:-github}

  if [ "$host" != "github" ]; then
    printf 'check-pr-signal: skip %s (host=%s, not yet implemented)\n' "$slug" "$host"
    skipped=$((skipped + 1))
    continue
  fi

  prs_line=$(printf '%s\n' "$briefing" | awk '/^- PRs: / { sub(/^- PRs: /, ""); print; exit }')
  if [ -z "$prs_line" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  # PRs may be comma-separated.
  IFS=',' read -ra urls <<< "$prs_line"

  new_status=""
  reasons=()

  for raw in "${urls[@]}"; do
    url=$(printf '%s' "$raw" | awk '{$1=$1; print}')
    [ -n "$url" ] || continue

    signal=$(gh pr view "$url" \
      --json state,reviewDecision,statusCheckRollup,mergeStateStatus,reviewThreads \
      --jq '{
        state: .state,
        reviewDecision: .reviewDecision,
        ciFailed: ([.statusCheckRollup[]? | select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "ACTION_REQUIRED" or .conclusion == "CANCELLED")] | length > 0),
        behind: (.mergeStateStatus == "BEHIND"),
        conflicting: (.mergeStateStatus == "DIRTY"),
        openThreads: ([.reviewThreads[]? | select(.isResolved == false)] | length > 0)
      }' 2>/dev/null) || {
      printf 'check-pr-signal: skip %s (gh query failed for %s)\n' "$slug" "$url" >&2
      continue
    }

    state=$(printf '%s' "$signal"        | jq -r '.state // "UNKNOWN"')
    review=$(printf '%s' "$signal"       | jq -r '.reviewDecision // ""')
    ci_failed=$(printf '%s' "$signal"    | jq -r '.ciFailed')
    behind=$(printf '%s' "$signal"       | jq -r '.behind')
    conflicting=$(printf '%s' "$signal"  | jq -r '.conflicting')
    open_threads=$(printf '%s' "$signal" | jq -r '.openThreads')

    # Closed/merged PRs are out of scope for in-flight signal. /tpm done picks
    # them up when the user runs close-out.
    [ "$state" = "OPEN" ] || continue

    # needs-review wins over needs-feedback (human eyes outrank agent fixup).
    if [ "$conflicting" = "true" ]; then
      new_status="needs-review"
      reasons+=("merge conflict on $url")
    elif [ "$review" = "CHANGES_REQUESTED" ]; then
      new_status="needs-review"
      reasons+=("CHANGES_REQUESTED on $url")
    elif [ -z "$new_status" ] && [ "$ci_failed" = "true" ]; then
      new_status="needs-feedback"
      reasons+=("CI failed on $url")
    elif [ -z "$new_status" ] && [ "$behind" = "true" ]; then
      new_status="needs-feedback"
      reasons+=("branch behind main on $url")
    elif [ -z "$new_status" ] && [ "$open_threads" = "true" ]; then
      new_status="needs-feedback"
      reasons+=("open review threads on $url")
    fi
  done

  if [ -z "$new_status" ]; then
    continue
  fi

  reason_str=$(IFS='; '; printf '%s' "${reasons[*]}")

  if [ "$DRY_RUN" = "1" ]; then
    printf 'would flip %s -> %s (%s)\n' "$slug" "$new_status" "$reason_str"
    flipped=$((flipped + 1))
    continue
  fi

  tpm status "$slug" "$new_status" >/dev/null
  tpm log    "$slug" "poller — $reason_str" >/dev/null
  printf 'flipped %s -> %s (%s)\n' "$slug" "$new_status" "$reason_str"
  flipped=$((flipped + 1))
done <<< "$slugs"

printf 'check-pr-signal: checked=%d flipped=%d skipped=%d%s\n' \
  "$checked" "$flipped" "$skipped" "$([ "$DRY_RUN" = "1" ] && printf ' (dry-run)' || true)"
