import { z } from 'zod';
import type { Level } from './policy';
import type { SourceTask } from './source';

/**
 * Independent agent reviewers. A reviewer gets a fresh context (the task,
 * the repo rules, the diff) and NOT the author's reasoning, runs read-only
 * (enforced by the CLI's tool permissions), and returns a structured verdict.
 * Its verdict is bound to the commit it reviewed (a commit status on that SHA).
 */
export const VerdictSchema = z.object({
  verdict: z.enum(['approve', 'request-changes', 'needs-human']),
  summary: z.string().max(2000),
  findings: z
    .array(
      z.object({
        file: z.string().optional(),
        line: z.number().int().optional(),
        severity: z.enum(['blocker', 'major', 'minor']),
        comment: z.string().max(2000),
      }),
    )
    .max(50)
    .default([]),
});
export type ReviewVerdict = z.infer<typeof VerdictSchema>;

export const VERDICT_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request-changes', 'needs-human'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'comment'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          comment: { type: 'string' },
        },
      },
    },
  },
});

export interface ReviewerCli {
  name: string;
  bin: string;
  envVar?: string;
  /** How the verdict comes back: a JSON-schema result, or <verdict> tags in the text. */
  format: 'schema' | 'tags';
  buildArgs(prompt: string, opts: { model?: string; maxBudgetUsd?: number }): string[];
  parse(output: string): ReviewVerdict | null;
}

const READ_ONLY = ['git diff', 'git log', 'git show', 'git status'];

function parseTagged(output: string): ReviewVerdict | null {
  const all = [...output.matchAll(/<verdict>([\s\S]*?)<\/verdict>/g)];
  for (const m of all.reverse()) {
    try {
      const r = VerdictSchema.safeParse(JSON.parse(m[1]!.trim()));
      if (r.success) return r.data;
    } catch {
      // try the previous match
    }
  }
  return null;
}

export const REVIEWER_CLIS: Record<string, ReviewerCli> = {
  claude: {
    name: 'claude',
    bin: 'claude',
    envVar: 'CLAUDE_BIN',
    format: 'schema',
    buildArgs: (prompt, opts) => [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--json-schema',
      VERDICT_JSON_SCHEMA,
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      ...READ_ONLY.map((c) => `Bash(${c}:*)`),
      '--disallowedTools',
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'Bash(git push:*)',
      'Bash(git commit:*)',
      'Bash(gh:*)',
      'Bash(rm:*)',
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.maxBudgetUsd ? ['--max-budget-usd', String(opts.maxBudgetUsd)] : []),
    ],
    parse(output) {
      for (const line of output.trim().split('\n').reverse()) {
        try {
          const j = JSON.parse(line) as { structured_output?: unknown };
          if (j.structured_output) {
            const r = VerdictSchema.safeParse(j.structured_output);
            return r.success ? r.data : null;
          }
        } catch {
          // not the result line
        }
      }
      return parseTagged(output);
    },
  },
  copilot: {
    name: 'copilot',
    bin: 'copilot',
    envVar: 'COPILOT_BIN',
    format: 'tags',
    buildArgs: (prompt, opts) => [
      '-p',
      prompt,
      ...READ_ONLY.flatMap((c) => ['--allow-tool', `shell(${c})`]),
      '--deny-tool',
      'write',
      '--deny-tool',
      'shell(git push)',
      '--deny-tool',
      'shell(git commit)',
      '--deny-tool',
      'shell(gh)',
      '--deny-tool',
      'shell(rm)',
      '--no-color',
      ...(opts.model ? ['--model', opts.model] : []),
    ],
    parse: parseTagged,
  },
};

export function resolveReviewerCli(
  name: string,
  registry: Record<string, ReviewerCli> = REVIEWER_CLIS,
): ReviewerCli {
  const entry = registry[name];
  if (!entry) throw new Error(`unknown reviewer "${name}" (known: ${Object.keys(registry).join(', ')})`);
  const override = entry.envVar ? process.env[entry.envVar] : undefined;
  return override ? { ...entry, bin: override } : entry;
}

export function buildReviewPrompt(o: {
  task: SourceTask;
  defaultBranch: string;
  branch: string;
  sha: string;
  level: Level;
  format: 'schema' | 'tags';
}): string {
  return `You are an independent code reviewer. Another agent wrote this change; you did not. You run non-interactively: nobody answers questions.
You are READ-ONLY: do not edit files, commit, push, or call the GitHub CLI.

# Task the change must implement
${o.task.title}
Source: ${o.task.url}

${o.task.body.trim() || '(no description)'}

# The change
Branch \`${o.branch}\`, commit \`${o.sha}\` (checked out here).
- Diff: \`git diff origin/${o.defaultBranch}...HEAD\`
- Commits: \`git log origin/${o.defaultBranch}..HEAD\`
Read the repository's AGENTS.md / CONTRIBUTING files if they exist and check the change follows them.

# Stakes
Policy level for these files: ${o.level}.${o.level === 'auto-merge' ? ' If you approve and the other reviewer approves, this change merges WITHOUT a human.' : ''}

# Decide
- approve: it does what the task asks, nothing unrelated, you found no defects, and it is safe to merge.
- request-changes: concrete problems the author agent can fix. List each as a finding.
- needs-human: the task is unclear, the change is risky, or you cannot judge it.
Be strict. When in doubt, do not approve.
${
  o.format === 'tags'
    ? `
# Output
End your answer with exactly one block:
<verdict>{"verdict": "approve" | "request-changes" | "needs-human", "summary": "...", "findings": [{"file": "...", "line": 1, "severity": "blocker" | "major" | "minor", "comment": "..."}]}</verdict>`
    : ''
}`;
}
