import type { Clock, FailureInjector, IdGenerator, Random, WorkflowRegistry } from '@durable/core';
import type { Pool } from '@durable/db';
import type { Logger, MetricsRegistry } from '@durable/observability';

export interface EngineDeps {
  pool: Pool;
  registry: WorkflowRegistry;
  clock: Clock;
  ids: IdGenerator;
  random: Random;
  logger: Logger;
  metrics: MetricsRegistry;
  injector: FailureInjector;
  /** Default lease duration granted on claim and extended on heartbeat. */
  leaseMs: number;
}
