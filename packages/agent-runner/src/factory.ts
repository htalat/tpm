import { classifyPullRequest, FACTORY_CONTEXT_PREFIX, type PrOutcome } from './pr-signal';
import { evaluatePolicy, type AgentPolicy, type Level } from './policy';
import type { PullRequestState } from './source';

/**
 * The factory's merge decision: a PURE function of durable evidence, so the
 * same evidence always gives the same answer and the history can show why a
 * PR was (or was not) merged.
 *
 * Order (escalate, never relax):
 *  1. platform state (merged, closed, changes requested, conflict, CI red, behind)
 *  2. the head must be the commit the agent produced and the reviewers saw
 *  3. factory gates on that commit: tpm/verify (if required), tpm/review-<name>
 *  4. the policy level of the changed files: human-merge | human-approve | auto-merge
 *  5. platform rules (GitHub BLOCKED = required reviews/checks not met yet)
 *  6. the daily auto-merge cap
 */
export interface StatusState {
  state: string; // success | failure | error | pending
  description: string;
}

export interface FactoryEvidence {
  pr: PullRequestState;
  /** Head commit at the end of the agent's round (what the reviewers reviewed). */
  reviewedSha: string;
  policy: AgentPolicy | null;
  changes: { files: string[]; additions: number; deletions: number };
  /** Commit statuses on pr.headSha, by context. */
  statuses: Record<string, StatusState>;
  /** "Approve" label events on the PR. */
  approvals: Array<{ actor: string; at: string }>;
  autoMergesToday: number;
}

export interface FactoryDecision extends PrOutcome {
  level?: Level;
  approvedBy?: string;
}

export const STATUS = {
  verify: 'tpm/verify',
  review: (name: string) => `tpm/review-${name}`,
  approval: 'tpm/human-approval',
} as const;

export function decideFactory(e: FactoryEvidence): FactoryDecision {
  const base = classifyPullRequest(e.pr);
  const at = { url: e.pr.url, headSha: e.pr.headSha };
  if (base.kind !== 'no-action') return base;
  if (e.pr.headSha !== e.reviewedSha) {
    return {
      ...at,
      kind: 'needs-human',
      reason: `new commits after the agent's round (${e.reviewedSha.slice(0, 7)} -> ${e.pr.headSha.slice(0, 7)})`,
    };
  }
  const policy = evaluatePolicy(e.policy, e.changes);

  const required = [
    ...(policy.verifyRequired ? [STATUS.verify] : []),
    ...(e.policy?.reviewers ?? []).map((r) => STATUS.review(r.name)),
  ];
  for (const ctx of required) {
    const s = e.statuses[ctx];
    if (!s || s.state === 'pending') return { ...at, kind: 'no-action', reason: `waiting for ${ctx}` };
    if (s.state === 'failure') return { ...at, kind: 'needs-agent', reason: `${ctx}: ${s.description}` };
    if (s.state === 'error') return { ...at, kind: 'needs-human', reason: `${ctx}: ${s.description}` };
  }

  const why = policy.reasons.length ? ` (${policy.reasons.join('; ')})` : '';
  if (policy.level === 'human-merge')
    return {
      ...at,
      kind: 'needs-human',
      reason: `policy: a human merges this change${why}`,
      level: policy.level,
    };

  let approvedBy: string | undefined;
  if (policy.level === 'human-approve') {
    const allowed = new Set(e.policy?.approvers ?? []);
    // Only an approval given after the newest commit counts: it is bound to what was reviewed.
    const after = e.pr.lastCommitAt ?? '';
    approvedBy = e.approvals.filter((a) => allowed.has(a.actor) && a.at > after).at(-1)?.actor;
    if (!approvedBy) {
      return {
        ...at,
        kind: 'no-action',
        reason: `policy: waiting for approval by ${[...allowed].join(', ') || '(no approvers configured)'}${why}`,
        level: policy.level,
      };
    }
  }

  if (e.pr.mergeStateStatus === 'BLOCKED' || e.pr.mergeStateStatus === 'UNKNOWN') {
    return {
      ...at,
      kind: 'no-action',
      reason: `platform: merge state ${e.pr.mergeStateStatus}`,
      level: policy.level,
    };
  }
  if (policy.level === 'auto-merge' && e.autoMergesToday >= (e.policy?.maxAutoMergesPerDay ?? 0)) {
    return {
      ...at,
      kind: 'needs-human',
      reason: `daily auto-merge cap reached (${e.autoMergesToday})`,
      level: policy.level,
    };
  }
  return {
    ...at,
    kind: 'ready-to-merge',
    reason:
      policy.level === 'auto-merge'
        ? 'all gates passed; policy allows auto-merge'
        : `approved by ${approvedBy}`,
    level: policy.level,
    approvedBy,
  };
}

export const isFactoryContext = (c: string) => c.startsWith(FACTORY_CONTEXT_PREFIX);
