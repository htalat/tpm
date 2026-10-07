import pg from 'pg';
import { LiveEvent } from '@durable/contract';
import type { Logger } from '@durable/observability';
import type { z } from 'zod';

export type LiveEventT = z.output<typeof LiveEvent>;
export interface LiveFilter {
  taskId?: string;
  taskType?: string;
}

/**
 * One LISTEN connection for the whole API process, fanned out to SSE
 * subscribers. Reconnects with backoff. Events are only hints: a client that
 * (re)connects must fetch a snapshot, because notifications sent while it was
 * away are not replayed.
 */
export class LiveEvents {
  private client: pg.Client | null = null;
  private readonly subs = new Set<{ filter: LiveFilter; send: (e: LiveEventT) => void }>();
  private stopped = false;
  private backoff = 500;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      connectionString: this.connectionString,
      application_name: 'durable-api-live',
    });
    client.on('notification', (msg) => this.dispatch(msg.payload));
    client.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'live events connection lost; reconnecting');
      void this.reconnect(client);
    });
    client.on('end', () => void this.reconnect(client));
    try {
      await client.connect();
      await client.query('LISTEN durable_events');
      this.client = client;
      this.backoff = 500;
    } catch (e) {
      this.logger.warn({ err: (e as Error).message }, 'live events connect failed; retrying');
      await client.end().catch(() => undefined);
      setTimeout(() => void this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    }
  }

  private async reconnect(old: pg.Client): Promise<void> {
    if (this.client !== old) return; // already replaced
    this.client = null;
    await old.end().catch(() => undefined);
    setTimeout(() => void this.connect(), this.backoff);
  }

  private dispatch(payload: string | undefined): void {
    if (!payload) return;
    const parsed = LiveEvent.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues.length }, 'ignoring malformed live event');
      return;
    }
    const e = parsed.data;
    for (const s of this.subs) {
      if (s.filter.taskId && s.filter.taskId !== e.taskId) continue;
      if (s.filter.taskType && s.filter.taskType !== e.taskType) continue;
      s.send(e);
    }
  }

  subscribe(filter: LiveFilter, send: (e: LiveEventT) => void): () => void {
    const sub = { filter, send };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  get subscribers(): number {
    return this.subs.size;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }
}
