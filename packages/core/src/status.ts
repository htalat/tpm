import { InvalidTransitionError } from './errors';

export const TASK_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'BLOCKED',
  'RETRYING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'RETRYING',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ATTEMPT_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const STEP_TYPES = ['task', 'map', 'wait_event', 'sleep', 'child', 'compensation'] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Task statuses in which new work may be claimed. */
export const CLAIMABLE_TASK_STATUSES: readonly TaskStatus[] = [
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'RETRYING',
];

const TERMINAL_TASK: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const TERMINAL_STEP: ReadonlySet<StepStatus> = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED']);

export const isTerminalTask = (s: TaskStatus): boolean => TERMINAL_TASK.has(s);
export const isTerminalStep = (s: StepStatus): boolean => TERMINAL_STEP.has(s);

const ALL_ACTIVE_TASK: TaskStatus[] = ['READY', 'RUNNING', 'WAITING', 'RETRYING'];
const without = <T>(xs: T[], x: T): T[] => xs.filter((y) => y !== x);

/**
 * Allowed task transitions. READY/RUNNING/WAITING/RETRYING are "summary"
 * statuses derived by the orchestrator from the task's steps, so they may move
 * freely between each other. Terminal statuses have no outgoing edges.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PENDING: [...ALL_ACTIVE_TASK, 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  READY: [...without(ALL_ACTIVE_TASK, 'READY'), 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  RUNNING: [...without(ALL_ACTIVE_TASK, 'RUNNING'), 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING: [...without(ALL_ACTIVE_TASK, 'WAITING'), 'BLOCKED', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  RETRYING: [
    ...without(ALL_ACTIVE_TASK, 'RETRYING'),
    'BLOCKED',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ],
  BLOCKED: [...ALL_ACTIVE_TASK, 'PAUSED', 'FAILED', 'CANCELLED'],
  PAUSED: ['READY', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Allowed step transitions. Note there is no edge out of COMPLETED
 * (Invariant 1: completed steps are never silently returned to READY).
 */
export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  PENDING: ['READY', 'WAITING', 'FAILED', 'SKIPPED', 'CANCELLED'],
  READY: ['RUNNING', 'SKIPPED', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'RETRYING', 'BLOCKED', 'CANCELLED'],
  RETRYING: ['READY', 'SKIPPED', 'CANCELLED'],
  WAITING: ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'],
  BLOCKED: ['READY', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED: [],
  CANCELLED: [],
};

export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  RUNNING: ['COMPLETED', 'FAILED', 'EXPIRED'],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}
export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(id: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError('task', id, from, to);
}
export function assertStepTransition(id: string, from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) throw new InvalidTransitionError('step', id, from, to);
}
export function assertAttemptTransition(id: string, from: AttemptStatus, to: AttemptStatus): void {
  if (!canTransitionAttempt(from, to)) throw new InvalidTransitionError('attempt', id, from, to);
}
