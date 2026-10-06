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
  type FactoryHost,
  type Tracker,
} from './source';

const PR_URL = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i;
function parsePrUrl(url: string): { repo: string; number: number } {
  const m = PR_URL.exec(url);
  if (!m) throw new Error(`not a GitHub pull request URL: ${url}`);
  return { repo: m[1]!, number: Number(m[2]) };
}

/** `labeled` events for an issue or PR (same endpoint), oldest first. */
async function labelEvents(
  run: CommandRunner,
  bin: string,
  repo: string,
  number: number,
  label: string,
): Promise<Array<{ actor: string; at: string }>> {
  const raw = await run(bin, ['api', '--paginate', `repos/${repo}/issues/${number}/events`, '--jq', '.[]']);
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map(
      (l) =>
        JSON.parse(l) as {
          event?: string;
          label?: { name?: string };
          actor?: { login?: string };
          created_at?: string;
        },
    )
    .filter((e) => e.event === 'labeled' && e.label?.name === label)
    .map((e) => ({ actor: e.actor?.login ?? '', at: e.created_at ?? '' }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

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

  async labelActor(ref: string, label: string): Promise<string | null> {
    const { repo, number } = parseRef(ref);
    const events = await labelEvents(this.run, this.bin, repo, number, label);
    return events.at(-1)?.actor ?? null;
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
      approve: 'c5def5',
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

  readonly factory: FactoryHost = {
    readPolicy: async (repo, path) => {
      try {
        const raw = await this.gh([
          'api',
          `repos/${repo.name}/contents/${path}?ref=${encodeURIComponent(repo.defaultBranch)}`,
          '--jq',
          '.content',
        ]);
        return Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8');
      } catch (e) {
        if (/Not Found|404/.test((e as Error).message)) return null;
        throw e;
      }
    },
    getChanges: async (url) => {
      const pr = JSON.parse(await this.gh(['pr', 'view', url, '--json', 'files,additions,deletions'])) as {
        files?: Array<{ path: string }>;
        additions?: number;
        deletions?: number;
      };
      return {
        files: (pr.files ?? []).map((f) => f.path),
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
      };
    },
    getStatuses: async (repo, sha) => {
      const res = JSON.parse(await this.gh(['api', `repos/${repo.name}/commits/${sha}/status`])) as {
        statuses?: Array<{ context: string; state: string; description?: string | null }>;
      };
      // The combined status already holds the latest status per context.
      return Object.fromEntries(
        (res.statuses ?? []).map((s) => [s.context, { state: s.state, description: s.description ?? '' }]),
      );
    },
    setStatus: async (repo, sha, context, state, description) => {
      await this.gh([
        'api',
        '-X',
        'POST',
        `repos/${repo.name}/statuses/${sha}`,
        '-f',
        `state=${state}`,
        '-f',
        `context=${context}`,
        '-f',
        `description=${description.slice(0, 140)}`,
      ]);
    },
    commentOnPr: async (url, body, marker) => {
      const pr = JSON.parse(await this.gh(['pr', 'view', url, '--json', 'comments'])) as {
        comments?: Array<{ body: string }>;
      };
      if ((pr.comments ?? []).some((c) => c.body.includes(markerText(marker)))) return { posted: false };
      await this.gh(['pr', 'comment', url, '--body', `${body}\n\n${markerComment(marker)}`]);
      return { posted: true };
    },
    labelEvents: async (url, label) => {
      const { repo, number } = parsePrUrl(url);
      return labelEvents(this.run, this.bin, repo, number, label);
    },
    addPrLabel: async (url, label) => {
      await this.gh(['pr', 'edit', url, '--add-label', label]);
    },
    merge: async (url, sha) => {
      const { repo, number } = parsePrUrl(url);
      const pr = JSON.parse(await this.gh(['pr', 'view', url, '--json', 'state,headRefName'])) as {
        state: string;
        headRefName: string;
      };
      if (pr.state !== 'MERGED') {
        // REST merge (no local git side effects). `sha` makes GitHub refuse if the head moved.
        await this.gh([
          'api',
          '-X',
          'PUT',
          `repos/${repo}/pulls/${number}/merge`,
          '-f',
          'merge_method=squash',
          '-f',
          `sha=${sha}`,
        ]);
      }
      try {
        await this.gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${pr.headRefName}`]);
      } catch {
        // already deleted
      }
    },
    cloneUrl: (repo) => `https://github.com/${repo.name}.git`,
  };
}
