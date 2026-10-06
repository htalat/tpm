import type { AdoRepoConfig, RepoConfig } from './config';
import { execRunner, type CommandRunner } from './github';
import { FAILED_CONCLUSIONS, formatFeedback } from './pr-signal';
import {
  LABELS,
  markerText,
  parseRef,
  type PrHost,
  type PullRequestRef,
  type PullRequestState,
  type SourceTask,
  type Tracker,
} from './source';

/**
 * Azure DevOps through the `az` CLI with the azure-devops extension
 * (`az extension add --name azure-devops`, auth via `az login` or
 * AZURE_DEVOPS_EXT_PAT).
 *
 *   AzureBoardsTracker  work items; the tpm:agent:* "labels" are work item tags
 *   AdoPrHost           pull requests in Azure Repos; CI from Azure Pipelines
 */

const orgUrl = (organization: string) => `https://dev.azure.com/${encodeURIComponent(organization)}`;
const wiql = (s: string) => s.replace(/'/g, "''");

function requireAdo(repo: RepoConfig): AdoRepoConfig {
  if (!repo.ado) throw new Error(`${repo.name}: missing "ado" settings`);
  return repo.ado;
}

/** Tags are one string: "a; b; c". */
export function parseTags(raw: unknown): string[] {
  return typeof raw === 'string'
    ? raw
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
}

/** Work item descriptions are HTML; agents get plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface AdoWorkItem {
  id: number;
  fields: Record<string, unknown>;
  _links?: { html?: { href?: string } };
}

export class AzureBoardsTracker implements Tracker {
  readonly kind = 'azure-boards';
  /** ref ("ado:org/project#id") -> repo name, learned from listReady, so get() can fill SourceTask.repo. */
  private readonly repoOf = new Map<string, string>();

  constructor(
    private readonly run: CommandRunner = execRunner,
    private readonly bin = process.env.AZ_BIN ?? 'az',
  ) {}

  private async az<T>(args: string[]): Promise<T> {
    const out = await this.run(this.bin, [...args, '--output', 'json']);
    return (out.trim() ? JSON.parse(out) : null) as T;
  }

  private toTask(organization: string, item: AdoWorkItem, repoName: string): SourceTask {
    const project = String(item.fields['System.TeamProject'] ?? '');
    const ref = `ado:${organization}/${project}#${item.id}`;
    this.repoOf.set(ref, repoName);
    return {
      ref,
      repo: repoName,
      number: item.id,
      title: String(item.fields['System.Title'] ?? ''),
      body: htmlToText(String(item.fields['System.Description'] ?? '')),
      url:
        item._links?.html?.href ??
        `${orgUrl(organization)}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`,
      labels: parseTags(item.fields['System.Tags']),
    };
  }

  async listReady(repo: RepoConfig): Promise<SourceTask[]> {
    const ado = requireAdo(repo);
    const query =
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiql(ado.project)}'` +
      ` AND [System.Tags] CONTAINS '${wiql(LABELS.ready)}'` +
      ` AND [System.State] NOT IN ('Closed', 'Removed', 'Done', 'Resolved')` +
      (ado.areaPath ? ` AND [System.AreaPath] UNDER '${wiql(ado.areaPath)}'` : '') +
      ` ORDER BY [System.Id]`;
    const rows = await this.az<Array<{ id: number }>>([
      'boards',
      'query',
      '--org',
      orgUrl(ado.organization),
      '--project',
      ado.project,
      '--wiql',
      query,
    ]);
    const out: SourceTask[] = [];
    for (const r of rows ?? []) {
      const item = await this.show(ado.organization, r.id);
      // CONTAINS is a substring match ("tpm:agent:ready-ish" would match); check exactly.
      if (parseTags(item.fields['System.Tags']).includes(LABELS.ready))
        out.push(this.toTask(ado.organization, item, repo.name));
    }
    return out;
  }

  private show(organization: string, id: number): Promise<AdoWorkItem> {
    return this.az<AdoWorkItem>([
      'boards',
      'work-item',
      'show',
      '--id',
      String(id),
      '--org',
      orgUrl(organization),
    ]);
  }

  async get(ref: string): Promise<SourceTask> {
    const { repo: orgProject, number } = parseRef(ref);
    const organization = orgProject.slice(0, orgProject.indexOf('/'));
    const item = await this.show(organization, number);
    return this.toTask(organization, item, this.repoOf.get(ref) ?? orgProject);
  }

  async updateLabels(ref: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const { repo: orgProject, number } = parseRef(ref);
    const organization = orgProject.slice(0, orgProject.indexOf('/'));
    const current = parseTags((await this.show(organization, number)).fields['System.Tags']);
    const next = [
      ...new Set([...current.filter((t) => !(change.remove ?? []).includes(t)), ...(change.add ?? [])]),
    ];
    if (next.length === current.length && next.every((t) => current.includes(t))) return;
    // Tags are one field: this replaces the whole set (a concurrent human edit
    // between our read and write can be lost; rare, and the next step re-reads).
    await this.az([
      'boards',
      'work-item',
      'update',
      '--id',
      String(number),
      '--org',
      orgUrl(organization),
      '--fields',
      `System.Tags=${next.join('; ')}`,
    ]);
  }

  async comment(ref: string, body: string, marker: string): Promise<{ posted: boolean }> {
    const { repo: orgProject, number } = parseRef(ref);
    const slash = orgProject.indexOf('/');
    const organization = orgProject.slice(0, slash);
    const project = orgProject.slice(slash + 1);
    // Read existing comments first; if this fails we do NOT post (the step retries):
    // posting blind could duplicate the comment.
    const existing = await this.az<{ comments?: Array<{ text?: string }> }>([
      'devops',
      'invoke',
      '--org',
      orgUrl(organization),
      '--area',
      'wit',
      '--resource',
      'comments',
      '--route-parameters',
      `project=${project}`,
      `workItemId=${number}`,
      '--api-version',
      '7.1-preview.4',
    ]);
    if ((existing?.comments ?? []).some((c) => (c.text ?? '').includes(markerText(marker))))
      return { posted: false };
    // ADO sanitizes HTML comments away, so the marker is a small visible line.
    const html = `${escapeHtml(body).replace(/\n/g, '<br>')}<br><small>${markerText(marker)}</small>`;
    await this.az([
      'boards',
      'work-item',
      'update',
      '--id',
      String(number),
      '--org',
      orgUrl(organization),
      '--discussion',
      html,
    ]);
    return { posted: true };
  }
}

const ADO_PR_URL = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i;

export function adoPrUrl(organization: string, project: string, repository: string, id: number): string {
  return `${orgUrl(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`;
}

export function parseAdoPrUrl(url: string): {
  organization: string;
  project: string;
  repository: string;
  id: number;
} {
  const m = ADO_PR_URL.exec(url);
  if (!m) throw new Error(`not an Azure DevOps pull request URL: ${url}`);
  return {
    organization: decodeURIComponent(m[1]!),
    project: decodeURIComponent(m[2]!),
    repository: decodeURIComponent(m[3]!),
    id: Number(m[4]),
  };
}

export interface AdoPrJson {
  pullRequestId: number;
  status?: string; // active | completed | abandoned
  mergeStatus?: string; // succeeded | conflicts | queued | rejectedByPolicy | failure | notSet
  isDraft?: boolean;
  reviewers?: Array<{ vote?: number; displayName?: string }>;
  lastMergeSourceCommit?: { commitId?: string };
  sourceRefName?: string;
  creationDate?: string;
  closedDate?: string;
}

/**
 * ADO PR -> the shared PullRequestState (ported from tpm's ADO adapter):
 * completed -> MERGED, abandoned -> CLOSED; mergeStatus conflicts -> DIRTY;
 * any reviewer vote <= -5 ("waiting for author" / "rejected") -> CHANGES_REQUESTED;
 * the newest pipeline run on the source branch -> the CI check.
 */
export function mapAdoPr(
  url: string,
  pr: AdoPrJson,
  runs: Array<{ result?: string; status?: string; definition?: { name?: string } }>,
): PullRequestState {
  const status = (pr.status ?? '').toLowerCase();
  const latest = runs[0];
  const ciConclusion =
    latest && (latest.status ?? '').toLowerCase() === 'completed'
      ? latest.result === 'failed' || latest.result === 'canceled'
        ? 'FAILURE'
        : 'SUCCESS'
      : null;
  return {
    url,
    state: status === 'completed' ? 'MERGED' : status === 'abandoned' ? 'CLOSED' : 'OPEN',
    headSha: pr.lastMergeSourceCommit?.commitId ?? '',
    isDraft: !!pr.isDraft,
    reviewDecision: (pr.reviewers ?? []).some((r) => (r.vote ?? 0) <= -5) ? 'CHANGES_REQUESTED' : null,
    mergeStateStatus: (pr.mergeStatus ?? '').toLowerCase() === 'conflicts' ? 'DIRTY' : 'CLEAN',
    checks: ciConclusion ? [{ name: latest?.definition?.name ?? 'pipeline', conclusion: ciConclusion }] : [],
    latestReviews: [],
    lastCommitAt: null,
  };
}

export class AdoPrHost implements PrHost {
  readonly kind = 'ado';
  constructor(
    private readonly run: CommandRunner = execRunner,
    private readonly bin = process.env.AZ_BIN ?? 'az',
  ) {}

  private async az<T>(args: string[]): Promise<T> {
    const out = await this.run(this.bin, [...args, '--output', 'json']);
    return (out.trim() ? JSON.parse(out) : null) as T;
  }

  async findPullRequests(repo: RepoConfig, branch: string): Promise<PullRequestRef[]> {
    const ado = requireAdo(repo);
    const prs = await this.az<AdoPrJson[]>([
      'repos',
      'pr',
      'list',
      '--org',
      orgUrl(ado.organization),
      '--project',
      ado.project,
      '--repository',
      ado.repository,
      '--source-branch',
      branch,
      '--status',
      'all',
    ]);
    return (prs ?? []).map((p) => ({
      url: adoPrUrl(ado.organization, ado.project, ado.repository, p.pullRequestId),
      state: (p.status ?? '').toUpperCase(),
    }));
  }

  async getPullRequest(url: string): Promise<PullRequestState> {
    const { organization, project, id } = parseAdoPrUrl(url);
    const pr = await this.az<AdoPrJson>([
      'repos',
      'pr',
      'show',
      '--id',
      String(id),
      '--org',
      orgUrl(organization),
    ]);
    let runs: Array<{ result?: string; status?: string; definition?: { name?: string } }> = [];
    if (pr.sourceRefName) {
      try {
        runs =
          (await this.az<typeof runs>([
            'pipelines',
            'runs',
            'list',
            '--org',
            orgUrl(organization),
            '--project',
            project,
            '--branch',
            pr.sourceRefName,
            '--top',
            '1',
          ])) ?? [];
      } catch {
        // No pipelines (or no permission): no CI signal rather than no PR state.
      }
    }
    return mapAdoPr(url, pr, runs);
  }

  async getFeedback(url: string): Promise<string> {
    const { organization, project, repository, id } = parseAdoPrUrl(url);
    const state = await this.getPullRequest(url);
    let threads: Array<{
      isDeleted?: boolean;
      status?: string;
      comments?: Array<{ author?: { displayName?: string }; content?: string; commentType?: string }>;
    }> = [];
    try {
      const res = await this.az<{ value?: typeof threads }>([
        'devops',
        'invoke',
        '--org',
        orgUrl(organization),
        '--area',
        'git',
        '--resource',
        'pullRequestThreads',
        '--route-parameters',
        `project=${project}`,
        `repositoryId=${repository}`,
        `pullRequestId=${id}`,
        '--api-version',
        '7.1',
      ]);
      threads = res?.value ?? [];
    } catch {
      // Feedback is best effort: the agent still gets the CI / conflict state.
    }
    const comments = threads
      .filter((t) => !t.isDeleted && (t.status ?? 'active') !== 'closed')
      .flatMap((t) => t.comments ?? [])
      .filter((c) => (c.commentType ?? 'text') === 'text' && c.content)
      .map((c) => ({ author: c.author?.displayName ?? '?', body: c.content! }));
    return formatFeedback({
      reviews: [],
      comments,
      failedChecks: state.checks
        .filter((c) => FAILED_CONCLUSIONS.has((c.conclusion ?? '').toUpperCase()))
        .map((c) => c.name),
      mergeStateStatus: state.mergeStateStatus,
    });
  }
}
