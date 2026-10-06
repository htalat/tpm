import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/**
 * Structured JSON logger. Payload-bearing fields (input, output, payload,
 * artifacts content) and secrets are redacted by default: logs are for
 * operators, durable history is the record of truth.
 */
export const REDACT_PATHS = [
  'input',
  'output',
  'payload',
  'leaseToken',
  'lease_token',
  'authorization',
  'req.headers.authorization',
  'headers.authorization',
  '*.input',
  '*.output',
  '*.payload',
  '*.leaseToken',
  '*.password',
  '*.apiKey',
  '*.token',
];

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
  });
}

export const silentLogger: Logger = pino({ level: 'silent' });

/** A non-reversible short identifier for a lease token, safe to log. */
export function leaseId(token: string): string {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return `lease_${(h >>> 0).toString(16).padStart(8, '0')}`;
}
