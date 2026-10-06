import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatFeedback,
  LABELS,
  markerComment,
  markerText,
  type FactoryHost,
  type PullRequestRef,
  type RepoConfig,
  type PullRequestState,
  type SourceTask,
  type TaskSource,
} from '@durable/agent-runner';

export interface FakePr extends PullRequestState {
  branch: string;
  feedback?: string;
  files?: string[];
  additions?: number;
}

/** In-memory tracker. PRs are JSON files the fake agent writes (one per item). */
export class FakeSource implements TaskSource {
  readonly name = 'fake';
  readonly kind = 'fake';
  readonly items = new Map<string, SourceTask & { comments: string[] }>();
  prReads = 0;
  // ---- software factory side ----
  policyText: string | null = null;
  readonly statuses = new Map<string, Record<string, { state: string; description: string }>>();
  readonly prComments: Array<{ url: string; body: string }> = [];
  readonly approvalEvents: Array<{ actor: string; at: string }> = [];
  readonly merges: Array<{ url: string; sha: string }> = [];
  /** Who added the ready label (for the starters check). */
  readyLabelActor: string | null = 'htalat';

  readonly factory: FactoryHost = {
    readPolicy: async () => this.policyText,
    getChanges: async (url) => {
      const pr = await this.getPullRequest(url);
      return { files: pr.files ?? [], additions: pr.additions ?? 0, deletions: 0 };
    },
    getStatuses: async (_repo, sha) => ({ ...(this.statuses.get(sha) ?? {}) }),
    setStatus: async (_repo, sha, context, state, description) => {
      this.statuses.set(sha, { ...(this.statuses.get(sha) ?? {}), [context]: { state, description } });
    },
    commentOnPr: async (url, body, marker) => {
      if (this.prComments.some((c) => c.url === url && c.body.includes(markerText(marker))))
        return { posted: false };
      this.prComments.push({ url, body: `${body}\n\n${markerComment(marker)}` });
      return { posted: true };
    },
    labelEvents: async () => [...this.approvalEvents],
    addPrLabel: async (_url, label) => {
      if (label === LABELS.approve)
        this.approvalEvents.push({ actor: 'htalat', at: new Date(Date.now() + 1000).toISOString() });
    },
    merge: async (url, sha) => {
      const pr = await this.getPullRequest(url);
      if (pr.state === 'MERGED') return;
      // Like GitHub's `sha` merge parameter: refuse if the head moved.
      if (pr.headSha !== sha)
        throw new Error(`Head branch was modified (head ${pr.headSha}, expected ${sha})`);
      this.merges.push({ url, sha });
      for (const f of readdirSync(this.prDir)) {
        const p = JSON.parse(readFileSync(join(this.prDir, f), 'utf8')) as FakePr;
        if (p.url === url) writeFileSync(join(this.prDir, f), JSON.stringify({ ...p, state: 'MERGED' }));
      }
    },
    cloneUrl: () => '',
  };

  async labelActor(): Promise<string | null> {
    return this.readyLabelActor;
  }

  /** Make the next N findPullRequests calls fail (tracker outage). */
  failFinds = 0;
  constructor(readonly prDir: string) {}

  add(
    repo: string,
    number: number,
    title = `Issue ${number}`,
    labels: string[] = [LABELS.ready],
    ref = `github:${repo}#${number}`,
  ) {
    this.items.set(ref, {
      ref,
      repo,
      number,
      title,
      body: 'Please fix it.',
      url: `https://github.example/${repo}/issues/${number}`,
      labels,
      comments: [],
    });
    return ref;
  }
  item(ref: string) {
    const i = this.items.get(ref);
    if (!i) throw new Error(`no item ${ref}`);
    return i;
  }
  prFile(ref: string) {
    return join(this.prDir, `${ref.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
  }
  pr(ref: string): FakePr {
    return JSON.parse(readFileSync(this.prFile(ref), 'utf8')) as FakePr;
  }
  /** Simulate GitHub-side changes (review, CI, merge). */
  patchPr(ref: string, patch: Partial<FakePr>) {
    writeFileSync(this.prFile(ref), JSON.stringify({ ...this.pr(ref), ...patch }));
  }

  async listReady(repo: RepoConfig) {
    return [...this.items.values()].filter((i) => i.repo === repo.name && i.labels.includes(LABELS.ready));
  }
  async get(ref: string) {
    return { ...this.item(ref), labels: [...this.item(ref).labels] };
  }
  async updateLabels(ref: string, change: { add?: string[]; remove?: string[] }) {
    const i = this.item(ref);
    i.labels = [
      ...new Set([...i.labels.filter((l) => !(change.remove ?? []).includes(l)), ...(change.add ?? [])]),
    ];
  }
  async comment(ref: string, body: string, marker: string) {
    const i = this.item(ref);
    const tag = markerComment(marker);
    if (i.comments.some((c) => c.includes(markerText(marker)))) return { posted: false };
    i.comments.push(`${body}\n\n${tag}`);
    return { posted: true };
  }
  /** As a TaskSource it gets the item ref; as a PrHost (via the resolver) it gets the repo config. */
  async findPullRequests(refOrRepo: string | RepoConfig, branch: string): Promise<PullRequestRef[]> {
    if (this.failFinds > 0) {
      this.failFinds--;
      throw new Error('tracker unavailable');
    }
    const files =
      typeof refOrRepo === 'string'
        ? [this.prFile(refOrRepo)]
        : (existsSync(this.prDir) ? readdirSync(this.prDir) : []).map((f) => join(this.prDir, f));
    return files
      .filter((f) => existsSync(f))
      .map((f) => JSON.parse(readFileSync(f, 'utf8')) as FakePr)
      .filter((pr) => pr.branch === branch)
      .map((pr) => ({ url: pr.url, state: pr.state }));
  }
  async getPullRequest(url: string): Promise<FakePr> {
    this.prReads++;
    for (const f of existsSync(this.prDir) ? readdirSync(this.prDir) : []) {
      const pr = JSON.parse(readFileSync(join(this.prDir, f), 'utf8')) as FakePr;
      if (pr.url === url) return pr;
    }
    throw new Error(`no PR ${url}`);
  }
  async getFeedback(url: string): Promise<string> {
    const pr = (await this.getPullRequest(url)) as FakePr;
    return formatFeedback({
      reviews: pr.feedback ? [{ author: 'reviewer', state: 'COMMENTED', body: pr.feedback }] : [],
      comments: this.prComments.filter((c) => c.url === url).map((c) => ({ author: 'bot', body: c.body })),
      failedChecks: pr.checks.filter((c) => c.conclusion === 'FAILURE').map((c) => c.name),
      mergeStateStatus: pr.mergeStateStatus,
    });
  }
}
