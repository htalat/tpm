import { describe, expect, it } from 'vitest';
import { useHarness } from '../support/harness';

describe('fan-out / fan-in and child tasks', () => {
  const h = useHarness();

  it('company-research: 100 items, never more than 10 in flight, fan-in after all complete', async () => {
    const companies = Array.from({ length: 100 }, (_, i) => `Company ${i}`);
    const { task } = await h.engine.createTask({ type: 'company-research', input: { companies } });
    const w = h.worker();
    let maxInFlight = 0;
    for (let round = 0; round < 500; round++) {
      await h.engine.tick();
      const r = await h.pool.query(
        `SELECT count(*)::int AS n FROM steps WHERE task_id = $1 AND parent_step_id IS NOT NULL AND status IN ('READY','RUNNING','RETRYING')`,
        [task.id],
      );
      maxInFlight = Math.max(maxInFlight, r.rows[0].n);
      const done = await w.pollOnce(50);
      const t = await h.task(task.id);
      if (t.status === 'WAITING' && done.length === 0) break;
    }
    expect(maxInFlight).toBe(10);
    const steps = await h.steps(task.id);
    expect(
      steps.filter((s) => s.key.startsWith('researchCompanies[')).every((s) => s.status === 'COMPLETED'),
    ).toBe(true);
    expect(steps.find((s) => s.key === 'researchCompanies')!.status).toBe('COMPLETED');
    expect((steps.find((s) => s.key === 'researchCompanies')!.output as unknown[]).length).toBe(100);
    expect(steps.find((s) => s.key === 'approval')!.status).toBe('WAITING');
    const artifacts = await h.pool.query(`SELECT count(*)::int AS n FROM artifacts WHERE task_id = $1`, [
      task.id,
    ]);
    expect(artifacts.rows[0].n).toBe(100);
    await h.engine.signal(task.id, { type: 'approval', payload: { approved: true } });
    const t = await h.drive(task.id, [w]);
    expect(t.status).toBe('COMPLETED');
    expect((t.output as { generateReport: { count: number } }).generateReport.count).toBe(100);
  });

  it('parent spawns children (map of child workflows + single child), survives restart, inspects results', async () => {
    const { task } = await h.engine.createTask({
      type: 'parent-with-children',
      input: { starts: [10, 20, 30] },
    });
    await h.engine.runUntilIdle();
    const children = await h.pool.query(
      `SELECT id, type, parent_step_id FROM tasks WHERE parent_task_id = $1`,
      [task.id],
    );
    // map concurrency 2 => two child sequences + one single child
    expect(children.rows).toHaveLength(3);
    // restart: brand-new engine instances only
    const t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
    const details = await h.newEngine().getTask(task.id);
    expect(details.children).toHaveLength(4);
    expect(details.children.every((c: { status: string }) => c.status === 'COMPLETED')).toBe(true);
    const combine = details.steps.find((s: { key: string }) => s.key === 'combine') as {
      output: { values: number[] };
    };
    expect(combine.output.values).toEqual([13, 23, 33, 3]);
  });

  it('a step can spawn its child only once (unique parent_step_id)', async () => {
    const { task } = await h.engine.createTask({ type: 'parent-with-children', input: { starts: [1] } });
    await h.engine.runUntilIdle();
    const c = (
      await h.pool.query(`SELECT parent_step_id FROM tasks WHERE parent_task_id = $1 LIMIT 1`, [task.id])
    ).rows[0];
    await expect(
      h.pool.query(
        `INSERT INTO tasks (id, type, workflow_version, status, parent_task_id, parent_step_id, created_at, updated_at)
         VALUES (gen_random_uuid(), 'example-sequence', 1, 'PENDING', $1, $2, now(), now())`,
        [task.id, c.parent_step_id],
      ),
    ).rejects.toThrow(/tasks_parent_step_uniq/);
  });

  it('Example F: the agent worker uses the ordinary protocol and persists an artifact', async () => {
    const { task } = await h.engine.createTask({ type: 'example-agent', input: { subject: 'Initech' } });
    const t = await h.drive(task.id, [h.worker()]);
    expect(t.status).toBe('COMPLETED');
    const a = await h.pool.query(`SELECT type, uri FROM artifacts WHERE task_id = $1`, [task.id]);
    expect(a.rows).toEqual([{ type: 'agent-report', uri: `memory://${task.id}/research/report.md` }]);
  });
});
