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
  if (!SIGNATURES.some((re) => re.test(text))) return { limited: false };
  const reset = parseResetAtMs(text);
  const retryAfterMs = reset && reset > nowMs ? Math.min(reset - nowMs, MAX_BACKOFF_MS) : DEFAULT_BACKOFF_MS;
  return { limited: true, retryAfterMs };
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
