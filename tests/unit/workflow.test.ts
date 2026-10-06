import { describe, expect, it } from 'vitest';
import {
  decide,
  defineWorkflow,
  initialSteps,
  map,
  parallel,
  sequence,
  sleep,
  step,
  waitForEvent,
  WorkflowDefinitionError,
  type Snapshot,
  type StepState,
} from '@durable/core';

const wf = defineWorkflow({
  name: 'w',
  steps: {
    a: step({ executor: 'x' }),
    b1: step({ executor: 'x' }),
    b2: step({ executor: 'x' }),
    agg: step({ executor: 'x', input: (c) => [c.outputs.b1, c.outputs.b2] }),
  },
  flow: sequence('a', parallel('b1', 'b2'), 'agg'),
});

function snap(steps: Array<Partial<StepState> & { key: string }>, extra: Partial<Snapshot> = {}): Snapshot {
  const base = initialSteps(wf);
  return {
    task: { id: 't', type: 'w', status: 'RUNNING', input: null, failure: null, compensationStatus: null },
    steps: base.map((s) => ({
      id: s.key,
      key: s.key,
      type: s.type,
      status: 'PENDING',
      input: null,
      output: null,
      error: null,
      dependencies: s.dependencies,
      parentStepId: null,
      itemIndex: null,
      wait: null,
      config: null,
      completedAt: null,
      ...steps.find((x) => x.key === s.key),
    })),
    events: [],
    children: [],
    now: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  };
}

describe('workflow compilation', () => {
  it('compiles sequence/parallel into dependencies', () => {
    expect(wf.nodes.get('a')!.dependencies).toEqual([]);
    expect(wf.nodes.get('b1')!.dependencies).toEqual(['a']);
    expect(wf.nodes.get('agg')!.dependencies).toEqual(['b1', 'b2']);
  });

  it('rejects cycles, unknown references and bad map nodes', () => {
    expect(() =>
      defineWorkflow({
        name: 'c',
        steps: { a: step({ executor: 'x', after: ['b'] }), b: step({ executor: 'x', after: ['a'] }) },
      }),
    ).toThrow(WorkflowDefinitionError);
    expect(() =>
      defineWorkflow({ name: 'u', steps: { a: step({ executor: 'x' }) }, flow: sequence('a', 'zzz') }),
    ).toThrow(/unknown/);
    expect(() =>
      defineWorkflow({ name: 'm', steps: { m: map({ items: () => [], concurrency: 1 }) } }),
    ).toThrow(/exactly one/);
  });
});

describe('decide()', () => {
  it('promotes only steps whose dependencies completed', () => {
    const cmds = decide(wf, snap([]));
    expect(cmds).toEqual([{ kind: 'promote', stepId: 'a', input: null, concurrency: null }]);
  });

  it('fans in only when all parallel branches completed', () => {
    const partial = decide(
      wf,
      snap([
        { key: 'a', status: 'COMPLETED' },
        { key: 'b1', status: 'COMPLETED', output: 1 },
        { key: 'b2', status: 'RUNNING' },
      ]),
    );
    expect(partial.find((c) => c.kind === 'promote')).toBeUndefined();
    const all = decide(
      wf,
      snap([
        { key: 'a', status: 'COMPLETED' },
        { key: 'b1', status: 'COMPLETED', output: 1 },
        { key: 'b2', status: 'COMPLETED', output: 2 },
      ]),
    );
    expect(all).toEqual([{ kind: 'promote', stepId: 'agg', input: [1, 2], concurrency: null }]);
  });

  it('is a no-op for terminal and paused tasks', () => {
    const s = snap([]);
    expect(decide(wf, { ...s, task: { ...s.task, status: 'CANCELLED' } })).toEqual([]);
    expect(decide(wf, { ...s, task: { ...s.task, status: 'PAUSED' } })).toEqual([]);
  });

  it('consumes a single matching event for a waiting step', () => {
    const w = defineWorkflow({
      name: 'e',
      steps: { ap: waitForEvent('approval'), z: sleep(1) },
      flow: sequence('ap', 'z'),
    });
    const s: Snapshot = {
      task: { id: 't', type: 'e', status: 'WAITING', input: null, failure: null, compensationStatus: null },
      steps: [
        {
          id: 'ap',
          key: 'ap',
          type: 'wait_event',
          status: 'WAITING',
          input: null,
          output: null,
          error: null,
          dependencies: [],
          parentStepId: null,
          itemIndex: null,
          wait: { eventType: 'approval', correlationKey: null },
          config: null,
          completedAt: null,
        },
        {
          id: 'z',
          key: 'z',
          type: 'sleep',
          status: 'PENDING',
          input: null,
          output: null,
          error: null,
          dependencies: ['ap'],
          parentStepId: null,
          itemIndex: null,
          wait: null,
          config: null,
          completedAt: null,
        },
      ],
      events: [
        { id: 'e1', eventType: 'approval', correlationKey: null, payload: { ok: 1 } },
        { id: 'e2', eventType: 'approval', correlationKey: null, payload: { ok: 2 } },
      ],
      children: [],
      now: new Date(0),
    };
    expect(decide(w, s)).toEqual([
      { kind: 'completeStep', stepId: 'ap', output: { ok: 1 }, consumeEventId: 'e1' },
    ]);
  });
});
