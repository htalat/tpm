import { describe, expect, it } from 'vitest';
import {
  AdoPrHost,
  AgentRunnerConfigSchema,
  AzureBoardsTracker,
  buildPrompt,
  classifyPullRequest,
  createSourceResolver,
  htmlToText,
  mapAdoPr,
  parseAdoPrUrl,
  parseRef,
  RepoConfigSchema,
  type CommandRunner,
} from '@durable/agent-runner';

/** Fake `az`: answers by argument prefix and records every call. */
function fakeAz(responses: Array<[string, unknown]>) {
  const calls: string[][] = [];
  const run: CommandRunner = async (_bin, args) => {
    calls.push(args);
    const joined = args.join(' ');
    const hit = responses.find(([prefix]) => joined.startsWith(prefix));
    return hit ? JSON.stringify(hit[1]) : '';
  };
  return { run, calls };
}

const repo = RepoConfigSchema.parse({
  name: 'contoso/Web Project/website',
  path: '/tmp/website',
  tracker: 'azure-boards',
  host: 'ado',
  ado: {
    organization: 'contoso',
    project: 'Web Project',
    repository: 'website',
    areaPath: "Web Project\\Bob's Team",
  },
});

const workItem = (id: number, tags: string) => ({
  id,
  fields: {
    'System.TeamProject': 'Web Project',
    'System.Title': `Item ${id}`,
    'System.Description': '<div>Fix the <b>footer</b>.</div><ul><li>keep &amp; test</li></ul>',
    'System.Tags': tags,
  },
  _links: { html: { href: `https://dev.azure.com/contoso/Web%20Project/_workitems/edit/${id}` } },
});

describe('AzureBoardsTracker', () => {
  it('lists work items tagged tpm:agent:ready, scoped by project and area path, exact tag match', async () => {
    const az = fakeAz([
      ['boards query', [{ id: 7 }, { id: 8 }]],
      ['boards work-item show --id 7', workItem(7, 'bug; tpm:agent:ready')],
      ['boards work-item show --id 8', workItem(8, 'tpm:agent:ready-later')], // CONTAINS matched a longer tag
    ]);
    const items = await new AzureBoardsTracker(az.run).listReady(repo);
    expect(items).toEqual([
      {
        ref: 'ado:contoso/Web Project#7',
        repo: 'contoso/Web Project/website',
        number: 7,
        title: 'Item 7',
        body: 'Fix the footer.\n- keep & test',
        url: 'https://dev.azure.com/contoso/Web%20Project/_workitems/edit/7',
        labels: ['bug', 'tpm:agent:ready'],
      },
    ]);
    const q = az.calls[0]!;
    const wiql = q[q.indexOf('--wiql') + 1]!;
    expect(wiql).toContain("[System.TeamProject] = 'Web Project'");
    expect(wiql).toContain("[System.Tags] CONTAINS 'tpm:agent:ready'");
    expect(wiql).toContain("[System.AreaPath] UNDER 'Web Project\\Bob''s Team'"); // quote escaped
    expect(q).toEqual(
      expect.arrayContaining(['--org', 'https://dev.azure.com/contoso', '--project', 'Web Project']),
    );
  });

  it('rewrites the tag set only when it changes', async () => {
    const az = fakeAz([['boards work-item show --id 7', workItem(7, 'bug; tpm:agent:ready')]]);
    const t = new AzureBoardsTracker(az.run);
    await t.updateLabels('ado:contoso/Web Project#7', {
      add: ['tpm:agent:running'],
      remove: ['tpm:agent:ready'],
    });
    const update = az.calls.find((c) => c[2] === 'update')!;
    expect(update).toEqual(expect.arrayContaining(['--fields', 'System.Tags=bug; tpm:agent:running']));
    const az2 = fakeAz([['boards work-item show --id 7', workItem(7, 'tpm:agent:running')]]);
    await new AzureBoardsTracker(az2.run).updateLabels('ado:contoso/Web Project#7', {
      add: ['tpm:agent:running'],
    });
    expect(az2.calls.some((c) => c[2] === 'update')).toBe(false);
  });

  it('posts a discussion comment once (visible marker, HTML escaped)', async () => {
    const az = fakeAz([['devops invoke', { comments: [{ text: 'old <small>durable:k1</small>' }] }]]);
    const t = new AzureBoardsTracker(az.run);
    expect(await t.comment('ado:contoso/Web Project#7', 'hi', 'k1')).toEqual({ posted: false });
    expect(await t.comment('ado:contoso/Web Project#7', 'a < b\nnext', 'k2')).toEqual({ posted: true });
    const post = az.calls.find((c) => c.includes('--discussion'))!;
    expect(post[post.indexOf('--discussion') + 1]).toBe('a &lt; b<br>next<br><small>durable:k2</small>');
    const invoke = az.calls.find((c) => c[1] === 'invoke')!;
    expect(invoke).toEqual(expect.arrayContaining(['project=Web Project', 'workItemId=7']));
  });

  it('does not post when it cannot read existing comments', async () => {
    const run: CommandRunner = async (_b, args) => {
      if (args[1] === 'invoke') throw new Error('az: not authorized');
      return '';
    };
    await expect(new AzureBoardsTracker(run).comment('ado:contoso/Web Project#7', 'x', 'k')).rejects.toThrow(
      /not authorized/,
    );
  });
});

describe('AdoPrHost', () => {
  const url = 'https://dev.azure.com/contoso/Web%20Project/_git/website/pullrequest/42';

  it('finds PRs from the agent branch and builds web URLs', async () => {
    const az = fakeAz([['repos pr list', [{ pullRequestId: 42, status: 'active' }]]]);
    expect(await new AdoPrHost(az.run).findPullRequests(repo, 'agent/issue-7')).toEqual([
      { url, state: 'ACTIVE' },
    ]);
    expect(az.calls[0]).toEqual(
      expect.arrayContaining([
        '--repository',
        'website',
        '--source-branch',
        'agent/issue-7',
        '--status',
        'all',
      ]),
    );
    expect(parseAdoPrUrl(url)).toEqual({
      organization: 'contoso',
      project: 'Web Project',
      repository: 'website',
      id: 42,
    });
  });

  it('maps ADO PR state, votes, merge status and the latest pipeline run (ported from tpm)', async () => {
    const pr = {
      pullRequestId: 42,
      status: 'active',
      mergeStatus: 'succeeded',
      lastMergeSourceCommit: { commitId: 'abc' },
      sourceRefName: 'refs/heads/agent/issue-7',
    };
    const kind = (p: object, runs: object[] = []) =>
      classifyPullRequest(mapAdoPr(url, { ...pr, ...p }, runs)).kind;
    expect(kind({ status: 'completed' })).toBe('merged');
    expect(kind({ status: 'abandoned' })).toBe('abandoned');
    expect(kind({ isDraft: true, mergeStatus: 'conflicts' })).toBe('no-action');
    expect(kind({ reviewers: [{ vote: -5 }] })).toBe('needs-human');
    expect(kind({ reviewers: [{ vote: 10 }] })).toBe('no-action');
    expect(kind({ mergeStatus: 'conflicts' })).toBe('needs-agent');
    expect(kind({}, [{ status: 'completed', result: 'failed', definition: { name: 'ci' } }])).toBe(
      'needs-agent',
    );
    expect(kind({}, [{ status: 'inProgress' }])).toBe('no-action');
    expect(mapAdoPr(url, pr, []).headSha).toBe('abc');
  });

  it('reads the PR, then CI for its source branch', async () => {
    const az = fakeAz([
      [
        'repos pr show --id 42',
        {
          pullRequestId: 42,
          status: 'active',
          sourceRefName: 'refs/heads/agent/issue-7',
          lastMergeSourceCommit: { commitId: 'abc' },
        },
      ],
      ['pipelines runs list', [{ status: 'completed', result: 'failed', definition: { name: 'build' } }]],
    ]);
    const state = await new AdoPrHost(az.run).getPullRequest(url);
    expect(state).toMatchObject({
      state: 'OPEN',
      headSha: 'abc',
      checks: [{ name: 'build', conclusion: 'FAILURE' }],
    });
    expect(az.calls[1]).toEqual(
      expect.arrayContaining([
        '--project',
        'Web Project',
        '--branch',
        'refs/heads/agent/issue-7',
        '--top',
        '1',
      ]),
    );
  });

  it('turns PR threads into feedback, skipping system and closed threads', async () => {
    const az = fakeAz([
      [
        'repos pr show',
        {
          pullRequestId: 42,
          status: 'active',
          mergeStatus: 'conflicts',
          lastMergeSourceCommit: { commitId: 'abc' },
        },
      ],
      [
        'devops invoke',
        {
          value: [
            {
              status: 'active',
              comments: [
                { author: { displayName: 'Ann' }, content: 'Rename this function.', commentType: 'text' },
              ],
            },
            {
              status: 'active',
              comments: [
                { author: { displayName: 'System' }, content: 'Policy updated', commentType: 'system' },
              ],
            },
            {
              status: 'closed',
              comments: [{ author: { displayName: 'Bob' }, content: 'Old, resolved.', commentType: 'text' }],
            },
          ],
        },
      ],
    ]);
    const fb = await new AdoPrHost(az.run).getFeedback(url);
    expect(fb).toContain('Comment by Ann:\nRename this function.');
    expect(fb).toContain('merge conflicts');
    expect(fb).not.toContain('Policy updated');
    expect(fb).not.toContain('Old, resolved.');
  });
});

describe('ADO configuration and routing', () => {
  it('parses refs whose project name has spaces', () => {
    expect(parseRef('ado:contoso/Web Project#7')).toEqual({
      provider: 'ado',
      repo: 'contoso/Web Project',
      number: 7,
    });
  });

  it('requires ado settings and GitHub-style names where they apply', () => {
    expect(() =>
      AgentRunnerConfigSchema.parse({ repos: [{ name: 'x', path: '/p', tracker: 'azure-boards' }] }),
    ).toThrow(/ado/);
    expect(() => AgentRunnerConfigSchema.parse({ repos: [{ name: 'not-owner-repo', path: '/p' }] })).toThrow(
      /owner\/repo/,
    );
    expect(AgentRunnerConfigSchema.parse({ repos: [{ ...repo }] }).repos[0]!.host).toBe('ado');
  });

  it('picks the tracker and PR host per repo', () => {
    const t = (kind: string) => ({
      kind,
      listReady: async () => [],
      get: async () => ({}) as never,
      updateLabels: async () => {},
      comment: async () => ({ posted: true }),
    });
    const h = (kind: string) => ({
      kind,
      findPullRequests: async () => [],
      getPullRequest: async () => ({}) as never,
      getFeedback: async () => '',
    });
    const resolve = createSourceResolver({
      trackers: { github: t('github'), 'azure-boards': t('azure-boards') },
      hosts: { github: h('github'), ado: h('ado') },
    });
    expect(resolve(repo).name).toBe('azure-boards+ado');
    expect(resolve(RepoConfigSchema.parse({ name: 'a/b', path: '/p' })).name).toBe('github+github');
    expect(
      resolve(RepoConfigSchema.parse({ name: 'a/b', path: '/p', host: 'ado', ado: repo.ado })).name,
    ).toBe('github+ado');
  });

  it('tells the agent how to open the PR on each host', () => {
    const task = {
      ref: 'ado:contoso/Web Project#7',
      repo: repo.name,
      number: 7,
      title: 'T',
      body: 'B',
      url: 'u',
      labels: [],
    };
    const ado = buildPrompt(task, repo, 'agent/issue-7', 1);
    expect(ado).toContain(
      'az repos pr create --org https://dev.azure.com/contoso --project "Web Project" --repository "website"',
    );
    expect(ado).toContain('--source-branch agent/issue-7 --target-branch main --work-items 7');
    const gh = buildPrompt(
      { ...task, ref: 'github:a/b#7' },
      RepoConfigSchema.parse({ name: 'a/b', path: '/p' }),
      'agent/issue-7',
      1,
    );
    expect(gh).toContain('gh pr create');
    expect(gh).toContain('"Closes #7"');
  });

  it('converts work item HTML to text', () => {
    expect(htmlToText('<p>One</p><p>Two&nbsp;&gt; 1</p>')).toBe('One\nTwo > 1');
  });
});
