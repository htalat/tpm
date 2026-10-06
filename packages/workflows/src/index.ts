import type { WorkflowRegistry } from '@durable/core';
import { agentRunWorkflow } from '@durable/agent-runner';
import { createExampleRegistry } from '@durable/examples';

/**
 * Every workflow this deployment can run. The API and the orchestrator must
 * load the same registry: a task can only be orchestrated by a process that
 * knows its definition.
 */
export function createRegistry(): WorkflowRegistry {
  return createExampleRegistry().register(agentRunWorkflow).validate();
}
