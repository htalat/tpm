import { describe, expect, it } from 'vitest';
import { decideFactory, parsePolicy, STATUS, type FactoryEvidence } from '@durable/agent-runner';

const policy = parsePolicy(`
version: 1
rules:
  - paths: ["docs/**"]
    level: auto-merge
  - paths: ["dist/**"]
    level: human-approve
    verify: true
reviewers: [{ name: claude }, { name: copilot }]
approvers: [htalat]
verify: { command: npm test }
maxAutoMergesPerDay: 2
`);
const ok = { state: 'success', description: 'approve' };
const base = (over: Partial<FactoryEvidence> = {}): FactoryEvidence => ({
  pr: {
    url: 'u',
    state: 'OPEN',
    headSha: 'abc',
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    checks: [],
    latestReviews: [],
    lastCommitAt: '2026-10-07T10:00:00Z',
  },
  reviewedSha: 'abc',
  policy,
  changes: { files: ['docs/a.md'], additions: 3, deletions: 0 },
  statuses: { [STATUS.review('claude')]: ok, [STATUS.review('copilot')]: ok },
  approvals: [],
  autoMergesToday: 0,
  ...over,
});
const kind = (e: FactoryEvidence) => decideFactory(e).kind;

describe('factory decision', () => {
  it('auto-merges a docs change when both reviewers approved the reviewed commit', () => {
    expect(decideFactory(base())).toMatchObject({ kind: 'ready-to-merge', level: 'auto-merge' });
  });

  it('platform state wins first (merged, conflict, changes requested)', () => {
    expect(kind(base({ pr: { ...base().pr, state: 'MERGED' } }))).toBe('merged');
    expect(kind(base({ pr: { ...base().pr, mergeStateStatus: 'DIRTY' } }))).toBe('needs-agent');
    expect(kind(base({ pr: { ...base().pr, reviewDecision: 'CHANGES_REQUESTED' } }))).toBe('needs-human');
  });

  it('factory statuses do not count as generic CI', () => {
    const pr = { ...base().pr, checks: [{ name: 'tpm/review-claude', conclusion: 'FAILURE' }] };
    expect(
      decideFactory(
        base({
          pr,
          statuses: { ...base().statuses, [STATUS.review('claude')]: { state: 'failure', description: 'x' } },
        }),
      ).reason,
    ).toBe('tpm/review-claude: x');
  });

  it('a commit after the review sends it to a human', () => {
    expect(decideFactory(base({ pr: { ...base().pr, headSha: 'def' } }))).toMatchObject({
      kind: 'needs-human',
    });
  });

  it('waits for missing reviews; request-changes -> agent; needs-human -> human', () => {
    expect(kind(base({ statuses: { [STATUS.review('claude')]: ok } }))).toBe('no-action');
    expect(
      kind(
        base({
          statuses: { ...base().statuses, [STATUS.review('copilot')]: { state: 'pending', description: '' } },
        }),
      ),
    ).toBe('no-action');
    expect(
      kind(
        base({
          statuses: {
            ...base().statuses,
            [STATUS.review('copilot')]: { state: 'failure', description: 'bug' },
          },
        }),
      ),
    ).toBe('needs-agent');
    expect(
      kind(
        base({
          statuses: {
            ...base().statuses,
            [STATUS.review('copilot')]: { state: 'error', description: 'unsure' },
          },
        }),
      ),
    ).toBe('needs-human');
  });

  it('dist changes need verify and an approval given after the newest commit', () => {
    const dist = { changes: { files: ['dist/index.html'], additions: 3, deletions: 0 } };
    expect(decideFactory(base(dist)).reason).toBe('waiting for tpm/verify');
    const verified = { ...dist, statuses: { ...base().statuses, [STATUS.verify]: ok } };
    expect(decideFactory(base(verified))).toMatchObject({ kind: 'no-action', level: 'human-approve' });
    expect(kind(base({ ...verified, approvals: [{ actor: 'htalat', at: '2026-10-07T09:00:00Z' }] }))).toBe(
      'no-action',
    ); // before the commit
    expect(kind(base({ ...verified, approvals: [{ actor: 'mallory', at: '2026-10-07T11:00:00Z' }] }))).toBe(
      'no-action',
    ); // not an approver
    expect(
      decideFactory(base({ ...verified, approvals: [{ actor: 'htalat', at: '2026-10-07T11:00:00Z' }] })),
    ).toMatchObject({
      kind: 'ready-to-merge',
      approvedBy: 'htalat',
    });
  });

  it('human-merge paths, the daily cap and platform rules stop automatic merges', () => {
    expect(
      decideFactory(base({ changes: { files: ['scripts/deploy.mjs'], additions: 1, deletions: 0 } })),
    ).toMatchObject({ kind: 'needs-human' });
    expect(decideFactory(base({ autoMergesToday: 2 })).reason).toMatch(/cap/);
    expect(kind(base({ pr: { ...base().pr, mergeStateStatus: 'BLOCKED' } }))).toBe('no-action');
  });

  it('without a policy file a human merges, after the reviews', () => {
    expect(decideFactory(base({ policy: null, statuses: {} }))).toMatchObject({ kind: 'needs-human' });
  });
});
