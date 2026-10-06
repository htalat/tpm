import Anthropic from '@anthropic-ai/sdk';
import { WorkerError } from '@durable/core';
import type { AgentAdapter, AgentInput } from './agent';

/**
 * OPTIONAL real-LLM adapter. Nothing in the engine or the default worker
 * imports this file; the worker loads it only when AGENT_ADAPTER=anthropic.
 * Credentials come from the SDK's normal resolution (ANTHROPIC_API_KEY, or an
 * `ant auth login` profile).
 *
 * It maps provider errors onto the engine's failure categories, which is the
 * only "integration" an agent needs: rate limits and 5xx are TRANSIENT,
 * refusals are POLICY, bad requests are PERMANENT.
 */
export class AnthropicAgentAdapter implements AgentAdapter {
  private readonly client: Anthropic;

  constructor(
    private readonly model = 'claude-opus-5-5',
    client?: Anthropic,
  ) {
    // The engine owns retries (with persisted backoff); keep SDK retries low.
    this.client = client ?? new Anthropic({ maxRetries: 1 });
  }

  async execute(input: unknown, opts: { signal: AbortSignal; idempotencyKey: string }): Promise<unknown> {
    const { task, subject } = (input ?? {}) as AgentInput;
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          output_config: { effort: 'medium' },
          // Refusal fallback routed by the API (see the README's agent section).
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system:
            'You are a research assistant. Reply with one summary sentence on the first line, ' +
            'then 3-5 findings, each on its own line starting with "- ".',
          messages: [
            { role: 'user', content: `Task: ${task ?? 'overview'}\nSubject: ${subject ?? 'unspecified'}` },
          ],
          metadata: { user_id: opts.idempotencyKey.slice(0, 64) },
        },
        { signal: opts.signal },
      );
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new WorkerError('TRANSIENT', 'rate limited', 30_000);
      if (e instanceof Anthropic.BadRequestError) throw new WorkerError('PERMANENT', e.message);
      if (e instanceof Anthropic.AuthenticationError)
        throw new WorkerError('POLICY', 'authentication failed');
      if (e instanceof Anthropic.APIError) throw new WorkerError('TRANSIENT', `API error ${e.status}`);
      throw e; // network errors / aborts: classified by the worker runtime
    }
    if (response.stop_reason === 'refusal') {
      throw new WorkerError('POLICY', `model declined: ${response.stop_details?.category ?? 'unspecified'}`);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const lines = text.split('\n').map((l) => l.trim());
    return {
      model: response.model,
      summary: lines[0] ?? '',
      findings: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    };
  }
}
