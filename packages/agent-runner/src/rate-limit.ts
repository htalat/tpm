/**
 * Provider usage/credit limit detection (ported from tpm). A run that died on
 * an account-wide limit is not the step's fault: it is reported as a
 * TRANSIENT failure with chargeAttempt=false and a retry time.
 */
const SIGNATURES: RegExp[] = [
  /out of extra usage/i,
  /usage limit reached/i,
  /claude usage limit/i,
  /\d+-hour limit reached/i,
  /weekly limit reached/i,
  /\brate_limit_error\b/i,
  /credit balance is too low/i,
  /\bout_of_credits\b/i,
  /insufficient.{0,12}credit/i,
];

export const DEFAULT_BACKOFF_MS = 30 * 60_000;
export const MAX_BACKOFF_MS = 6 * 3600_000;

export function detectRateLimit(
  text: string,
  nowMs: number,
): { limited: false } | { limited: true; retryAfterMs: number } {
  const window = (resetMs: number | undefined) =>
    resetMs && resetMs > nowMs ? Math.min(resetMs - nowMs, MAX_BACKOFF_MS) : DEFAULT_BACKOFF_MS;
  // Structured output first (claude --output-format stream-json). Status
  // events report limits on every run ("status":"allowed", even fields like
  // "overageDisabledReason":"out_of_credits"), so they must never be matched
  // as text. A successful final result means the run was not limited.
  const free: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) {
      free.push(line);
      continue;
    }
    let ev: { type?: string; is_error?: boolean; rate_limit_info?: { status?: string; resetsAt?: number } };
    try {
      ev = JSON.parse(t);
    } catch {
      free.push(line); // a truncated line at the start of the tail
      continue;
    }
    if (ev.type === 'result' && ev.is_error === false) return { limited: false };
    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {};
      if (info.status && info.status !== 'allowed') {
        return { limited: true, retryAfterMs: window(info.resetsAt ? info.resetsAt * 1000 : undefined) };
      }
      continue;
    }
    free.push(line);
  }
  const rest = free.join('\n');
  if (!SIGNATURES.some((re) => re.test(rest))) return { limited: false };
  return { limited: true, retryAfterMs: window(parseResetAtMs(rest)) };
}

/** Only machine-unambiguous reset times (ISO-8601 or unix epoch after "reset"). */
export function parseResetAtMs(text: string): number | undefined {
  const iso = text.match(
    /reset[^0-9]{0,40}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso) {
    const ms = Date.parse(iso[1]!);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const epoch = text.match(/reset[^0-9]{0,40}(\d{10,13})/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return epoch[1]!.length === 13 ? n : n * 1000;
  }
  return undefined;
}
