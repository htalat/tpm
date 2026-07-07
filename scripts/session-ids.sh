#!/usr/bin/env bash
# session-ids.sh — report the agent session_id(s) recorded in each task's run logs.
#
# session_id rides through every orchestrator run as a top-level field on the
# captured NDJSON (claude's system/init + result events, copilot's stream). It
# is NOT stored in task frontmatter by design (commit b9bcdce) — it lives only
# in <task>/runs/*.log. This script walks the whole tpm tree (including archived
# tasks, which `tpm session` can't resolve) and prints every session_id per task.
#
# Per the run-log parser: within a single log the LAST session_id wins (a run
# can span multiple sessions — commit 315959f). A task can have multiple run
# logs, so it can carry multiple distinct session_ids; all are listed oldest→
# newest and the most recent is marked '*latest'.
#
# Usage:
#   scripts/session-ids.sh              # all projects
#   scripts/session-ids.sh <project>    # one project (e.g. agrotech)
#   scripts/session-ids.sh --latest     # only each task's most recent session_id
#   scripts/session-ids.sh --write      # ALSO stamp session_id:<latest> into task.md frontmatter
#
# Default is read-only. --write is the only mode that mutates task files; it
# adds/updates a `session_id:` frontmatter field set to the task's most recent
# session id (reverses the b9bcdce "id lives only in the run log" decision).

set -euo pipefail

ROOT="$(tpm root)"
[ -d "$ROOT" ] || { echo "tpm root '$ROOT' not found" >&2; exit 1; }

LATEST_ONLY=0
WRITE=0
PROJECT_FILTER=""
for arg in "$@"; do
  case "$arg" in
    --latest) LATEST_ONLY=1 ;;
    --write) WRITE=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) PROJECT_FILTER="$arg" ;;
  esac
done

# Update-or-insert `session_id: <sid>` in a task file's YAML frontmatter (the
# first ---...--- block). Preserves an existing key in place; otherwise inserts
# it just before the closing ---. Writes atomically via a temp file.
write_session_id() {
  local file="$1" sid="$2" tmp
  [ -f "$file" ] || { echo "  ! missing task file: $file" >&2; return 1; }
  tmp="$(mktemp)"
  awk -v sid="$sid" '
    NR==1 && $0=="---" { infm=1; print; next }
    infm && $0=="---" { if(!seen) print "session_id: " sid; infm=0; print; next }
    infm && /^session_id:[[:space:]]*/ { print "session_id: " sid; seen=1; next }
    { print }
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}

# Last session_id in a single NDJSON run log (or nothing). Mirrors parseRunLog:
# scans every line, last top-level session_id wins. fromjson? skips malformed
# lines the way the parser's try/catch does.
last_session_id() {
  jq -rR 'fromjson? | .session_id // empty' "$1" 2>/dev/null | tail -1
}

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Emit one row per run log: "display \t stamp \t archived \t sid"
# Path: <root>/<project>/tasks/[archive/]<slug>/runs/[<child>--]<utc>.log
while IFS= read -r log; do
  rel="${log#"$ROOT"/}"
  project="${rel%%/*}"
  [ -n "$PROJECT_FILTER" ] && [ "$project" != "$PROJECT_FILTER" ] && continue

  sid="$(last_session_id "$log")"
  [ -z "$sid" ] && continue

  fname="$(basename "$log")"
  task_dir="$(dirname "$(dirname "$log")")"   # top-level: the task dir; child: the parent dir
  dir_slug="$(basename "$task_dir")"
  archived="no"; case "$rel" in */tasks/archive/*) archived="yes" ;; esac

  if [[ "$fname" == *--* ]]; then           # child: <child-slug>--<utc>.log
    task_slug="${fname%%--*}"
    display="$project/$dir_slug/$task_slug"
    stamp="${fname##*--}"
    taskfile="$task_dir/$task_slug.md"       # children are flat .md inside parent folder
  else                                      # top-level: <utc>.log
    display="$project/$dir_slug"
    stamp="$fname"
    if [ -f "$task_dir/task.md" ]; then taskfile="$task_dir/task.md"; else taskfile="$task_dir.md"; fi
  fi
  stamp="${stamp%.log}"

  printf '%s\t%s\t%s\t%s\t%s\n' "$display" "$stamp" "$archived" "$sid" "$taskfile"
done < <(find "$ROOT" -path '*/runs/*.log' -type f 2>/dev/null) >> "$TMP"

if [ ! -s "$TMP" ]; then
  echo "(no session_ids found in run logs)" >&2
  exit 0
fi

# Group by task. For each task, rows are sorted by stamp (oldest→newest); dedupe
# session_ids preserving that order, mark the last as *latest.
tasks="$(cut -f1 "$TMP" | sort -u)"
while IFS= read -r task; do
  arch="$(awk -F'\t' -v t="$task" '$1==t{print $3; exit}' "$TMP")"
  suffix=""; [ "$arch" = "yes" ] && suffix="  [archived]"
  echo "$task$suffix"

  ids=()
  while IFS= read -r _id; do
    ids+=("$_id")
  done < <(
    awk -F'\t' -v t="$task" '$1==t{print $2"\t"$4}' "$TMP" \
      | sort | cut -f2 | awk '!seen[$0]++'
  )
  last_idx=$(( ${#ids[@]} - 1 ))
  for i in "${!ids[@]}"; do
    if [ "$i" -eq "$last_idx" ]; then
      echo "  ${ids[$i]}  *latest"
    elif [ "$LATEST_ONLY" -eq 0 ]; then
      echo "  ${ids[$i]}"
    fi
  done

  if [ "$WRITE" -eq 1 ]; then
    taskfile="$(awk -F'\t' -v t="$task" '$1==t{print $5; exit}' "$TMP")"
    if write_session_id "$taskfile" "${ids[$last_idx]}"; then
      echo "  -> wrote session_id to ${taskfile#"$ROOT"/}"
    fi
  fi
done <<< "$tasks"
