import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Autonomy policy, stored IN the repository at `.tpm/agent-policy.yml` and
 * read only from the default branch. A change to the policy file itself is
 * always `human-merge`, so an agent can never raise its own autonomy.
 *
 *   auto-merge     agents write, agents review, the factory merges
 *   human-approve  agents write and review; a listed approver says yes; the factory merges
 *   human-merge    agents write and review; a human merges (today's behaviour)
 *
 * A change gets the MOST restrictive level of the files it touches; signals
 * (size, failed gates) can only escalate, never relax.
 */
export const LEVELS = ['auto-merge', 'human-approve', 'human-merge'] as const;
export type Level = (typeof LEVELS)[number];
const rank = (l: Level) => LEVELS.indexOf(l);
export const stricter = (a: Level, b: Level): Level => (rank(a) >= rank(b) ? a : b);

export const POLICY_PATH = '.tpm/agent-policy.yml';
const ALWAYS_HUMAN = ['.tpm/**'];

export const PolicySchema = z.object({
  version: z.literal(1),
  default: z.enum(LEVELS).default('human-merge'),
  rules: z
    .array(
      z.object({
        paths: z.array(z.string().min(1)).min(1),
        level: z.enum(LEVELS),
        /** Run the verify command before reviews count. */
        verify: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Agent reviewers; each must approve the same head commit. */
  reviewers: z
    .array(
      z.object({
        name: z.enum(['claude', 'copilot']),
        model: z.string().optional(),
        /** Claude only: cost cap per review in USD. */
        maxBudgetUsd: z.number().positive().max(50).optional(),
      }),
    )
    .max(2)
    .default([{ name: 'claude' }, { name: 'copilot' }]),
  /** Who may approve `human-approve` changes (tracker logins). */
  approvers: z.array(z.string().min(1)).default([]),
  /** If set, only these logins may start a run by adding the ready label. */
  starters: z.array(z.string().min(1)).optional(),
  verify: z
    .object({
      command: z.string().min(1),
      timeoutMinutes: z.number().positive().max(240).default(20),
    })
    .optional(),
  maxAutoMergesPerDay: z.number().int().min(0).default(5),
  /** Bigger changes need at least human-approve. */
  maxChangedLines: z.number().int().min(1).default(400),
});
export type AgentPolicy = z.infer<typeof PolicySchema>;

export function parsePolicy(text: string): AgentPolicy {
  return PolicySchema.parse(parseYaml(text));
}

/** Glob with `**` (any path), `*` (within a segment) and `?`. Patterns without `/` match the basename anywhere. */
export function globToRegExp(glob: string): RegExp {
  const anywhere = !glob.includes('/');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" = zero or more directories; trailing "**" = everything below.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`);
}

export const matches = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(path));

export interface PolicyEvaluation {
  level: Level;
  verifyRequired: boolean;
  /** Why the level is what it is (for comments and history). */
  reasons: string[];
}

/** No policy file = human-merge for everything (the factory only advises). */
export function evaluatePolicy(
  policy: AgentPolicy | null,
  change: { files: string[]; additions: number; deletions: number },
): PolicyEvaluation {
  if (!policy)
    return {
      level: 'human-merge',
      verifyRequired: false,
      reasons: [`no ${POLICY_PATH} on the default branch`],
    };
  if (change.files.length === 0)
    return { level: 'human-merge', verifyRequired: false, reasons: ['no changed files'] };
  let level: Level = 'auto-merge';
  let verifyRequired = false;
  const reasons: string[] = [];
  for (const f of change.files) {
    if (matches(f, ALWAYS_HUMAN)) {
      level = 'human-merge';
      reasons.push(`${f}: the policy itself always needs a human`);
      continue;
    }
    const rule = policy.rules.find((r) => matches(f, r.paths));
    const fileLevel = rule?.level ?? policy.default;
    if (rank(fileLevel) > rank('auto-merge')) reasons.push(`${f}: ${fileLevel}${rule ? '' : ' (default)'}`);
    level = stricter(level, fileLevel);
    verifyRequired ||= !!rule?.verify;
  }
  const lines = change.additions + change.deletions;
  if (lines > policy.maxChangedLines) {
    reasons.push(`${lines} changed lines > maxChangedLines ${policy.maxChangedLines}`);
    level = stricter(level, 'human-approve');
  }
  if (verifyRequired && !policy.verify) {
    reasons.push('verify required but no verify.command in the policy');
    level = 'human-merge';
  }
  return { level, verifyRequired, reasons };
}
