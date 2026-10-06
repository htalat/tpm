/**
 * Failure injection. Production code calls `injector.hit(point)` at
 * well-defined durability boundaries. When configured, the injector "crashes"
 * the process at that point: in real processes by SIGKILL (no cleanup, no
 * finally blocks, open transactions are rolled back by PostgreSQL), in
 * in-process tests by throwing SimulatedCrash.
 */
export const CRASH_POINTS = [
  'AFTER_WORK_CLAIMED',
  'AFTER_SIDE_EFFECT',
  'BEFORE_COMPLETION_SEND',
  'BEFORE_COMPLETION_COMMIT',
  'AFTER_COMPLETION_COMMIT',
  'BEFORE_TIMER_REGISTRATION',
  'AFTER_TIMER_REGISTRATION',
  'MID_ORCHESTRATION_CYCLE',
  'BEFORE_TIMER_FIRE_COMMIT',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

export interface FailureInjector {
  hit(point: CrashPoint): void;
}

export const noFailureInjection: FailureInjector = { hit: () => undefined };

/** Rules map a crash point to the 1-based hit number that triggers the crash. */
export class ConfiguredFailureInjector implements FailureInjector {
  private readonly counts = new Map<CrashPoint, number>();
  constructor(
    private readonly rules: ReadonlyMap<CrashPoint, number>,
    private readonly onCrash: (point: CrashPoint) => never = (p) => {
      throw new SimulatedCrash(p);
    },
  ) {}

  hit(point: CrashPoint): void {
    const at = this.rules.get(point);
    if (at === undefined) return;
    const n = (this.counts.get(point) ?? 0) + 1;
    this.counts.set(point, n);
    if (n === at) this.onCrash(point);
  }
}

/** Parses "AFTER_SIDE_EFFECT,BEFORE_TIMER_REGISTRATION:2". */
export function parseCrashRules(spec: string | undefined): Map<CrashPoint, number> {
  const rules = new Map<CrashPoint, number>();
  if (!spec) return rules;
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [name, n] = part.split(':');
    if (!(CRASH_POINTS as readonly string[]).includes(name!)) throw new Error(`unknown crash point ${name}`);
    rules.set(name as CrashPoint, n ? Number(n) : 1);
  }
  return rules;
}
