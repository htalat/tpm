#!/usr/bin/env bash
# Poll in-flight PRs and flip task status when a signal lands.
#
# For each `in-progress` task with a non-empty `prs:` list, queries the host
# CLI (`gh` for GitHub) for each PR, then hands the gathered JSON to
# `src/pr_signal.ts` for classification:
#
#   - any linked PR merged                     -> needs-close    (agent close-out)
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
# Usage: check-pr-signal.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFIER="$SCRIPT_DIR/../../src/pr_signal.ts"

command -v tpm  >/dev/null || { printf 'check-pr-signal: tpm CLI not found\n' >&2; exit 1; }
command -v gh   >/dev/null || { printf 'check-pr-signal: gh CLI not found\n' >&2; exit 1; }
command -v node >/dev/null || { printf 'check-pr-signal: node not found\n' >&2; exit 1; }
[ -f "$CLASSIFIER" ] || { printf 'check-pr-signal: classifier missing at %s\n' "$CLASSIFIER" >&2; exit 1; }

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
skipped=0
checked=0

if [ -z "${slugs:-}" ]; then
  printf 'check-pr-signal: no in-progress tasks\n'
  exit 0
fi

while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  checked=$((checked + 1))

  err_tmp=$(mktemp)
  briefing=$(tpm context "$slug" 2>"$err_tmp") || {
    rc=$?
    printf 'check-pr-signal: skip %s (tpm context exit=%d) — %s\n' \
      "$slug" "$rc" "$(head -2 "$err_tmp" | tr '\n' ' ')" >&2
    rm -f "$err_tmp"
    skipped=$((skipped + 1))
    continue
  }
  rm -f "$err_tmp"

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
      printf 'check-pr-signal: skip %s (gh exit=%d for %s) — %s\n' \
        "$slug" "$rc" "$url" "$(head -2 "$err_tmp" | tr '\n' ' ')" >&2
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
    skipped=$((skipped + 1))
    continue
  fi

  decision=$(printf '%s' "$payload" | node "$CLASSIFIER") || {
    rc=$?
    printf 'check-pr-signal: skip %s (classifier exit=%d)\n' "$slug" "$rc" >&2
    skipped=$((skipped + 1))
    continue
  }

  if [ -z "$decision" ]; then
    continue
  fi

  new_status=$(printf '%s\n' "$decision" | sed -n '1p')
  reason_str=$(printf '%s\n' "$decision" | sed -n '2p')

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
