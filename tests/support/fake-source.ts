import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LABELS,
  markerComment,
  type PullRequestRef,
  type SourceTask,
  type TaskSource,
} from '@durable/agent-runner';

/** In-memory tracker. PRs come from files the fake agent writes. */
export class FakeSource implements TaskSource {
  readonly name = 'fake';
  readonly items = new Map<string, SourceTask & { comments: string[] }>();
  writes = 0;
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
  async listReady(repos: string[]) {
    return [...this.items.values()].filter((i) => repos.includes(i.repo) && i.labels.includes(LABELS.ready));
  }
  async get(ref: string) {
    return { ...this.item(ref), labels: [...this.item(ref).labels] };
  }
  async updateLabels(ref: string, change: { add?: string[]; remove?: string[] }) {
    const i = this.item(ref);
    this.writes++;
    i.labels = [
      ...new Set([...i.labels.filter((l) => !(change.remove ?? []).includes(l)), ...(change.add ?? [])]),
    ];
  }
  async comment(ref: string, body: string, marker: string) {
    const i = this.item(ref);
    const tag = markerComment(marker);
    if (i.comments.some((c) => c.includes(tag))) return { posted: false };
    this.writes++;
    i.comments.push(`${body}\n\n${tag}`);
    return { posted: true };
  }
  async findPullRequests(ref: string, branch: string): Promise<PullRequestRef[]> {
    const f = join(this.prDir, `${ref.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
    if (!existsSync(f)) return [];
    const pr = JSON.parse(readFileSync(f, 'utf8')) as PullRequestRef & { branch: string };
    return pr.branch === branch ? [{ url: pr.url, state: pr.state }] : [];
  }
}
