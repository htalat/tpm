import type { PullRequestState } from './source';

/**
 * PR outcome classifier (ported from tpm's GitHub host adapter). Priority:
 * merged > abandoned > not actionable (draft) > human-blocking
 * (changes requested) > agent-actionable (conflict > CI > behind > fresh
 * review comments) > no action.
 */
export type PrOutcomeKind = 'merged' | 'abandoned' | 'needs-human' | 'needs-agent' | 'no-action';

export interface PrOutcome {
  kind: PrOutcomeKind;
  reason: string;
  url: string;
  headSha: string;
}

export const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'ERROR']);

export function classifyPullRequest(pr: PullRequestState): PrOutcome {
  const base = { url: pr.url, headSha: pr.headSha };
  if (pr.state === 'MERGED') return { ...base, kind: 'merged', reason: 'pull request merged' };
  if (pr.state === 'CLOSED')
    return { ...base, kind: 'abandoned', reason: 'pull request closed without merge' };
  if (pr.state !== 'OPEN' || pr.isDraft)
    return { ...base, kind: 'no-action', reason: 'draft or unknown state' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    return { ...base, kind: 'needs-human', reason: 'changes requested by a reviewer' };
  if (pr.mergeStateStatus === 'DIRTY') return { ...base, kind: 'needs-agent', reason: 'merge conflict' };
  const failed = pr.checks.filter((c) => FAILED_CONCLUSIONS.has((c.conclusion ?? '').toUpperCase()));
  if (failed.length)
    return { ...base, kind: 'needs-agent', reason: `CI failed: ${failed.map((c) => c.name).join(', ')}` };
  if (pr.mergeStateStatus === 'BEHIND')
    return { ...base, kind: 'needs-agent', reason: 'branch is behind the base branch' };
  // A COMMENTED review only counts if it is newer than the newest commit:
  // otherwise the agent already pushed after it and would thrash on stale feedback.
  const fresh = pr.latestReviews.some(
    (r) => r.state === 'COMMENTED' && (!pr.lastCommitAt || !r.submittedAt || r.submittedAt > pr.lastCommitAt),
  );
  if (fresh) return { ...base, kind: 'needs-agent', reason: 'new review comments' };
  return { ...base, kind: 'no-action', reason: 'waiting for review' };
}

const MAX_FEEDBACK_CHARS = 20_000;

/** Feedback for the next round's prompt, bounded so it fits in a step output. */
export function formatFeedback(f: {
  reviews: Array<{ author: string; state: string; body: string }>;
  comments: Array<{ author: string; body: string }>;
  failedChecks: string[];
  mergeStateStatus: string;
}): string {
  const parts: string[] = [];
  if (f.failedChecks.length) parts.push(`Failed checks: ${f.failedChecks.join(', ')}`);
  if (f.mergeStateStatus === 'DIRTY') parts.push('The branch has merge conflicts with the base branch.');
  if (f.mergeStateStatus === 'BEHIND') parts.push('The branch is behind the base branch.');
  for (const r of f.reviews.filter((r) => r.body.trim()))
    parts.push(`Review by ${r.author} (${r.state}):\n${r.body.trim()}`);
  // Our own status comments carry a durable marker; they are not feedback.
  for (const c of f.comments.filter((c) => c.body.trim() && !c.body.includes('<!-- durable:'))) {
    parts.push(`Comment by ${c.author}:\n${c.body.trim()}`);
  }
  const text = parts.join('\n\n') || '(no written feedback)';
  return text.length > MAX_FEEDBACK_CHARS ? `${text.slice(0, MAX_FEEDBACK_CHARS)}\n…(truncated)` : text;
}
