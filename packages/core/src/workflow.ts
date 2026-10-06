import type { ZodType } from 'zod';
import { resolveRetryPolicy, type RetryPolicy } from './retry';
import type { StepError } from './failure';

/**
 * Declarative workflow definitions.
 *
 * This engine persists an explicit state machine; it does NOT replay workflow
 * code. Definitions are therefore data plus small *pure* functions that map
 * already-persisted values (task input, completed step outputs) to the input of
 * the next step. Those functions run inside the orchestrator transaction that
 * persists their result, so a crash before commit simply re-evaluates them.
 * They must be deterministic and must not perform I/O.
 */

/** How a step behaves if its outcome is unknown (worker died mid-execution). */
export type Effect =
  /** No external side effects: safe to re-run blindly. Lost leases count as TIMEOUT. */
  | 'pure'
  /** Side effects guarded by the step idempotency key. Lost leases count as AMBIGUOUS and are retried with reconciliation. */
  | 'idempotent'
  /** Side effects that cannot be safely repeated. Lost leases block the step for an operator. */
  | 'unsafe';

export interface WorkflowContext {
  taskId: string;
  input: unknown;
  /** Outputs of completed top-level steps, by step key. */
  outputs: Readonly<Record<string, unknown>>;
  /** Present when building compensation input. */
  failure?: StepError & { stepKey: string };
}

export type InputFn = (ctx: WorkflowContext) => unknown;

interface Common {
  /** Explicit dependencies in addition to those implied by `flow`. */
  after?: string[];
  description?: string;
}

export interface CompensationSpec {
  executor: string;
  input?: InputFn;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
}

interface Exec {
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  effect?: Effect;
  compensate?: CompensationSpec;
}

export interface TaskNodeSpec extends Common, Exec {
  kind: 'task';
  /** Capability name a worker must advertise to run this step. */
  executor: string;
  input?: InputFn;
}

export interface MapNodeSpec extends Common, Exec {
  kind: 'map';
  items: (ctx: WorkflowContext) => readonly unknown[];
  /** Run each item as a worker step with this capability... */
  executor?: string;
  /** ...or as a child task of this workflow. Exactly one of executor/workflow. */
  workflow?: string;
  itemInput?: (item: unknown, index: number, ctx: WorkflowContext) => unknown;
  /** Maximum number of items in flight at once. */
  concurrency: number;
  maxItems?: number;
}

export interface WaitNodeSpec extends Common {
  kind: 'wait_event';
  eventType: string;
  correlationKey?: (ctx: WorkflowContext) => string | undefined;
}

export interface SleepNodeSpec extends Common {
  kind: 'sleep';
  durationMs: number | ((ctx: WorkflowContext) => number);
}

export interface ChildNodeSpec extends Common {
  kind: 'child';
  workflow: string;
  input?: InputFn;
  compensate?: CompensationSpec;
}

export type NodeSpec = TaskNodeSpec | MapNodeSpec | WaitNodeSpec | SleepNodeSpec | ChildNodeSpec;

export type Flow = string | { seq: Flow[] } | { par: Flow[] };

export const step = (o: Omit<TaskNodeSpec, 'kind'>): TaskNodeSpec => ({ kind: 'task', ...o });
export const map = (o: Omit<MapNodeSpec, 'kind'>): MapNodeSpec => ({ kind: 'map', ...o });
export const waitForEvent = (
  eventType: string,
  o: Omit<WaitNodeSpec, 'kind' | 'eventType'> = {},
): WaitNodeSpec => ({
  kind: 'wait_event',
  eventType,
  ...o,
});
export const sleep = (
  durationMs: SleepNodeSpec['durationMs'],
  o: Omit<SleepNodeSpec, 'kind' | 'durationMs'> = {},
) => ({ kind: 'sleep', durationMs, ...o }) satisfies SleepNodeSpec as SleepNodeSpec;
export const childTask = (
  workflow: string,
  o: Omit<ChildNodeSpec, 'kind' | 'workflow'> = {},
): ChildNodeSpec => ({
  kind: 'child',
  workflow,
  ...o,
});
export const sequence = (...items: Flow[]): Flow => ({ seq: items });
export const parallel = (...items: Flow[]): Flow => ({ par: items });

export interface WorkflowDefaults {
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  effect?: Effect;
}

export interface WorkflowSpec {
  name: string;
  version?: number;
  description?: string;
  /** Optional runtime schema for task input. */
  input?: ZodType;
  steps: Record<string, NodeSpec>;
  flow?: Flow;
  output?: (ctx: WorkflowContext) => unknown;
  defaults?: WorkflowDefaults;
}

export interface CompiledNode {
  key: string;
  spec: NodeSpec;
  dependencies: string[];
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  effect: Effect;
}

export interface CompiledWorkflow {
  name: string;
  version: number;
  spec: WorkflowSpec;
  nodes: ReadonlyMap<string, CompiledNode>;
  /** Topological order of node keys. */
  order: readonly string[];
}

export class WorkflowDefinitionError extends Error {
  constructor(workflow: string, message: string) {
    super(`workflow ${workflow}: ${message}`);
    this.name = 'WorkflowDefinitionError';
  }
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Compile and validate a workflow. Throws WorkflowDefinitionError on invalid definitions. */
export function defineWorkflow(spec: WorkflowSpec): CompiledWorkflow {
  const fail = (m: string): never => {
    throw new WorkflowDefinitionError(spec.name, m);
  };
  if (!KEY_RE.test(spec.name)) fail('invalid workflow name');
  const keys = Object.keys(spec.steps);
  if (keys.length === 0) fail('workflow must have at least one step');

  const deps = new Map<string, Set<string>>(keys.map((k) => [k, new Set<string>()]));
  for (const k of keys) {
    if (!KEY_RE.test(k)) fail(`invalid step key "${k}"`);
    const n = spec.steps[k]!;
    for (const a of n.after ?? []) {
      if (!deps.has(a)) fail(`step ${k} depends on unknown step ${a}`);
      deps.get(k)!.add(a);
    }
    if (n.kind === 'map') {
      if (!!n.executor === !!n.workflow) fail(`map step ${k} needs exactly one of executor or workflow`);
      if (!Number.isInteger(n.concurrency) || n.concurrency < 1) fail(`map step ${k} needs concurrency >= 1`);
    }
    if (n.kind === 'sleep' && typeof n.durationMs === 'number' && n.durationMs < 0)
      fail(`sleep ${k} is negative`);
  }

  if (spec.flow) {
    const walk = (f: Flow): { starts: string[]; ends: string[] } => {
      if (typeof f === 'string') {
        if (!deps.has(f)) fail(`flow references unknown step ${f}`);
        return { starts: [f], ends: [f] };
      }
      if ('seq' in f) {
        if (f.seq.length === 0) fail('empty sequence');
        const parts = f.seq.map(walk);
        for (let i = 1; i < parts.length; i++) {
          for (const s of parts[i]!.starts) for (const e of parts[i - 1]!.ends) deps.get(s)!.add(e);
        }
        return { starts: parts[0]!.starts, ends: parts[parts.length - 1]!.ends };
      }
      if (f.par.length === 0) fail('empty parallel');
      const parts = f.par.map(walk);
      return { starts: parts.flatMap((p) => p.starts), ends: parts.flatMap((p) => p.ends) };
    };
    walk(spec.flow);
  }

  // Topological sort (Kahn); detects cycles.
  const order: string[] = [];
  const remaining = new Map([...deps].map(([k, d]) => [k, new Set(d)]));
  while (remaining.size) {
    const ready = [...remaining].filter(([, d]) => d.size === 0).map(([k]) => k);
    if (ready.length === 0) fail(`dependency cycle among ${[...remaining.keys()].join(', ')}`);
    for (const k of ready) {
      order.push(k);
      remaining.delete(k);
      for (const d of remaining.values()) d.delete(k);
    }
  }

  const nodes = new Map<string, CompiledNode>();
  for (const k of order) {
    const n = spec.steps[k]!;
    const exec = n.kind === 'task' || n.kind === 'map' ? n : undefined;
    nodes.set(k, {
      key: k,
      spec: n,
      dependencies: [...deps.get(k)!].sort(),
      retryPolicy: resolveRetryPolicy(spec.defaults?.retry, exec?.retry),
      timeoutMs: exec?.timeoutMs ?? spec.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      effect: exec?.effect ?? spec.defaults?.effect ?? 'idempotent',
    });
  }
  return { name: spec.name, version: spec.version ?? 1, spec, nodes, order };
}

/** Registry of trusted, code-defined workflows. Workflow code is never accepted over the network. */
export class WorkflowRegistry {
  private readonly byName = new Map<string, Map<number, CompiledWorkflow>>();

  register(...wfs: CompiledWorkflow[]): this {
    for (const wf of wfs) {
      const versions = this.byName.get(wf.name) ?? new Map<number, CompiledWorkflow>();
      if (versions.has(wf.version)) throw new Error(`workflow ${wf.name}@${wf.version} registered twice`);
      versions.set(wf.version, wf);
      this.byName.set(wf.name, versions);
    }
    return this;
  }

  get(name: string, version?: number): CompiledWorkflow | undefined {
    const versions = this.byName.get(name);
    if (!versions) return undefined;
    if (version !== undefined) return versions.get(version);
    return versions.get(Math.max(...versions.keys()));
  }

  list(): CompiledWorkflow[] {
    return [...this.byName.values()].flatMap((v) => [...v.values()]);
  }

  /** Verify cross-workflow references (child tasks). */
  validate(): this {
    for (const wf of this.list()) {
      for (const n of wf.nodes.values()) {
        const child =
          n.spec.kind === 'child' ? n.spec.workflow : n.spec.kind === 'map' ? n.spec.workflow : undefined;
        if (child && !this.get(child))
          throw new WorkflowDefinitionError(wf.name, `unknown child workflow ${child}`);
      }
    }
    return this;
  }
}
