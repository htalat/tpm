/**
 * Minimal in-process metrics with Prometheus text exposition. Names follow
 * OpenTelemetry semantic style so they can be bridged to an OTel MeterProvider.
 */
type Labels = Record<string, string>;
const key = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/"/g, '\\"')}"`)
    .join(',');

export class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, n = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + n);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
}

export class Histogram {
  readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  ) {}
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]!++;
    });
    s.sum += value;
    s.count++;
    this.series.set(k, s);
  }
}

export type GaugeCollector = () => Promise<Array<{ labels: Labels; value: number }>>;

export class MetricsRegistry {
  readonly tasksCreated = new Counter('durable_tasks_created_total', 'Tasks created');
  readonly tasksCompleted = new Counter('durable_tasks_completed_total', 'Tasks completed');
  readonly tasksFailed = new Counter('durable_tasks_failed_total', 'Tasks failed');
  readonly tasksCancelled = new Counter('durable_tasks_cancelled_total', 'Tasks cancelled');
  readonly workClaimed = new Counter('durable_work_claimed_total', 'Attempts created by claims');
  readonly attemptFailures = new Counter('durable_attempt_failures_total', 'Attempts that failed or expired');
  readonly retries = new Counter('durable_retries_total', 'Retries scheduled');
  readonly leaseExpirations = new Counter('durable_lease_expirations_total', 'Leases expired and reaped');
  readonly staleCompletions = new Counter(
    'durable_stale_completions_rejected_total',
    'Completions rejected: lease lost',
  );
  readonly duplicateSignals = new Counter('durable_duplicate_signals_total', 'Signals deduplicated');
  readonly timerLatency = new Histogram(
    'durable_timer_latency_ms',
    'Delay between timer fire_at and actual firing',
  );
  readonly stepDuration = new Histogram(
    'durable_step_duration_ms',
    'Attempt duration from claim to completion',
  );
  private readonly gauges: Array<{ name: string; help: string; collect: GaugeCollector }> = [];

  gauge(name: string, help: string, collect: GaugeCollector): void {
    this.gauges.push({ name, help, collect });
  }

  async render(): Promise<string> {
    const out: string[] = [];
    for (const c of [
      this.tasksCreated,
      this.tasksCompleted,
      this.tasksFailed,
      this.tasksCancelled,
      this.workClaimed,
      this.attemptFailures,
      this.retries,
      this.leaseExpirations,
      this.staleCompletions,
      this.duplicateSignals,
    ]) {
      out.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
      if (c.values.size === 0) out.push(`${c.name} 0`);
      for (const [k, v] of c.values) out.push(`${c.name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const h of [this.timerLatency, this.stepDuration]) {
      out.push(`# HELP ${h.name} ${h.help}`, `# TYPE ${h.name} histogram`);
      for (const [k, s] of h.series) {
        const pre = k ? `${k},` : '';
        h.bounds.forEach((b, i) => out.push(`${h.name}_bucket{${pre}le="${b}"} ${s.buckets[i]}`));
        out.push(`${h.name}_bucket{${pre}le="+Inf"} ${s.count}`);
        out.push(
          `${h.name}_sum${k ? `{${k}}` : ''} ${s.sum}`,
          `${h.name}_count${k ? `{${k}}` : ''} ${s.count}`,
        );
      }
    }
    for (const g of this.gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      try {
        for (const { labels, value } of await g.collect()) {
          const k = key(labels);
          out.push(`${g.name}${k ? `{${k}}` : ''} ${value}`);
        }
      } catch {
        // gauge collection is best effort
      }
    }
    return out.join('\n') + '\n';
  }
}
