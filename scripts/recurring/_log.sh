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
#   <UTC ISO timestamp>  <LEVEL>  <script>          <message>
#   2026-05-10T17:24:33Z  INFO   check-pr-signal  start
#   2026-05-10T17:24:34Z  WARN   check-pr-signal  skip tpm/036 (gh exit=4)
#   2026-05-10T17:24:35Z  ERROR  check-pr-signal  classifier exited 1
#
# - Timestamp is UTC, ISO 8601, second precision. Logs go to log files; UTC
#   beats the configured TZ for grep + sort. (Frontmatter timestamps still use
#   the configured TZ — they serve a different purpose.)
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

_log_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log_info()  { printf '%s  INFO   %-16s %s\n' "$(_log_ts)" "$_LOG_SCRIPT" "$*"; }
log_warn()  { printf '%s  WARN   %-16s %s\n' "$(_log_ts)" "$_LOG_SCRIPT" "$*"; }
log_error() { printf '%s  ERROR  %-16s %s\n' "$(_log_ts)" "$_LOG_SCRIPT" "$*" 1>&2; }
