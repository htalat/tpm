import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const RepoConfigSchema = z.object({
  /** "owner/repo" as the tracker knows it. */
  name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  /** Absolute path of the local checkout the agent works in. */
  path: z.string().min(1),
  defaultBranch: z.string().default('main'),
  /** Agent CLI registry entry: claude | copilot | ... */
  agent: z.string().default('claude'),
  model: z.string().optional(),
  /** Hard bound for one agent run (the worker kills the agent after this). */
  timeBoundMinutes: z
    .number()
    .positive()
    .max(24 * 60)
    .default(30),
  /** Automatic agent rounds per item before a human must step in. */
  maxRounds: z.number().int().min(1).max(20).default(3),
  /** Extra instructions appended to the prompt (e.g. "read AGENTS.md"). */
  instructions: z.string().max(10_000).optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const AgentRunnerConfigSchema = z.object({
  source: z.literal('github').default('github'),
  repos: z.array(RepoConfigSchema).min(1),
  /** Where per-attempt agent transcripts are written. */
  runsDir: z.string().default('data/agent-runs'),
  syncIntervalMs: z.number().int().min(1000).default(60_000),
});
export type AgentRunnerConfig = z.infer<typeof AgentRunnerConfigSchema>;

export function loadAgentRunnerConfig(path: string): AgentRunnerConfig {
  return AgentRunnerConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function repoConfig(cfg: AgentRunnerConfig, repo: string): RepoConfig | undefined {
  return cfg.repos.find((r) => r.name === repo);
}
