import { z } from 'zod';
import { FailureCategorySchema } from './failure';

/** Wire-level schemas shared by the API, the worker SDK and the CLI. */

const JsonValue = z.unknown();
const Metadata = z.record(z.string(), z.unknown());

export const CreateTaskRequestSchema = z.object({
  type: z.string().min(1).max(128),
  input: JsonValue.default(null),
  metadata: Metadata.default({}),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequestSchema>;

export const SignalRequestSchema = z.object({
  type: z
    .string()
    .min(1)
    .max(128)
    .refine((t) => !t.startsWith('__'), 'event types starting with "__" are reserved'),
  correlationKey: z.string().max(256).nullish(),
  payload: JsonValue.default(null),
  /** Same key => same event. If omitted, the server generates one (no deduplication). */
  deduplicationKey: z.string().min(1).max(256).optional(),
});
export type SignalRequest = z.input<typeof SignalRequestSchema>;

export const RegisterWorkerRequestSchema = z.object({
  name: z.string().min(1).max(128),
  capabilities: z.array(z.string().min(1).max(128)).min(1).max(64),
});

export const ClaimRequestSchema = z.object({
  workerId: z.string().uuid(),
  capabilities: z.array(z.string().min(1).max(128)).min(1).max(64),
  maxItems: z.number().int().min(1).max(100).default(1),
  leaseMs: z
    .number()
    .int()
    .min(1000)
    .max(15 * 60_000)
    .optional(),
});

export const LeaseRequestSchema = z.object({ leaseToken: z.string().uuid() });

export const ArtifactRefSchema = z.object({
  type: z.string().min(1).max(128),
  uri: z.string().min(1).max(2048),
  metadata: Metadata.default({}),
});
export type ArtifactRef = z.input<typeof ArtifactRefSchema>;

export const CompleteRequestSchema = z.object({
  leaseToken: z.string().uuid(),
  output: JsonValue.default(null),
  artifacts: z.array(ArtifactRefSchema).max(100).default([]),
});

export const FailRequestSchema = z.object({
  leaseToken: z.string().uuid(),
  error: z.object({
    category: FailureCategorySchema,
    message: z.string().max(4000),
    type: z.string().max(256).optional(),
  }),
  retryAfterMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600_000)
    .optional(),
  /** false: do not count this attempt toward maxAttempts (bounded by the engine). */
  chargeAttempt: z.boolean().default(true),
});

export const ResolveStepRequestSchema = z.object({
  action: z.enum(['retry', 'complete', 'fail']),
  output: JsonValue.optional(),
  reason: z.string().max(1000).default('operator resolution'),
});

export interface WorkItem {
  taskId: string;
  stepId: string;
  stepKey: string;
  attemptId: string;
  attemptNumber: number;
  type: string;
  input: unknown;
  context: {
    taskType: string;
    previousAttempt: {
      attemptNumber: number;
      status: string;
      errorType: string | null;
      errorMessage: string | null;
    } | null;
    /** True when a previous attempt may have performed its side effect without recording it. */
    recoveringAmbiguous: boolean;
  };
  idempotencyKey: string;
  leaseToken: string;
  leaseExpiresAt: string;
  /** Lease duration granted. Workers schedule heartbeats from this relative value, not from absolute timestamps (clock skew). */
  leaseMs: number;
  timeoutMs: number;
  deadlineAt: string;
}

export interface HeartbeatResponse {
  leaseExpiresAt: string;
  cancelRequested: boolean;
}

export interface CompletionResponse {
  status: 'ACCEPTED' | 'ALREADY_ACCEPTED';
}
