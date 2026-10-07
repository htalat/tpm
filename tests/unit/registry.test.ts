import { describe, expect, it } from 'vitest';
import { createRegistry, exampleWorkflowsEnabled } from '@durable/workflows';

describe('workflow registry', () => {
  it('registers the factory workflow only, unless the examples are asked for', () => {
    const production = createRegistry({ examples: false });
    expect(production.get('agent-run')).toBeDefined();
    expect(production.get('example-sequence')).toBeUndefined();
    expect(production.get('durability-demo')).toBeUndefined();

    const dev = createRegistry({ examples: true });
    expect(dev.get('agent-run')).toBeDefined();
    expect(dev.get('example-sequence')).toBeDefined();
    expect(dev.get('durability-demo')).toBeDefined();
    expect(dev.get('chaos')).toBeDefined();
  });

  it('reads EXAMPLE_WORKFLOWS from the environment', () => {
    expect(exampleWorkflowsEnabled({})).toBe(false);
    expect(exampleWorkflowsEnabled({ EXAMPLE_WORKFLOWS: '' })).toBe(false);
    expect(exampleWorkflowsEnabled({ EXAMPLE_WORKFLOWS: '0' })).toBe(false);
    expect(exampleWorkflowsEnabled({ EXAMPLE_WORKFLOWS: '1' })).toBe(true);
    expect(exampleWorkflowsEnabled({ EXAMPLE_WORKFLOWS: 'true' })).toBe(true);
  });
});
