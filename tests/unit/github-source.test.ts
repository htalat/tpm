import { describe, expect, it } from 'vitest';
import { detectRateLimit, GitHubIssuesSource, parseRef, type CommandRunner } from '@durable/agent-runner';

function fakeGh(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: CommandRunner = async (_bin, args) => {
    calls.push(args);
    const key = Object.keys(responses).find((k) => args.join(' ').startsWith(k));
    return key ? JSON.stringify(responses[key]) : '';
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

describe('GitHubIssuesSource', () => {
  it('lists ready issues per repo with stable refs', async () => {
    const gh = fakeGh({ 'issue list --repo acme/app': [issue(['agent:ready'])] });
    const items = await new GitHubIssuesSource(gh.run).listReady(['acme/app']);
    expect(items).toEqual([
      expect.objectContaining({
        ref: 'github:acme/app#12',
        repo: 'acme/app',
        number: 12,
        labels: ['agent:ready'],
      }),
    ]);
    expect(gh.calls[0]).toEqual(expect.arrayContaining(['--label', 'agent:ready', '--state', 'open']));
  });

  it('only sends label changes that change something', async () => {
    const gh = fakeGh({ 'issue view 12': issue(['agent:ready', 'bug']) });
    await new GitHubIssuesSource(gh.run).updateLabels('github:acme/app#12', {
      add: ['agent:running'],
      remove: ['agent:ready', 'agent:failed'],
    });
    const edit = gh.calls.find((c) => c[1] === 'edit')!;
    expect(edit).toEqual([
      'issue',
      'edit',
      '12',
      '--repo',
      'acme/app',
      '--add-label',
      'agent:running',
      '--remove-label',
      'agent:ready',
    ]);
    const gh2 = fakeGh({ 'issue view 12': issue(['agent:running']) });
    await new GitHubIssuesSource(gh2.run).updateLabels('github:acme/app#12', {
      add: ['agent:running'],
      remove: ['agent:ready'],
    });
    expect(gh2.calls.some((c) => c[1] === 'edit')).toBe(false);
  });

  it('does not post a comment twice (marker check)', async () => {
    const gh = fakeGh({
      'issue view 12 --repo acme/app --json comments': { comments: [{ body: 'x <!-- durable:k1 -->' }] },
    });
    const src = new GitHubIssuesSource(gh.run);
    expect(await src.comment('github:acme/app#12', 'hello', 'k1')).toEqual({ posted: false });
    expect(await src.comment('github:acme/app#12', 'hello', 'k2')).toEqual({ posted: true });
    const post = gh.calls.find((c) => c[1] === 'comment')!;
    expect(post.at(-1)).toBe('hello\n\n<!-- durable:k2 -->');
  });

  it('finds PRs by the deterministic head branch', async () => {
    const gh = fakeGh({ 'pr list --repo acme/app --head agent/issue-12': [{ url: 'u', state: 'OPEN' }] });
    expect(
      await new GitHubIssuesSource(gh.run).findPullRequests('github:acme/app#12', 'agent/issue-12'),
    ).toEqual([{ url: 'u', state: 'OPEN' }]);
  });

  it('parses refs and rejects garbage', () => {
    expect(parseRef('github:acme/app#12')).toEqual({ provider: 'github', repo: 'acme/app', number: 12 });
    expect(() => parseRef('acme/app#12')).toThrow();
  });
});

describe('rate limit detection', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
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
