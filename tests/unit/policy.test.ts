import { describe, expect, it } from 'vitest';
import { evaluatePolicy, globToRegExp, parsePolicy } from '@durable/agent-runner';

const policy = parsePolicy(`
version: 1
default: human-merge
rules:
  - paths: ["docs/**", "*.md"]
    level: auto-merge
  - paths: ["dist/**"]
    level: human-approve
    verify: true
approvers: [htalat]
verify:
  command: npm test
maxChangedLines: 100
`);
const ev = (files: string[], lines = 2) => evaluatePolicy(policy, { files, additions: lines, deletions: 0 });

describe('agent policy', () => {
  it('matches globs', () => {
    expect(globToRegExp('docs/**').test('docs/a/b.md')).toBe(true);
    expect(globToRegExp('docs/**').test('docsx/a.md')).toBe(false);
    expect(globToRegExp('*.md').test('deep/dir/README.md')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('**/test/*.ts').test('test/a.ts')).toBe(true);
  });

  it('takes the most restrictive level of all changed files', () => {
    expect(ev(['docs/a.md', 'README.md']).level).toBe('auto-merge');
    expect(ev(['docs/a.md', 'dist/index.html'])).toMatchObject({
      level: 'human-approve',
      verifyRequired: true,
    });
    expect(ev(['docs/a.md', 'scripts/deploy.mjs']).level).toBe('human-merge'); // default
  });

  it('never lets a change to the policy itself or to CI workflows merge without a human', () => {
    expect(ev(['.tpm/agent-policy.yml']).level).toBe('human-merge');
    expect(ev(['docs/a.md', '.github/workflows/deploy.yml']).level).toBe('human-merge');
    const permissive = parsePolicy(
      'version: 1\ndefault: auto-merge\nrules:\n  - paths: ["**"]\n    level: auto-merge\n',
    );
    expect(
      evaluatePolicy(permissive, { files: ['.github/workflows/ci.yml'], additions: 1, deletions: 0 }).level,
    ).toBe('human-merge');
  });

  it('escalates big changes, never relaxes', () => {
    expect(ev(['docs/a.md'], 500).level).toBe('human-approve');
    expect(ev(['scripts/x.mjs'], 500).level).toBe('human-merge');
  });

  it('no policy or no files means a human merges', () => {
    expect(evaluatePolicy(null, { files: ['docs/a.md'], additions: 1, deletions: 0 }).level).toBe(
      'human-merge',
    );
    expect(ev([]).level).toBe('human-merge');
  });

  it('defaults: claude and copilot review', () => {
    expect(policy.reviewers.map((r) => r.name)).toEqual(['claude', 'copilot']);
    expect(() => parsePolicy('version: 2')).toThrow();
  });
});
