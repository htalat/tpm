import { z } from 'zod';

export const FAILURE_CATEGORIES = [
  'TRANSIENT',
  'PERMANENT',
  'AMBIGUOUS',
  'DEPENDENCY',
  'POLICY',
  'TIMEOUT',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
export const FailureCategorySchema = z.enum(FAILURE_CATEGORIES);

/**
 * Error thrown by worker code to classify a failure. Errors that are not a
 * WorkerError are classified by the worker runtime (TRANSIENT by default).
 */
export class WorkerError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
    readonly retryAfterMs?: number,
    /** false = this failure is not the step's fault (e.g. provider usage limit) and does not use up an attempt. */
    readonly chargeAttempt = true,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

export interface StepError {
  category: FailureCategory;
  message: string;
  attempt?: number;
}
