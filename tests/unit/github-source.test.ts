import { describe, expect, it } from 'vitest';
import {
  classifyPullRequest,
  detectRateLimit,
  GitHubIssuesTracker,
  GitHubPrHost,
  RepoConfigSchema,
  parseRef,
  type CommandRunner,
} from '@durable/agent-runner';

function fakeGh(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: CommandRunner = async (_bin, args) => {
    calls.push(args);
    const key = Object.keys(responses).find((k) => args.join(' ').startsWith(k));
    return key
      ? typeof responses[key] === 'string'
        ? (responses[key] as string)
        : JSON.stringify(responses[key])
      : '';
  };
  return { run, calls };
}

const issue = (labels: string[]) => ({
  number: 12,
  title: 'Fix bug',
  body: 'details',
  url: 'https://github.com/acme/app/issues/12',
  labels: labels.map((name) => ({ name })),
});

const ghRepo = RepoConfigSchema.parse({ name: 'acme/app', path: '/tmp/x' });

describe('GitHubIssuesTracker', () => {
  it('lists ready issues per repo with stable refs', async () => {
    const gh = fakeGh({ 'issue list --repo acme/app': [issue(['tpm:agent:ready'])] });
    const items = await new GitHubIssuesTracker(gh.run).listReady(ghRepo);
    expect(items).toEqual([
      expect.objectContaining({
        ref: 'github:acme/app#12',
        repo: 'acme/app',
        number: 12,
        labels: ['tpm:agent:ready'],
      }),
    ]);
    expect(gh.calls[0]).toEqual(expect.arrayContaining(['--label', 'tpm:agent:ready', '--state', 'open']));
  });

  it('only sends label changes that change something', async () => {
    const gh = fakeGh({ 'issue view 12': issue(['tpm:agent:ready', 'bug']) });
    await new GitHubIssuesTracker(gh.run).updateLabels('github:acme/app#12', {
      add: ['tpm:agent:running'],
      remove: ['tpm:agent:ready', 'tpm:agent:failed'],
    });
    const edit = gh.calls.find((c) => c[1] === 'edit')!;
    expect(edit).toEqual([
      'issue',
      'edit',
      '12',
      '--repo',
      'acme/app',
      '--add-label',
      'tpm:agent:running',
      '--remove-label',
      'tpm:agent:ready',
    ]);
    const gh2 = fakeGh({ 'issue view 12': issue(['tpm:agent:running']) });
    await new GitHubIssuesTracker(gh2.run).updateLabels('github:acme/app#12', {
      add: ['tpm:agent:running'],
      remove: ['tpm:agent:ready'],
    });
    expect(gh2.calls.some((c) => c[1] === 'edit')).toBe(false);
  });

  it('does not post a comment twice (marker check)', async () => {
    const gh = fakeGh({
      'issue view 12 --repo acme/app --json comments': { comments: [{ body: 'x <!-- durable:k1 -->' }] },
    });
    const src = new GitHubIssuesTracker(gh.run);
    expect(await src.comment('github:acme/app#12', 'hello', 'k1')).toEqual({ posted: false });
    expect(await src.comment('github:acme/app#12', 'hello', 'k2')).toEqual({ posted: true });
    const post = gh.calls.find((c) => c[1] === 'comment')!;
    expect(post.at(-1)).toBe('hello\n\n<!-- durable:k2 -->');
  });

  it('finds PRs by the deterministic head branch', async () => {
    const gh = fakeGh({ 'pr list --repo acme/app --head agent/issue-12': [{ url: 'u', state: 'OPEN' }] });
    expect(await new GitHubPrHost(gh.run).findPullRequests(ghRepo, 'agent/issue-12')).toEqual([
      { url: 'u', state: 'OPEN' },
    ]);
  });

  it('parses refs and rejects garbage', () => {
    expect(parseRef('github:acme/app#12')).toEqual({ provider: 'github', repo: 'acme/app', number: 12 });
    expect(() => parseRef('acme/app#12')).toThrow();
  });
});

describe('rate limit detection', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const statusEvent = (status: string, resetsAt?: number) =>
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status,
        resetsAt,
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
      },
    });
  it('ignores status events and trusts a successful result (trial regression)', () => {
    const ok = [
      statusEvent('allowed'),
      JSON.stringify({ type: 'result', is_error: false, result: 'done' }),
    ].join('\n');
    expect(detectRateLimit(ok, now)).toEqual({ limited: false });
    expect(detectRateLimit(statusEvent('allowed'), now)).toEqual({ limited: false });
  });
  it('uses a rejected status event and its reset time', () => {
    expect(detectRateLimit(statusEvent('rejected', now / 1000 + 3600), now)).toEqual({
      limited: true,
      retryAfterMs: 3600_000,
    });
  });
  it('detects provider limits and honours a machine-readable reset time (capped)', () => {
    expect(detectRateLimit('all good', now)).toEqual({ limited: false });
    expect(detectRateLimit('Claude usage limit reached. resets at 2026-01-01T02:00:00Z', now)).toEqual({
      limited: true,
      retryAfterMs: 2 * 3600_000,
    });
    expect(detectRateLimit('rate_limit_error', now)).toEqual({ limited: true, retryAfterMs: 30 * 60_000 });
    expect(detectRateLimit('weekly limit reached, reset 2099-01-01T00:00:00Z', now)).toEqual({
      limited: true,
      retryAfterMs: 6 * 3600_000,
    });
  });
});

describe('classifyPullRequest (ported from tpm)', () => {
  const base = {
    url: 'u',
    state: 'OPEN',
    headSha: 'abc',
    isDraft: false,
    reviewDecision: null as string | null,
    mergeStateStatus: 'CLEAN',
    checks: [] as Array<{ name: string; conclusion: string | null }>,
    latestReviews: [] as Array<{ state: string; submittedAt: string }>,
    lastCommitAt: '2026-01-02T00:00:00Z',
  };
  const kind = (p: Partial<typeof base>) => classifyPullRequest({ ...base, ...p }).kind;

  it('applies the priority order', () => {
    expect(kind({ state: 'MERGED' })).toBe('merged');
    expect(kind({ state: 'CLOSED' })).toBe('abandoned');
    expect(kind({ isDraft: true, mergeStateStatus: 'DIRTY' })).toBe('no-action');
    expect(kind({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'DIRTY' })).toBe('needs-human');
    expect(kind({ mergeStateStatus: 'DIRTY' })).toBe('needs-agent');
    expect(kind({ checks: [{ name: 'ci', conclusion: 'FAILURE' }] })).toBe('needs-agent');
    expect(kind({ checks: [{ name: 'ci', conclusion: 'SUCCESS' }] })).toBe('no-action');
    expect(kind({ mergeStateStatus: 'BEHIND' })).toBe('needs-agent');
    expect(kind({})).toBe('no-action');
  });

  it('ignores review comments older than the newest commit', () => {
    expect(kind({ latestReviews: [{ state: 'COMMENTED', submittedAt: '2026-01-01T00:00:00Z' }] })).toBe(
      'no-action',
    );
    expect(kind({ latestReviews: [{ state: 'COMMENTED', submittedAt: '2026-01-03T00:00:00Z' }] })).toBe(
      'needs-agent',
    );
  });
});

describe('GitHubPrHost factory operations', () => {
  const url = 'https://github.com/acme/app/pull/7';

  it('merges through the REST API with the reviewed sha, then deletes the branch', async () => {
    const gh = fakeGh({
      [`pr view ${url} --json state,headRefName`]: { state: 'OPEN', headRefName: 'agent/issue-3' },
    });
    await new GitHubPrHost(gh.run).factory.merge(url, 'abc123');
    expect(gh.calls[1]).toEqual([
      'api',
      '-X',
      'PUT',
      'repos/acme/app/pulls/7/merge',
      '-f',
      'merge_method=squash',
      '-f',
      'sha=abc123',
    ]);
    expect(gh.calls[2]).toEqual(['api', '-X', 'DELETE', 'repos/acme/app/git/refs/heads/agent/issue-3']);
    // No local git side effects: never `gh pr merge`.
    expect(gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
  });

  it('does not merge twice', async () => {
    const gh = fakeGh({ [`pr view ${url} --json state,headRefName`]: { state: 'MERGED', headRefName: 'b' } });
    await new GitHubPrHost(gh.run).factory.merge(url, 'abc');
    expect(gh.calls.some((c) => c.includes('PUT'))).toBe(false);
  });

  it('posts and reads commit statuses on a sha', async () => {
    const gh = fakeGh({
      'api repos/acme/app/commits/abc/status': {
        statuses: [{ context: 'tpm/review-claude', state: 'success', description: 'approve: ok' }],
      },
    });
    const host = new GitHubPrHost(gh.run);
    expect(await host.factory.getStatuses(ghRepo, 'abc')).toEqual({
      'tpm/review-claude': { state: 'success', description: 'approve: ok' },
    });
    await host.factory.setStatus(ghRepo, 'abc', 'tpm/verify', 'failure', 'x'.repeat(300));
    const post = gh.calls.at(-1)!;
    expect(post.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/acme/app/statuses/abc']);
    expect(post).toContain('context=tpm/verify');
    expect(post.find((a) => a.startsWith('description='))!.length).toBe('description='.length + 140);
  });

  it('reads the policy from the default branch, and returns null when it does not exist', async () => {
    const content = Buffer.from('version: 1\n').toString('base64');
    const gh = fakeGh({ 'api repos/acme/app/contents/.tpm/agent-policy.yml?ref=main': content });
    expect(await new GitHubPrHost(gh.run).factory.readPolicy(ghRepo, '.tpm/agent-policy.yml')).toBe(
      'version: 1\n',
    );
    const missing: CommandRunner = async () => {
      throw new Error('gh: Not Found (HTTP 404)');
    };
    expect(await new GitHubPrHost(missing).factory.readPolicy(ghRepo, '.tpm/agent-policy.yml')).toBeNull();
  });
});
