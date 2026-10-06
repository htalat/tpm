import { execFile } from 'node:child_process';
import { FAILED_CONCLUSIONS, formatFeedback } from './pr-signal';
import type { RepoConfig } from './config';
import {
  LABELS,
  markerComment,
  markerText,
  parseRef,
  type PrHost,
  type PullRequestRef,
  type PullRequestState,
  type SourceTask,
  type Tracker,
} from './source';

/** Runs a command and returns stdout. Injected so tests never call the real `gh`. */
export type CommandRunner = (bin: string, args: string[]) => Promise<string>;

export const execRunner: CommandRunner = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.slice(0, 3).join(' ')} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });

interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string }>;
}

/** GitHub Issues through the `gh` CLI (auth comes from `gh auth login`). */
export class GitHubIssuesTracker implements Tracker {
  readonly kind = 'github';
  constructor(
    private readonly run: CommandRunner = execRunner,
    private readonly bin = process.env.GH_BIN ?? 'gh',
  ) {}

  private gh(args: string[]) {
    return this.run(this.bin, args);
  }

  private toTask(repo: string, i: GhIssue): SourceTask {
    return {
      ref: `github:${repo}#${i.number}`,
      repo,
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      url: i.url,
      labels: (i.labels ?? []).map((l) => l.name),
    };
  }

  async listReady(repoCfg: RepoConfig): Promise<SourceTask[]> {
    const out: SourceTask[] = [];
    {
      const repo = repoCfg.name;
      const raw = await this.gh([
        'issue',
        'list',
        '--repo',
        repo,
        '--label',
        LABELS.ready,
        '--state',
        'open',
        '--json',
        'number,title,body,url,labels',
        '--limit',
        '100',
      ]);
      for (const i of JSON.parse(raw) as GhIssue[]) out.push(this.toTask(repo, i));
    }
    return out;
  }

  async get(ref: string): Promise<SourceTask> {
    const { repo, number } = parseRef(ref);
    const raw = await this.gh([
      'issue',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'number,title,body,url,labels',
    ]);
    return this.toTask(repo, JSON.parse(raw) as GhIssue);
  }

  async updateLabels(ref: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const { repo, number } = parseRef(ref);
    const current = new Set((await this.get(ref)).labels);
    // Only send what changes: `gh` fails when removing a label that is not set.
    const add = (change.add ?? []).filter((l) => !current.has(l));
    const remove = (change.remove ?? []).filter((l) => current.has(l));
    if (!add.length && !remove.length) return;
    await this.gh([
      'issue',
      'edit',
      String(number),
      '--repo',
      repo,
      ...add.flatMap((l) => ['--add-label', l]),
      ...remove.flatMap((l) => ['--remove-label', l]),
    ]);
  }

  async comment(ref: string, body: string, marker: string): Promise<{ posted: boolean }> {
    const { repo, number } = parseRef(ref);
    const tag = markerComment(marker);
    const raw = await this.gh(['issue', 'view', String(number), '--repo', repo, '--json', 'comments']);
    const comments = (JSON.parse(raw) as { comments: Array<{ body: string }> }).comments ?? [];
    if (comments.some((c) => c.body.includes(markerText(marker)))) return { posted: false };
    await this.gh(['issue', 'comment', String(number), '--repo', repo, '--body', `${body}\n\n${tag}`]);
    return { posted: true };
  }

  /** Create the tpm:agent:* labels in a repo (idempotent). */
  async ensureLabels(repoCfg: RepoConfig): Promise<void> {
    const repo = repoCfg.name;
    const colors: Record<string, string> = {
      ready: '0e8a16',
      running: 'fbca04',
      review: '1d76db',
      failed: 'b60205',
      done: '5319e7',
    };
    for (const [k, name] of Object.entries(LABELS)) {
      await this.gh(['label', 'create', name, '--repo', repo, '--color', colors[k]!, '--force']);
    }
  }
}

/** Pull requests on GitHub through the `gh` CLI. */
export class GitHubPrHost implements PrHost {
  readonly kind = 'github';
  constructor(
    private readonly run: CommandRunner = execRunner,
    private readonly bin = process.env.GH_BIN ?? 'gh',
  ) {}

  private gh(args: string[]) {
    return this.run(this.bin, args);
  }

  async findPullRequests(repoCfg: RepoConfig, branch: string): Promise<PullRequestRef[]> {
    const repo = repoCfg.name;
    const raw = await this.gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'url,state',
    ]);
    return JSON.parse(raw) as PullRequestRef[];
  }

  async getPullRequest(url: string): Promise<PullRequestState> {
    const raw = await this.gh([
      'pr',
      'view',
      url,
      '--json',
      'url,state,isDraft,headRefOid,reviewDecision,mergeStateStatus,statusCheckRollup,latestReviews,commits',
    ]);
    const pr = JSON.parse(raw) as {
      url: string;
      state: string;
      isDraft?: boolean;
      headRefOid: string;
      reviewDecision?: string | null;
      mergeStateStatus?: string;
      statusCheckRollup?: Array<{
        name?: string;
        context?: string;
        conclusion?: string | null;
        state?: string | null;
      }>;
      latestReviews?: Array<{ state?: string; submittedAt?: string }>;
      commits?: Array<{ committedDate?: string }>;
    };
    const dates = (pr.commits ?? [])
      .map((c) => c.committedDate ?? '')
      .filter(Boolean)
      .sort();
    return {
      url: pr.url,
      state: (pr.state ?? '').toUpperCase(),
      headSha: pr.headRefOid,
      isDraft: !!pr.isDraft,
      reviewDecision: pr.reviewDecision ?? null,
      mergeStateStatus: (pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase(),
      // CheckRun entries have `conclusion`; StatusContext entries have `state`.
      checks: (pr.statusCheckRollup ?? []).map((c) => ({
        name: c.name ?? c.context ?? '?',
        conclusion: c.conclusion ?? c.state ?? null,
      })),
      latestReviews: (pr.latestReviews ?? []).map((r) => ({
        state: r.state ?? '',
        submittedAt: r.submittedAt ?? '',
      })),
      lastCommitAt: dates.at(-1) ?? null,
    };
  }

  async getFeedback(url: string): Promise<string> {
    const raw = await this.gh([
      'pr',
      'view',
      url,
      '--json',
      'title,state,reviews,comments,statusCheckRollup,mergeStateStatus',
    ]);
    const pr = JSON.parse(raw) as {
      reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
      comments?: Array<{ author?: { login?: string }; body?: string }>;
      statusCheckRollup?: Array<{
        name?: string;
        context?: string;
        conclusion?: string | null;
        state?: string | null;
      }>;
      mergeStateStatus?: string;
    };
    return formatFeedback({
      reviews: (pr.reviews ?? []).map((r) => ({
        author: r.author?.login ?? '?',
        state: r.state ?? '',
        body: r.body ?? '',
      })),
      comments: (pr.comments ?? []).map((c) => ({ author: c.author?.login ?? '?', body: c.body ?? '' })),
      failedChecks: (pr.statusCheckRollup ?? [])
        .filter((c) => FAILED_CONCLUSIONS.has((c.conclusion ?? c.state ?? '').toUpperCase()))
        .map((c) => c.name ?? c.context ?? '?'),
      mergeStateStatus: (pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase(),
    });
  }
}
