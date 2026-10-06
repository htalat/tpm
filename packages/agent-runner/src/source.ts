import type { RepoConfig } from './config';
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

/** Where items come from: list opted-in work, read it, move its labels/tags, comment. */
export interface Tracker {
  readonly kind: string;
  listReady(repo: RepoConfig): Promise<SourceTask[]>;
  get(ref: string): Promise<SourceTask>;
  updateLabels(ref: string, change: { add?: string[]; remove?: string[] }): Promise<void>;
  /** Post `body` unless a comment containing the marker already exists. */
  comment(ref: string, body: string, marker: string): Promise<{ posted: boolean }>;
  /** Create the tpm:agent:* labels if the tracker needs them created (idempotent). */
  ensureLabels?(repo: RepoConfig): Promise<void>;
}

/** Where pull requests live. */
export interface PrHost {
  readonly kind: string;
  /** PRs from `branch` in the repo (any state). */
  findPullRequests(repo: RepoConfig, branch: string): Promise<PullRequestRef[]>;
  getPullRequest(url: string): Promise<PullRequestState>;
  /** Human-readable review feedback (reviews, comments, failed checks) for the next round's prompt. */
  getFeedback(url: string): Promise<string>;
}

/**
 * The view the handlers use for ONE repo: its tracker plus its PR host.
 * Every write is an external side effect done by a worker step, so each one
 * is idempotent: label/tag edits converge, and comments carry a marker that
 * `comment()` checks before posting.
 */
export interface TaskSource {
  readonly name: string;
  listReady(repo: RepoConfig): Promise<SourceTask[]>;
  get(ref: string): Promise<SourceTask>;
  updateLabels(ref: string, change: { add?: string[]; remove?: string[] }): Promise<void>;
  comment(ref: string, body: string, marker: string): Promise<{ posted: boolean }>;
  findPullRequests(ref: string, branch: string): Promise<PullRequestRef[]>;
  getPullRequest(url: string): Promise<PullRequestState>;
  getFeedback(url: string): Promise<string>;
}

/** Picks the TaskSource for a repo (tests inject a fake). */
export type SourceResolver = (repo: RepoConfig) => TaskSource;

export function combineSource(tracker: Tracker, host: PrHost, repo: RepoConfig): TaskSource {
  return {
    name: `${tracker.kind}+${host.kind}`,
    listReady: (r) => tracker.listReady(r),
    get: (ref) => tracker.get(ref),
    updateLabels: (ref, change) => tracker.updateLabels(ref, change),
    comment: (ref, body, marker) => tracker.comment(ref, body, marker),
    findPullRequests: (_ref, branch) => host.findPullRequests(repo, branch),
    getPullRequest: (url) => host.getPullRequest(url),
    getFeedback: (url) => host.getFeedback(url),
  };
}

export function createSourceResolver(registry: {
  trackers: Record<string, Tracker>;
  hosts: Record<string, PrHost>;
}): SourceResolver {
  return (repo) => {
    const tracker = registry.trackers[repo.tracker];
    const host = registry.hosts[repo.host];
    if (!tracker) throw new Error(`no tracker "${repo.tracker}" for ${repo.name}`);
    if (!host) throw new Error(`no PR host "${repo.host}" for ${repo.name}`);
    return combineSource(tracker, host, repo);
  };
}

export const LABELS = {
  ready: 'tpm:agent:ready',
  running: 'tpm:agent:running',
  review: 'tpm:agent:review',
  failed: 'tpm:agent:failed',
  done: 'tpm:agent:done',
} as const;

/** Deterministic branch name: lets a retry find the work of a crashed attempt. */
export const branchFor = (task: Pick<SourceTask, 'number'>): string => `agent/issue-${task.number}`;

/** "github:owner/repo#12" or "ado:org/Project Name#123" (ADO project names may contain spaces). */
export function parseRef(ref: string): { provider: string; repo: string; number: number } {
  const m = /^([a-z-]+):([^#\/]+\/[^#]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`invalid source ref "${ref}"`);
  return { provider: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export const markerComment = (marker: string) => `<!-- durable:${marker} -->`;
/** Every tracker's marker contains this text, so detection is the same everywhere. */
export const markerText = (marker: string) => `durable:${marker}`;
