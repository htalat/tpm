/**
 * Domain errors carry a stable machine-readable code. Adapters (HTTP, CLI)
 * map codes to transport-level responses; the domain never knows about HTTP.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'CONCURRENCY_CONFLICT'
  | 'LEASE_LOST'
  | 'TASK_TERMINAL'
  | 'IDEMPOTENCY_MISMATCH'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHORIZED'
  | 'CONFLICT';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(entity: string, id: string, from: string, to: string) {
    super('INVALID_TRANSITION', `invalid ${entity} transition ${from} -> ${to} for ${id}`, {
      entity,
      id,
      from,
      to,
    });
  }
}

export class ConcurrencyConflictError extends DomainError {
  constructor(entity: string, id: string, expected: unknown) {
    super('CONCURRENCY_CONFLICT', `${entity} ${id} was modified concurrently`, { entity, id, expected });
  }
}

export class LeaseLostError extends DomainError {
  constructor(attemptId: string, reason: string) {
    super('LEASE_LOST', `lease for attempt ${attemptId} is not authoritative: ${reason}`, {
      attemptId,
      reason,
    });
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} ${id} not found`, { entity, id });
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
