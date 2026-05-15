# Structured log helper for tpm recurring scripts. Source from any script:
#
#   SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/_log.sh"
#   log_info  "started"
#   log_warn  "skip foo (gh exit=4)"
#   log_error "classifier exited 1 for tpm/041"
#
# Format (one line per call):
#
#   <ISO timestamp w/ offset>  <LEVEL>  <script>          <message>
#   2026-05-15T09:14:23-07:00  INFO   check-pr-signal  start
#   2026-05-15T09:14:24-07:00  WARN   check-pr-signal  skip tpm/036 (gh exit=4)
#   2026-05-15T09:14:25-07:00  ERROR  check-pr-signal  classifier exited 1
#
# - Timestamp is ISO 8601 second precision in the configured TZ (read from
#   ~/.tpm/config.json, falls back to UTC) with explicit `±HH:MM` offset.
#   Task 061 swapped this from UTC ("16:04Z") to local-with-offset because
#   live-tailing a single-host log shouldn't require mental arithmetic. The
#   offset keeps lines unambiguous and lexicographically sortable.
# - Level is 5 chars wide, padded for column alignment.
# - Script is whatever the caller set in $_LOG_SCRIPT, or basename "$0" .sh by
#   default. Padded to 16 chars (fits "check-pr-signal" with room to grow).
# - Message is free-form, single-line. log_error writes to stderr; log_info /
#   log_warn write to stdout. Cron redirects both to the same log file in
#   practice; the split is so an interactive run can `2>/dev/null` for warn-
#   free output if needed.
#
# This file is sourced, not executed. No `set -euo pipefail` — it would leak
# into the caller's shell.

_LOG_SCRIPT="${_LOG_SCRIPT:-$(basename "$0" .sh)}"

# Read configured timezone once at source time (no jq dependency — parse with
# sed). Empty / missing config falls back to UTC, matching configuredTimezone()
# in src/time.ts callers that have no config.
_LOG_TZ="$(sed -nE 's/.*"timezone"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "${TPM_CONFIG:-$HOME/.tpm/config.json}" 2>/dev/null | head -n 1)"
[ -n "$_LOG_TZ" ] || _LOG_TZ=UTC

# BSD `date` (macOS) emits `-0700`; GNU `date` (Linux) does too with `%z`.
# Post-process to canonical ISO `-07:00`. Portable across BSD/GNU sed.
_log_ts() { TZ="$_LOG_TZ" date +%Y-%m-%dT%H:%M:%S%z | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/'; }

log_info()  { printf '%s  INFO   %-16s %s\n' "$(_log_ts)" "$_LOG_SCRIPT" "$*"; }
log_warn()  { printf '%s  WARN   %-16s %s\n' "$(_log_ts)" "$_LOG_SCRIPT" "$*"; }
log_error() { printf '%s  ERROR  %-16s %s\n' "$(_log_ts)" "$_LOG_SCRIPT" "$*" 1>&2; }
