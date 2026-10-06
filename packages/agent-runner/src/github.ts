import { execFile } from 'node:child_process';
import {
  LABELS,
  markerComment,
  parseRef,
  type PullRequestRef,
  type SourceTask,
  type TaskSource,
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
export class GitHubIssuesSource implements TaskSource {
  readonly name = 'github';
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

  async listReady(repos: string[]): Promise<SourceTask[]> {
    const out: SourceTask[] = [];
    for (const repo of repos) {
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
    if (comments.some((c) => c.body.includes(tag))) return { posted: false };
    await this.gh(['issue', 'comment', String(number), '--repo', repo, '--body', `${body}\n\n${tag}`]);
    return { posted: true };
  }

  async findPullRequests(ref: string, branch: string): Promise<PullRequestRef[]> {
    const { repo } = parseRef(ref);
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

  /** Create the agent:* labels in a repo (idempotent). */
  async ensureLabels(repo: string): Promise<void> {
    const colors: Record<string, string> = {
      ready: '0e8a16',
      running: 'fbca04',
      review: '1d76db',
      failed: 'b60205',
    };
    for (const [k, name] of Object.entries(LABELS)) {
      await this.gh(['label', 'create', name, '--repo', repo, '--color', colors[k]!, '--force']);
    }
  }
}
