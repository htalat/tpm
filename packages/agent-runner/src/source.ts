/**
 * Where work comes from. The tracker (GitHub Issues, Linear, Jira, ...) is the
 * source of truth for *intent*: what should be done, discussion, priority.
 * The engine is the source of truth for *execution*. A source only needs to
 * list opted-in work, read one item, update labels, post a comment, and find
 * the pull requests an agent opened for an item.
 *
 * Every write here is an external side effect performed by a worker step, so
 * each one must be idempotent: label edits are naturally idempotent, and
 * comments carry a hidden marker that `comment()` checks before posting.
 */
export interface SourceTask {
  /** Stable id, e.g. "github:owner/repo#12". */
  ref: string;
  /** Repository the work happens in, e.g. "owner/repo". */
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface PullRequestRef {
  url: string;
  state: string;
}

/** Everything the PR classifier and the round baseline need. */
export interface PullRequestState {
  url: string;
  /** OPEN | MERGED | CLOSED */
  state: string;
  headSha: string;
  isDraft: boolean;
  reviewDecision: string | null;
  /** e.g. CLEAN | DIRTY | BEHIND | BLOCKED | UNKNOWN */
  mergeStateStatus: string;
  checks: Array<{ name: string; conclusion: string | null }>;
  latestReviews: Array<{ state: string; submittedAt: string }>;
  /** ISO timestamp of the newest commit on the branch. */
  lastCommitAt: string | null;
}

export interface TaskSource {
  readonly name: string;
  /** Open items carrying the "ready" label in the given repos. */
  listReady(repos: string[]): Promise<SourceTask[]>;
  get(ref: string): Promise<SourceTask>;
  updateLabels(ref: string, change: { add?: string[]; remove?: string[] }): Promise<void>;
  /** Post `body` unless a comment containing `marker` already exists. */
  comment(ref: string, body: string, marker: string): Promise<{ posted: boolean }>;
  /** PRs opened from the agent's branch for this item (any state). */
  findPullRequests(ref: string, branch: string): Promise<PullRequestRef[]>;
  getPullRequest(url: string): Promise<PullRequestState>;
  /** Human-readable review feedback (reviews, comments, failed checks) for the next round's prompt. */
  getFeedback(url: string): Promise<string>;
}

export const LABELS = {
  ready: 'agent:ready',
  running: 'agent:running',
  review: 'agent:review',
  failed: 'agent:failed',
  done: 'agent:done',
} as const;

/** Deterministic branch name: lets a retry find the work of a crashed attempt. */
export const branchFor = (task: Pick<SourceTask, 'number'>): string => `agent/issue-${task.number}`;

export function parseRef(ref: string): { provider: string; repo: string; number: number } {
  const m = /^([a-z]+):([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`invalid source ref "${ref}"`);
  return { provider: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export const markerComment = (marker: string) => `<!-- durable:${marker} -->`;
