import type { StepError } from './failure';
import { resolveRetryPolicy, type RetryPolicy } from './retry';
import { isTerminalTask, type StepStatus, type StepType, type TaskStatus } from './status';
import type { CompiledWorkflow, Effect, NodeSpec, WorkflowContext } from './workflow';

/**
 * The orchestration decision function.
 *
 * `decide` is pure: given a snapshot of durable state it returns the next batch
 * of commands. The engine applies the commands in one transaction, reloads the
 * snapshot and calls `decide` again until it returns nothing. Because every
 * input is durable and the function is deterministic, any orchestrator process
 * can run it at any time, and re-running it after a crash is safe
 * (Invariant 4: task state can be reconstructed from durable data).
 */

export interface TaskState {
  id: string;
  type: string;
  status: TaskStatus;
  input: unknown;
  failure: (StepError & { stepKey: string }) | null;
  compensationStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | null;
}

export interface StepState {
  id: string;
  key: string;
  type: StepType;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: StepError | null;
  dependencies: readonly string[];
  parentStepId: string | null;
  itemIndex: number | null;
  wait: { eventType: string; correlationKey: string | null } | null;
  config: { workflow?: string } | null;
  completedAt: Date | null;
}

export interface EventState {
  id: string;
  eventType: string;
  correlationKey: string | null;
  payload: unknown;
}

export interface ChildState {
  id: string;
  parentStepId: string | null;
  status: TaskStatus;
  output: unknown;
}

export interface Snapshot {
  task: TaskState;
  steps: readonly StepState[];
  /** Unconsumed events for this task, oldest first. */
  events: readonly EventState[];
  children: readonly ChildState[];
  now: Date;
}

export interface NewStep {
  key: string;
  type: StepType;
  executorType: string | null;
  dependencies: string[];
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  effect: Effect;
  input: unknown;
  parentStepId: string | null;
  itemIndex: number | null;
  config: { workflow?: string } | null;
}

export type Command =
  | { kind: 'promote'; stepId: string; input: unknown }
  | { kind: 'startWait'; stepId: string; input: unknown; eventType: string; correlationKey: string | null }
  | { kind: 'startSleep'; stepId: string; fireAt: Date; durationMs: number }
  | { kind: 'spawnChild'; stepId: string; workflow: string; input: unknown }
  | { kind: 'expandMap'; stepId: string; items: NewStep[] }
  | { kind: 'completeStep'; stepId: string; output: unknown; consumeEventId?: string }
  | { kind: 'failStep'; stepId: string; error: StepError }
  | { kind: 'skipStep'; stepId: string; reason: string }
  | { kind: 'recordFailure'; failure: StepError & { stepKey: string } }
  | { kind: 'startCompensation'; steps: NewStep[] }
  | { kind: 'setTaskStatus'; to: TaskStatus }
  | {
      kind: 'finishTask';
      to: 'COMPLETED' | 'FAILED';
      output?: unknown;
      error?: StepError & { stepKey?: string };
      compensationStatus?: 'COMPLETED' | 'FAILED';
    };

export const TIMER_EVENT_TYPE = '__timer.fired';
export const COMPENSATION_PREFIX = 'compensate:';
export const DEFAULT_MAX_MAP_ITEMS = 1000;

/** Steps that exist when a task is created: one per workflow node, all PENDING. */
export function initialSteps(def: CompiledWorkflow): NewStep[] {
  return def.order.map((key) => {
    const n = def.nodes.get(key)!;
    const s = n.spec;
    return {
      key,
      type: s.kind,
      executorType: s.kind === 'task' ? s.executor : null,
      dependencies: n.dependencies,
      retryPolicy: n.retryPolicy,
      timeoutMs: n.timeoutMs,
      effect: n.effect,
      input: null,
      parentStepId: null,
      itemIndex: null,
      config: s.kind === 'child' ? { workflow: s.workflow } : null,
    };
  });
}

export function buildContext(task: TaskState, steps: readonly StepState[]): WorkflowContext {
  const outputs: Record<string, unknown> = {};
  for (const s of steps) {
    if (s.status === 'COMPLETED' && s.parentStepId === null && s.type !== 'compensation')
      outputs[s.key] = s.output;
  }
  return { taskId: task.id, input: task.input, outputs };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function deriveStatus(steps: readonly StepState[]): TaskStatus | null {
  const has = (st: StepStatus) => steps.some((s) => s.status === st);
  if (has('BLOCKED')) return 'BLOCKED';
  if (has('RUNNING')) return 'RUNNING';
  if (has('READY')) return 'READY';
  if (has('RETRYING')) return 'RETRYING';
  if (has('WAITING')) return 'WAITING';
  return null;
}

function statusCommand(task: TaskState, steps: readonly StepState[]): Command[] {
  const derived = deriveStatus(steps);
  return derived && derived !== task.status ? [{ kind: 'setTaskStatus', to: derived }] : [];
}

export function decide(def: CompiledWorkflow, snap: Snapshot): Command[] {
  const { task, steps, now } = snap;
  if (isTerminalTask(task.status) || task.status === 'PAUSED' || task.status === 'BLOCKED') return [];

  const ctx = buildContext(task, steps);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const itemsOf = (mapStepId: string) =>
    steps.filter((s) => s.parentStepId === mapStepId).sort((a, b) => a.itemIndex! - b.itemIndex!);

  // 1. Resolve waits whose condition is durably satisfied.
  const cmds: Command[] = [];
  const consumed = new Set<string>();
  for (const s of steps) {
    if (s.status !== 'WAITING') continue;
    if ((s.type === 'wait_event' || s.type === 'sleep') && s.wait) {
      const w = s.wait;
      const ev = snap.events.find(
        (e) =>
          !consumed.has(e.id) &&
          e.eventType === w.eventType &&
          (w.correlationKey === null || e.correlationKey === w.correlationKey),
      );
      if (ev) {
        consumed.add(ev.id);
        cmds.push({ kind: 'completeStep', stepId: s.id, output: ev.payload ?? null, consumeEventId: ev.id });
      }
    } else if (s.type === 'child') {
      const child = snap.children.find((c) => c.parentStepId === s.id);
      if (child?.status === 'COMPLETED')
        cmds.push({ kind: 'completeStep', stepId: s.id, output: child.output });
      else if (child && (child.status === 'FAILED' || child.status === 'CANCELLED')) {
        cmds.push({
          kind: 'failStep',
          stepId: s.id,
          error: { category: 'DEPENDENCY', message: `child task ${child.id} ended ${child.status}` },
        });
      }
    } else if (s.type === 'map') {
      const items = itemsOf(s.id);
      const failed = items.find((i) => i.status === 'FAILED' || i.status === 'CANCELLED');
      if (failed) {
        cmds.push({
          kind: 'failStep',
          stepId: s.id,
          error: { category: 'DEPENDENCY', message: `map item ${failed.key} ${failed.status}` },
        });
      } else if (items.every((i) => i.status === 'COMPLETED')) {
        cmds.push({ kind: 'completeStep', stepId: s.id, output: items.map((i) => i.output) });
      }
    }
  }
  if (cmds.length) return cmds;

  // 2. Failure handling and compensation.
  const failed = steps.find(
    (s) => s.status === 'FAILED' && s.type !== 'compensation' && s.parentStepId === null,
  );
  if (failed && !task.failure) {
    return [
      {
        kind: 'recordFailure',
        failure: {
          stepKey: failed.key,
          category: failed.error?.category ?? 'PERMANENT',
          message: failed.error?.message ?? 'step failed',
        },
      },
    ];
  }
  if (task.failure) return decideFailure(def, snap, ctx, byKey);

  // 3. Promote steps whose dependencies are complete.
  for (const s of steps) {
    if (s.status !== 'PENDING' || s.parentStepId !== null || s.type === 'compensation') continue;
    if (!s.dependencies.every((d) => byKey.get(d)?.status === 'COMPLETED')) continue;
    const node = def.nodes.get(s.key);
    if (!node) {
      cmds.push({
        kind: 'failStep',
        stepId: s.id,
        error: { category: 'POLICY', message: 'step not in definition' },
      });
      continue;
    }
    try {
      cmds.push(promoteTopLevel(s, node.spec, node, ctx, now));
    } catch (e) {
      cmds.push({
        kind: 'failStep',
        stepId: s.id,
        error: { category: 'PERMANENT', message: `input: ${errMsg(e)}` },
      });
    }
  }

  // 3b. Promote map items up to the map's concurrency limit.
  for (const m of steps) {
    if (m.type !== 'map' || m.status !== 'WAITING') continue;
    const spec = def.nodes.get(m.key)?.spec;
    if (spec?.kind !== 'map') continue;
    const items = itemsOf(m.id);
    const inFlight = items.filter((i) =>
      ['READY', 'RUNNING', 'RETRYING', 'WAITING', 'BLOCKED'].includes(i.status),
    );
    let slots = spec.concurrency - inFlight.length;
    for (const i of items) {
      if (slots <= 0) break;
      if (i.status !== 'PENDING') continue;
      slots--;
      if (i.type === 'child')
        cmds.push({ kind: 'spawnChild', stepId: i.id, workflow: i.config!.workflow!, input: i.input });
      else cmds.push({ kind: 'promote', stepId: i.id, input: i.input });
    }
  }
  if (cmds.length) return cmds;

  // 4. Completion.
  const top = steps.filter((s) => s.parentStepId === null && s.type !== 'compensation');
  if (top.every((s) => s.status === 'COMPLETED')) {
    try {
      const output = def.spec.output ? def.spec.output(ctx) : ctx.outputs;
      return [{ kind: 'finishTask', to: 'COMPLETED', output }];
    } catch (e) {
      return [
        {
          kind: 'finishTask',
          to: 'FAILED',
          error: { category: 'PERMANENT', message: `output: ${errMsg(e)}` },
        },
      ];
    }
  }

  // 5. Summary status.
  return statusCommand(task, steps);
}

function promoteTopLevel(
  s: StepState,
  spec: NodeSpec,
  node: { retryPolicy: RetryPolicy; timeoutMs: number; effect: Effect },
  ctx: WorkflowContext,
  now: Date,
): Command {
  switch (spec.kind) {
    case 'task':
      return { kind: 'promote', stepId: s.id, input: spec.input ? spec.input(ctx) : (ctx.input ?? null) };
    case 'wait_event':
      return {
        kind: 'startWait',
        stepId: s.id,
        input: null,
        eventType: spec.eventType,
        correlationKey: spec.correlationKey?.(ctx) ?? null,
      };
    case 'sleep': {
      const durationMs = typeof spec.durationMs === 'function' ? spec.durationMs(ctx) : spec.durationMs;
      if (!Number.isFinite(durationMs) || durationMs < 0)
        throw new Error(`invalid sleep duration ${durationMs}`);
      return { kind: 'startSleep', stepId: s.id, durationMs, fireAt: new Date(now.getTime() + durationMs) };
    }
    case 'child':
      return {
        kind: 'spawnChild',
        stepId: s.id,
        workflow: spec.workflow,
        input: spec.input ? spec.input(ctx) : null,
      };
    case 'map': {
      const items = spec.items(ctx);
      if (!Array.isArray(items)) throw new Error('map items must be an array');
      const max = spec.maxItems ?? DEFAULT_MAX_MAP_ITEMS;
      if (items.length > max) throw new Error(`map has ${items.length} items; limit is ${max}`);
      return {
        kind: 'expandMap',
        stepId: s.id,
        items: items.map((item, i) => ({
          key: `${s.key}[${i}]`,
          type: spec.workflow ? 'child' : 'task',
          executorType: spec.executor ?? null,
          dependencies: [],
          retryPolicy: node.retryPolicy,
          timeoutMs: node.timeoutMs,
          effect: node.effect,
          input: spec.itemInput ? spec.itemInput(item, i, ctx) : item,
          parentStepId: s.id,
          itemIndex: i,
          config: spec.workflow ? { workflow: spec.workflow } : null,
        })),
      };
    }
  }
}

function decideFailure(
  def: CompiledWorkflow,
  snap: Snapshot,
  ctx: WorkflowContext,
  byKey: Map<string, StepState>,
): Command[] {
  const { task, steps } = snap;
  const failure = task.failure!;
  const normal = steps.filter((s) => s.type !== 'compensation');

  // Stop all forward progress that has not started yet.
  const skip = normal.filter((s) => ['PENDING', 'READY', 'WAITING', 'RETRYING'].includes(s.status));
  if (skip.length)
    return skip.map((s) => ({ kind: 'skipStep', stepId: s.id, reason: `task failed at ${failure.stepKey}` }));

  // In-flight attempts must finish (or expire) first: their results decide what needs compensation.
  if (normal.some((s) => s.status === 'RUNNING' || s.status === 'BLOCKED')) return statusCommand(task, steps);

  if (task.compensationStatus === null) {
    const compensable = normal
      .filter((s) => s.status === 'COMPLETED' && s.parentStepId === null)
      .map((s) => ({ s, comp: compensationOf(def, s.key) }))
      .filter((x): x is { s: StepState; comp: NonNullable<ReturnType<typeof compensationOf>> } => !!x.comp)
      .sort(
        (a, b) =>
          (b.s.completedAt?.getTime() ?? 0) - (a.s.completedAt?.getTime() ?? 0) ||
          (a.s.key < b.s.key ? 1 : -1),
      );
    if (compensable.length === 0) return [{ kind: 'finishTask', to: 'FAILED', error: failure }];
    const compCtx: WorkflowContext = { ...ctx, failure };
    let prev: string | null = null;
    const newSteps: NewStep[] = [];
    for (const { s, comp } of compensable) {
      const key = `${COMPENSATION_PREFIX}${s.key}`;
      let input: unknown;
      try {
        input = comp.spec.input
          ? comp.spec.input(compCtx)
          : { stepKey: s.key, input: s.input, output: s.output };
      } catch (e) {
        input = { stepKey: s.key, input: s.input, output: s.output, inputError: errMsg(e) };
      }
      newSteps.push({
        key,
        type: 'compensation',
        executorType: comp.spec.executor,
        dependencies: prev ? [prev] : [],
        retryPolicy: comp.retryPolicy,
        timeoutMs: comp.spec.timeoutMs ?? comp.timeoutMs,
        effect: 'idempotent',
        input,
        parentStepId: null,
        itemIndex: null,
        config: null,
      });
      prev = key;
    }
    return [{ kind: 'startCompensation', steps: newSteps }];
  }

  if (task.compensationStatus === 'RUNNING') {
    const comps = steps.filter((s) => s.type === 'compensation');
    const bad = comps.find((s) => s.status === 'FAILED' || s.status === 'CANCELLED');
    if (bad) {
      return [
        {
          kind: 'finishTask',
          to: 'FAILED',
          error: { ...failure, message: `${failure.message}; compensation ${bad.key} failed` },
          compensationStatus: 'FAILED',
        },
      ];
    }
    if (comps.every((s) => s.status === 'COMPLETED')) {
      return [{ kind: 'finishTask', to: 'FAILED', error: failure, compensationStatus: 'COMPLETED' }];
    }
    const promote: Command[] = comps
      .filter(
        (s) => s.status === 'PENDING' && s.dependencies.every((d) => byKey.get(d)?.status === 'COMPLETED'),
      )
      .map((s) => ({ kind: 'promote', stepId: s.id, input: s.input }));
    if (promote.length) return promote;
  }
  return statusCommand(task, steps);
}

function compensationOf(def: CompiledWorkflow, key: string) {
  const node = def.nodes.get(key);
  if (!node) return undefined;
  const spec = node.spec;
  const comp =
    spec.kind === 'task' || spec.kind === 'child' || spec.kind === 'map' ? spec.compensate : undefined;
  if (!comp) return undefined;
  return {
    spec: comp,
    retryPolicy: resolveRetryPolicy(def.spec.defaults?.retry, comp.retry),
    timeoutMs: node.timeoutMs,
  };
}
