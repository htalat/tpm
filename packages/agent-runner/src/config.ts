import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const AdoRepoSchema = z.object({
  /** Organization name, as in https://dev.azure.com/<organization>. */
  organization: z.string().min(1),
  project: z.string().min(1),
  repository: z.string().min(1),
  /** Only work items under this area path (use it when one project feeds several repos). */
  areaPath: z.string().optional(),
});
export type AdoRepoConfig = z.infer<typeof AdoRepoSchema>;

export const RepoConfigSchema = z.object({
  /** Unique name. GitHub: "owner/repo". ADO: any label, e.g. "contoso/Web/website". */
  name: z.string().min(1).max(300),
  /** Where items come from. */
  tracker: z.enum(['github', 'azure-boards']).default('github'),
  /** Where pull requests live. */
  host: z.enum(['github', 'ado']).default('github'),
  /** Required when tracker or host is Azure DevOps. */
  ado: AdoRepoSchema.optional(),
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

function checkRepo(r: RepoConfig, ctx: z.RefinementCtx, i: number): void {
  if ((r.tracker === 'azure-boards' || r.host === 'ado') && !r.ado) {
    ctx.addIssue({
      code: 'custom',
      path: ['repos', i, 'ado'],
      message: `${r.name}: "ado" settings are required for Azure DevOps`,
    });
  }
  if (r.tracker === 'github' && !/^[^/\s]+\/[^/\s]+$/.test(r.name)) {
    ctx.addIssue({
      code: 'custom',
      path: ['repos', i, 'name'],
      message: `${r.name}: GitHub repos are named "owner/repo"`,
    });
  }
}

export const AgentRunnerConfigSchema = z
  .object({
    repos: z.array(RepoConfigSchema).min(1),
    /** Where per-attempt agent transcripts are written. */
    runsDir: z.string().default('data/agent-runs'),
    syncIntervalMs: z.number().int().min(1000).default(60_000),
  })
  .superRefine((cfg, ctx) => {
    cfg.repos.forEach((r, i) => checkRepo(r, ctx, i));
    const names = cfg.repos.map((r) => r.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: 'custom', path: ['repos'], message: 'repo names must be unique' });
  });
export type AgentRunnerConfig = z.infer<typeof AgentRunnerConfigSchema>;

export function loadAgentRunnerConfig(path: string): AgentRunnerConfig {
  return AgentRunnerConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function repoConfig(cfg: AgentRunnerConfig, repo: string): RepoConfig | undefined {
  return cfg.repos.find((r) => r.name === repo);
}
