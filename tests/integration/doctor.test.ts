import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABELS } from '@durable/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execProbe, formatReport, runDoctor, type CheckResult, type Probe } from '../../apps/cli/src/doctor';
import { testDatabaseUrl } from '@durable/testkit';
import { useHarness } from '../support/harness';

const POLICY = `version: 1
rules:
  - paths: ["docs/**"]
    level: auto-merge
reviewers: [{ name: claude }]
`;

/** Fake gh/claude/copilot; git and bash run for real. */
function fakeProbe(
  over: Partial<{ auth: boolean; labels: string[]; policy: string | null; claude: boolean }> = {},
): Probe {
  const o = {
    auth: true,
    labels: Object.values(LABELS),
    policy: POLICY as string | null,
    claude: true,
    ...over,
  };
  return async (bin, args, opts) => {
    if (bin === 'git' || bin === 'bash') return execProbe(bin, args, opts);
    const cmd = [bin, ...args].join(' ');
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    const err = (stderr: string) => ({ code: 1, stdout: '', stderr });
    if (bin === 'claude')
      return o.claude ? ok('2.1.286 (Claude Code)') : { code: null, stdout: '', stderr: '' };
    if (cmd === 'gh --version') return ok('gh version 2.98.0');
    if (cmd === 'gh auth status')
      return o.auth
        ? ok('github.com\n  ✓ Logged in to github.com account tester (keyring)')
        : err('You are not logged into any GitHub hosts');
    if (cmd.startsWith('gh repo view acme/app')) return ok('{"name":"app"}');
    if (cmd.startsWith('gh label list --repo acme/app'))
      return ok(JSON.stringify(o.labels.map((name) => ({ name }))));
    if (cmd.startsWith('gh api repos/acme/app/contents/.tpm/agent-policy.yml')) {
      return o.policy === null
        ? err('gh: Not Found (HTTP 404)')
        : ok(Buffer.from(o.policy).toString('base64'));
    }
    return err(`unexpected: ${cmd}`);
  };
}

const byName = (r: CheckResult[], name: string) => r.find((c) => c.name === name);

describe('doctor', () => {
  const h = useHarness();
  let dir: string;
  let configPath: string;
  const env = () => ({ DATABASE_URL: testDatabaseUrl(), API_URL: 'http://127.0.0.1:9', GH_BIN: 'gh' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doctor-'));
    const repo = join(dir, 'app');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README.md'), '# app\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '-m',
      'init',
    ]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
    configPath = join(dir, 'agent-runner.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ name: 'acme/app', path: repo, defaultBranch: 'main', agent: 'claude', factory: true }],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a healthy setup has no failures (the API being down is only a warning)', async () => {
    const r = await runDoctor({ probe: fakeProbe(), env: env(), configPath, dataDir: dir });
    expect(r.filter((c) => c.status === 'fail')).toEqual([]);
    expect(byName(r, 'gh auth')).toMatchObject({ status: 'ok', detail: 'tester on github.com' });
    expect(byName(r, 'migrations')).toMatchObject({ status: 'ok' });
    expect(byName(r, 'policy')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('auto-merge: docs/**'),
    });
    expect(byName(r, 'ready')).toMatchObject({ status: 'warn' });
    // One group per repo (CLI checks come first).
    const groups = r.map((c) => c.group).filter((g, i, a) => a.indexOf(g) === i);
    expect(groups).toEqual([
      'system',
      'database',
      'engine',
      'api',
      'agent-runner',
      'github',
      'repo acme/app',
      'data',
    ]);
    expect(formatReport(r)).toMatch(/0 failure\(s\)/);
  });

  it('finds setup problems and says how to fix them', async () => {
    writeFileSync(join(dir, 'app', 'README.md'), 'local edit\n');
    const r = await runDoctor({
      probe: fakeProbe({ auth: false, labels: [LABELS.ready], policy: 'version: 9', claude: false }),
      env: env(),
      configPath,
      dataDir: dir,
    });
    expect(byName(r, 'checkout')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('uncommitted changes'),
    });
    expect(byName(r, 'gh auth')).toMatchObject({ status: 'fail', fix: 'gh auth login' });
    expect(byName(r, 'labels')).toMatchObject({ status: 'warn', fix: 'npm run agent-runner -- labels' });
    expect(byName(r, 'policy')).toMatchObject({ status: 'fail', detail: expect.stringContaining('invalid') });
    expect(byName(r, 'agent CLI (claude)')).toMatchObject({ status: 'fail' });
  });

  it('a missing policy is a warning, not a failure', async () => {
    const r = await runDoctor({ probe: fakeProbe({ policy: null }), env: env(), configPath, dataDir: dir });
    expect(r.filter((c) => c.name === 'policy')).toEqual([expect.objectContaining({ status: 'warn' })]);
  });

  it('finds unregistered workflow versions and work nobody processes', async () => {
    const old = new Date(Date.now() - 3600_000);
    const { task } = await h.engine.createTask({ type: 'example-sequence', input: null });
    await h.pool.query(`UPDATE tasks SET workflow_version = 99, wake_at = $2 WHERE id = $1`, [task.id, old]);
    await h.pool.query(
      `INSERT INTO timers (id, task_id, timer_type, fire_at, status, created_at) VALUES (gen_random_uuid(), $1, 'SLEEP', $2, 'SCHEDULED', $2)`,
      [task.id, old],
    );
    const r = await runDoctor({ probe: fakeProbe(), env: env(), configPath, dataDir: dir });
    expect(byName(r, 'workflow versions')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('example-sequence@99 (1)'),
    });
    expect(byName(r, 'orchestrator')).toMatchObject({ status: 'warn' });
    expect(byName(r, 'timers')).toMatchObject({ status: 'warn' });
  });

  it('keeps going when the database or the config is broken', async () => {
    writeFileSync(configPath, '{ "repos": [] }');
    const r = await runDoctor({
      probe: fakeProbe(),
      env: { ...env(), DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:1/none' },
      configPath,
      dataDir: dir,
    });
    expect(byName(r, 'connection')).toMatchObject({ status: 'fail' });
    expect(byName(r, 'config')).toMatchObject({ status: 'fail' });
    expect(byName(r, 'node')).toMatchObject({ status: 'ok' });
    expect(byName(r, 'size')).toBeDefined();
    const none = await runDoctor({
      probe: fakeProbe(),
      env: {},
      configPath: join(dir, 'missing.json'),
      dataDir: dir,
    });
    expect(byName(none, 'DATABASE_URL')).toMatchObject({ status: 'fail' });
    expect(byName(none, 'config')).toMatchObject({ status: 'skip' });
  });
});
