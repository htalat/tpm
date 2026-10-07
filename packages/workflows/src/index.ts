import { WorkflowRegistry } from '@durable/core';
import { agentRunWorkflow } from '@durable/agent-runner';
import { createExampleRegistry } from '@durable/examples';

export interface RegistryOptions {
  /**
   * Also register the example workflows from `@durable/examples`. Off by
   * default: production only runs the factory. The demos, the chaos test and
   * `npm run dev` turn it on. Default: `EXAMPLE_WORKFLOWS=1` in the environment.
   */
  examples?: boolean;
}

/** True when the environment asks for the example workflows. */
export function exampleWorkflowsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['1', 'true'].includes((env.EXAMPLE_WORKFLOWS ?? '').trim().toLowerCase());
}

/**
 * Every workflow this deployment can run. The API and the orchestrator must
 * load the same registry: a task can only be orchestrated by a process that
 * knows its definition.
 */
export function createRegistry(opts: RegistryOptions = {}): WorkflowRegistry {
  const examples = opts.examples ?? exampleWorkflowsEnabled();
  const registry = examples ? createExampleRegistry() : new WorkflowRegistry();
  return registry.register(agentRunWorkflow).validate();
}
