import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatFeedback,
  LABELS,
  markerComment,
  type PullRequestRef,
  type PullRequestState,
  type SourceTask,
  type TaskSource,
} from '@durable/agent-runner';

export interface FakePr extends PullRequestState {
  branch: string;
  feedback?: string;
}

/** In-memory tracker. PRs are JSON files the fake agent writes (one per item). */
export class FakeSource implements TaskSource {
  readonly name = 'fake';
  readonly items = new Map<string, SourceTask & { comments: string[] }>();
  prReads = 0;
  constructor(readonly prDir: string) {}

  add(repo: string, number: number, title = `Issue ${number}`, labels: string[] = [LABELS.ready]) {
    const ref = `github:${repo}#${number}`;
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

  async listReady(repos: string[]) {
    return [...this.items.values()].filter((i) => repos.includes(i.repo) && i.labels.includes(LABELS.ready));
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
    if (i.comments.some((c) => c.includes(tag))) return { posted: false };
    i.comments.push(`${body}\n\n${tag}`);
    return { posted: true };
  }
  async findPullRequests(ref: string, branch: string): Promise<PullRequestRef[]> {
    if (!existsSync(this.prFile(ref))) return [];
    const pr = this.pr(ref);
    return pr.branch === branch ? [{ url: pr.url, state: pr.state }] : [];
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
      comments: [],
      failedChecks: pr.checks.filter((c) => c.conclusion === 'FAILURE').map((c) => c.name),
      mergeStateStatus: pr.mergeStateStatus,
    });
  }
}
