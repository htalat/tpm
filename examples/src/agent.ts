import type { ArtifactStore, WorkerHandler } from '@durable/sdk';

/**
 * An AI agent is just a worker. The engine never sees anything agent-specific:
 * it hands out a bounded work item and receives an output plus artifact refs.
 * Any provider (or none) can sit behind this interface.
 */
export interface AgentAdapter {
  execute(input: unknown, opts: { signal: AbortSignal; idempotencyKey: string }): Promise<unknown>;
}

export interface AgentInput {
  task: string;
  subject?: string;
}

export interface AgentOutput {
  summary: string;
  findings: string[];
  artifactUri: string;
  model: string;
}

/** Deterministic stand-in for an LLM. No network, no API key. */
export class MockAgentAdapter implements AgentAdapter {
  constructor(private readonly latencyMs = 50) {}

  async execute(input: unknown, opts: { signal: AbortSignal }): Promise<unknown> {
    const { task, subject } = (input ?? {}) as AgentInput;
    await new Promise((r, rej) => {
      const t = setTimeout(r, this.latencyMs);
      opts.signal.addEventListener('abort', () => (clearTimeout(t), rej(opts.signal.reason)), { once: true });
    });
    const s = subject ?? 'the request';
    return {
      model: 'mock-agent-1',
      summary: `Research on ${s}: ${task ?? 'general overview'}.`,
      findings: [`${s} has a public website`, `${s} was analysed deterministically`, `confidence: mock`],
    };
  }
}

/** Wrap any AgentAdapter as a worker handler that also persists a report artifact. */
export function createAgentHandler(adapter: AgentAdapter): WorkerHandler<AgentInput, AgentOutput> {
  return {
    async execute(input, ctx) {
      const raw = (await adapter.execute(input, {
        signal: ctx.signal,
        idempotencyKey: ctx.idempotencyKey,
      })) as {
        summary: string;
        findings: string[];
        model: string;
      };
      const report = `# ${raw.summary}\n\n${raw.findings.map((f) => `- ${f}`).join('\n')}\n`;
      // Key derived from the idempotency key: a retried attempt overwrites the same object.
      const uri = await ctx.artifacts.put(`${ctx.item.taskId}/${ctx.item.stepKey}/report.md`, report);
      ctx.addArtifact({ type: 'agent-report', uri, metadata: { model: raw.model, bytes: report.length } });
      return { summary: raw.summary, findings: raw.findings, model: raw.model, artifactUri: uri };
    },
  };
}

export type { ArtifactStore };
