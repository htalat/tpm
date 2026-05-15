#!/usr/bin/env bash
# Reclaim stranded `in-progress` tasks.
#
# A task is "stranded" when:
#   1. status is `in-progress`,
#   2. no per-task lock file exists (`~/.tpm/locks/<slug>.lock` is gone),
#   3. the task file hasn't been touched in `$THRESHOLD_MIN` minutes
#      (proxy for "no agent and no poller has done anything here recently").
#
# Bug surfaced live 2026-05-15 (task 058): the previous orchestrator run
# exited cleanly, released the lock, but left the status at `in-progress`. The
# task became invisible to both queues — `tpm next` excluded it as "presumed
# claimed," and the inbox didn't list it because in-progress isn't a human
# queue. Status-only signal lied; the lock told the truth.
#
# The complementary fix lives in `src/queue.ts`: `tpm next` admits a stranded
# task in the next tick (between `needs-feedback` and `ready`) as long as the
# queue has bandwidth. This sweeper is the backstop for the case where the
# queue is busy enough that the stranded task never gets pulled — after
# `$THRESHOLD_MIN` minutes the sweeper auto-reverts it back to `ready`. The
# 30-minute default matches the orchestrator's default time bound, so a fresh
# `in-progress` flip can't trip it before a normal run could have completed.
#
# Distinct from `tpm lock release-stale` (task 018): that path clears stale
# *locks*, where the lock file exists but the holder is dead. This script
# clears stale *statuses*, where the lock is gone but the status is still
# in-progress. Distinct preconditions; no overlap.
#
# Usage: reclaim-stranded.sh [--dry-run] [--threshold-min=N]

set -euo pipefail

DRY_RUN=0
THRESHOLD_MIN=30
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --threshold-min=*) THRESHOLD_MIN="${arg#*=}" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_log.sh
. "$SCRIPT_DIR/_log.sh"

command -v tpm >/dev/null || { log_error "tpm CLI not found"; exit 1; }

# Enumerate qualified slugs of every in-progress task. Same parser shape as
# check-pr-signal.sh — `tpm ls --status in-progress --flat`:
#   <project name>  (<project-slug>)  [<project-status>]
#     · <status>  <type>  <task-slug>  [prs...]
in_progress_slugs=$(tpm ls --status in-progress --flat | awk '
  /^[^ ]/ {
    if (match($0, /\([^)]+\)/)) proj = substr($0, RSTART + 1, RLENGTH - 2)
    next
  }
  /^  · / && proj != "" { print proj "/" $4 }
')

if [ -z "${in_progress_slugs:-}" ]; then
  log_info "no in-progress tasks"
  exit 0
fi

# Snapshot which qualified slugs hold a per-task lock right now. One read of
# `tpm lock list` instead of one `tpm lock status` call per candidate. Filter
# out the `repo--<slug>` rows (those are repo locks, not per-task) and the
# header. NR>1 skips the header row.
locked_lines=$(tpm lock list 2>/dev/null | awk 'NR>1 && $1 != "" && $1 !~ /^repo--/ { print $1 }' || true)

now_epoch=$(date +%s)

checked=0
reclaimed=0
locked_count=0
recent_count=0
missing_file=0

while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  checked=$((checked + 1))

  # A held lock means an agent IS working on this — skip. Even a stale lock
  # (held by a dead pid) skips here; `tpm lock release-stale` from task 018 is
  # responsible for that codepath.
  if printf '%s\n' "$locked_lines" | grep -qFx -- "$slug"; then
    locked_count=$((locked_count + 1))
    continue
  fi

  # Need the task's file path to read mtime. `tpm context` puts it on the
  # `- File: ` line of the briefing header.
  file_path=$(tpm context "$slug" 2>/dev/null | awk '/^- File: / { sub(/^- File: /, ""); print; exit }')
  if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
    log_warn "skip $slug (file path not resolvable)"
    missing_file=$((missing_file + 1))
    continue
  fi

  # File mtime as "last activity" proxy. Any `tpm log/status/etc.` call
  # rewrites the file, so a recent mtime means something — agent or poller —
  # touched the task within the window. Portable across BSD (macOS) and GNU
  # `stat`; the BSD form is tried first because that's the dev machine.
  if mtime=$(stat -f %m "$file_path" 2>/dev/null); then :
  else mtime=$(stat -c %Y "$file_path"); fi
  age_min=$(( (now_epoch - mtime) / 60 ))

  if [ "$age_min" -lt "$THRESHOLD_MIN" ]; then
    recent_count=$((recent_count + 1))
    continue
  fi

  reason="auto-reclaim: stranded in-progress (no lock, idle ${age_min}m)"
  if [ "$DRY_RUN" = "1" ]; then
    log_info "would reclaim $slug (idle ${age_min}m)"
    reclaimed=$((reclaimed + 1))
    continue
  fi

  # `tpm revert` is itself idempotent — if the task slipped out of in-progress
  # between enumeration and now (a race with `tpm pr`, the PR-signal poller,
  # or a manual edit) it's a no-op with a message, not an error.
  err_tmp=$(mktemp)
  if tpm revert "$slug" "$reason" >/dev/null 2>"$err_tmp"; then
    rm -f "$err_tmp"
    log_info "reclaimed $slug -> ready (idle ${age_min}m)"
    reclaimed=$((reclaimed + 1))
  else
    rc=$?
    log_warn "tpm revert failed for $slug (exit=$rc) — $(head -2 "$err_tmp" | tr '\n' ' ')"
    rm -f "$err_tmp"
  fi
done <<< "$in_progress_slugs"

dry_suffix=""
[ "$DRY_RUN" = "1" ] && dry_suffix=" (dry-run)"
log_info "summary checked=$checked locked=$locked_count recent=$recent_count reclaimed=$reclaimed missing-file=$missing_file threshold=${THRESHOLD_MIN}m$dry_suffix"
