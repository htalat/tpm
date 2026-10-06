import { describe, expect, it } from 'vitest';
import {
  assertStepTransition,
  assertTaskTransition,
  canTransitionAttempt,
  canTransitionStep,
  canTransitionTask,
  InvalidTransitionError,
  STEP_STATUSES,
  TASK_STATUSES,
} from '@durable/core';

describe('state machines', () => {
  it('never allows a completed step to return to READY (Invariant 1)', () => {
    for (const to of STEP_STATUSES) expect(canTransitionStep('COMPLETED', to)).toBe(false);
  });

  it('terminal task statuses have no outgoing transitions', () => {
    for (const from of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      for (const to of TASK_STATUSES) expect(canTransitionTask(from, to)).toBe(false);
    }
  });

  it('fails loudly on invalid transitions', () => {
    expect(() => assertStepTransition('s1', 'PENDING', 'RUNNING')).toThrow(InvalidTransitionError);
    expect(() => assertTaskTransition('t1', 'PAUSED', 'COMPLETED')).toThrow(InvalidTransitionError);
  });

  it('allows the normal attempt lifecycle only', () => {
    expect(canTransitionAttempt('RUNNING', 'COMPLETED')).toBe(true);
    expect(canTransitionAttempt('RUNNING', 'EXPIRED')).toBe(true);
    expect(canTransitionAttempt('EXPIRED', 'COMPLETED')).toBe(false);
    expect(canTransitionAttempt('COMPLETED', 'FAILED')).toBe(false);
  });

  it('allows the retry loop RUNNING -> RETRYING -> READY -> RUNNING', () => {
    expect(canTransitionStep('RUNNING', 'RETRYING')).toBe(true);
    expect(canTransitionStep('RETRYING', 'READY')).toBe(true);
    expect(canTransitionStep('READY', 'RUNNING')).toBe(true);
    expect(canTransitionStep('RETRYING', 'RUNNING')).toBe(false);
  });
});
