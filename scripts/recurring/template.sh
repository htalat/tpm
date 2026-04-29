#!/usr/bin/env bash
# Template for a recurring tpm intake script. Copy this file, rename it,
# fill in the TODO blocks with your harvest + task-creation logic, and wire
# it into cron.
#
# Shape:
#   - Take a tpm project slug as $1; files tasks under that project.
#   - Optional --dry-run as $2 to preview without writing.
#   - Idempotent on re-run: skip tasks whose slug already exists (live or archived).
#   - Use the tpm CLI for all state changes (no frontmatter editing by hand).
#   - Print one summary line on exit.
#
# Usage: <this-script> <project-slug> [--dry-run]

set -euo pipefail

PROJECT="${1:-}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "$PROJECT" ]; then
  printf 'usage: %s <project-slug> [--dry-run]\n' "$0" >&2
  exit 1
fi

command -v tpm >/dev/null || { printf 'recurring: tpm CLI not found\n' >&2; exit 1; }
# TODO: add `command -v <other-tool>` checks if your script needs gh, jq, curl, etc.

tpm path "$PROJECT" >/dev/null 2>&1 || {
  printf 'recurring: unknown tpm project: %s\n' "$PROJECT" >&2
  exit 1
}

created=0
skipped=0

# TODO: replace this loop body with your harvest. Each iteration should yield
# enough info to derive a stable, unique-within-project task slug and a title.
# The default below produces zero iterations so the template runs cleanly out
# of the box.
while IFS=$'\t' read -r unique_id title; do
  [ -n "$unique_id" ] || continue

  # TODO: derive a stable slug from $unique_id (e.g. "review-pr-$unique_id",
  # "stale-dep-$unique_id"). The slug is the idempotency key: same input on
  # the next run must produce the same slug so the existence check skips it.
  slug="example-$unique_id"

  # Skip if a task with this slug already exists (live or archived).
  if tpm context "$PROJECT/$slug" >/dev/null 2>&1; then
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    printf 'would create: %s/%s — %s\n' "$PROJECT" "$slug" "$title"
    created=$((created + 1))
    continue
  fi

  # Create the task. tpm prints "Created <path>" on success.
  out=$(tpm new task "$PROJECT" "$slug" --title "$title")
  path="${out#Created }"

  # TODO: optionally adjust frontmatter and populate ## Context. Body authoring
  # is a direct file edit; everything else should go through CLI verbs.
  #
  # Examples (uncomment + adapt):
  #
  #   # Change type to `investigation` so the close-out writeup stays at the
  #   # canonical path (per the type-aware archive policy).
  #   tmp=$(mktemp)
  #   sed 's/^type: pr$/type: investigation/' "$path" > "$tmp" && mv "$tmp" "$path"
  #
  #   # Populate ## Context (replaces the template placeholder line).
  #   ctx_block="Source: https://example.com/$unique_id
  # Detected: $(tpm now)"
  #   tmp=$(mktemp)
  #   awk -v ctx="$ctx_block" '
  #     /^<!-- Why this task\. What we know\. Constraints\. -->$/ { print ctx; next }
  #     { print }
  #   ' "$path" > "$tmp" && mv "$tmp" "$path"

  # Promote to ready so `tpm next` picks it up. Don't set `allow_orchestrator: true`
  # by default — that opts the task into autonomous (cron-driven) drains, which
  # is a privilege the human should grant per task.
  tpm ready "$PROJECT/$slug" >/dev/null

  created=$((created + 1))
done < <(
  # TODO: replace with your real source. Output must be tab-separated:
  #   <unique-id>\t<title>
  # Examples:
  #   gh pr list --state open --json number,title --jq '.[] | "\(.number)\t\(.title)"'
  #   curl -s https://your.api/items | jq -r '.[] | "\(.id)\t\(.summary)"'
  printf ''   # no-op default — produces zero iterations
)

# Replace "recurring" with your script's name in the summary.
printf 'recurring: created %d task(s), skipped %d existing\n' "$created" "$skipped"
