#!/usr/bin/env node
// Stand-in for an agent CLI (claude -p ...). Driven by env so tests can choose behaviour.
//   FAKE_AGENT_MODE: pr (default) | noop | ratelimit | slow
//   FAKE_PR_DIR:     where "opened PRs" are recorded (read by FakeSource)
//   FAKE_AGENT_CALLS: file that gets one line per invocation
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Called either as `fake-agent <prompt>` or with claude's flags (`-p <prompt> ...`).
const pIdx = process.argv.indexOf('-p');
const prompt = (pIdx >= 0 ? process.argv[pIdx + 1] : process.argv[2]) ?? '';
const ref = /\((github:[^)]+)\)/.exec(prompt)?.[1] ?? 'unknown';
const branch = /branch name: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';
const mode = process.env.FAKE_AGENT_MODE ?? 'pr';
if (process.env.FAKE_AGENT_CALLS) appendFileSync(process.env.FAKE_AGENT_CALLS, `${ref} ${mode}\n`);
if (process.env.FAKE_AGENT_PROMPTS) appendFileSync(process.env.FAKE_AGENT_PROMPTS, `${prompt}\n=====\n`);

console.log(
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
    },
  }),
);

if (mode === 'slow') {
  await new Promise((r) => setTimeout(r, 60_000));
} else if (mode === 'ratelimit') {
  console.log(
    '{"type":"result","is_error":true,"result":"Claude usage limit reached. Your limit will reset at 2099-01-01T00:00:00Z"}',
  );
  process.exit(1);
} else if (mode === 'pr' && process.env.FAKE_GH_STATE) {
  // Open the PR in the fake gh state, like `gh pr create` would.
  const f = process.env.FAKE_GH_STATE;
  const state = JSON.parse(readFileSync(f, 'utf8'));
  const repo = /^github:([^#]+)#/.exec(ref)?.[1];
  const n = /#(\d+)$/.exec(ref)?.[1];
  // Create the PR on the first run; every run "pushes" a new head commit.
  const pr = (state.prs[`${repo}:${branch}`] ??= {
    url: `https://github.example/${repo}/pull/${n}`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [],
    latestReviews: [],
    reviews: [],
    comments: [],
  });
  pr.headRefOid = Math.random().toString(16).slice(2).padEnd(40, '0');
  pr.commits = [{ committedDate: new Date().toISOString() }];
  pr.statusCheckRollup = [];
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, f);
  console.log('opened pull request');
} else if (mode === 'pr') {
  mkdirSync(process.env.FAKE_PR_DIR, { recursive: true });
  const n = /#(\d+)$/.exec(ref)?.[1];
  const f = join(process.env.FAKE_PR_DIR, `${ref.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
  let pr;
  try {
    pr = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    pr = {
      url: `https://github.example/pr/${n}`,
      state: 'OPEN',
      branch,
      isDraft: false,
      reviewDecision: null,
      mergeStateStatus: 'CLEAN',
      checks: [],
      latestReviews: [],
    };
  }
  // A push: new head commit; CI result and stale review comments are reset.
  pr.headSha = Math.random().toString(16).slice(2).padEnd(40, '0');
  pr.lastCommitAt = new Date().toISOString();
  pr.checks = [];
  writeFileSync(f, JSON.stringify(pr));
  try {
    execFileSync('git', ['checkout', '-q', '-B', branch], { stdio: 'ignore' });
  } catch {
    // not a git checkout (unit-style use)
  }
  console.log(
    JSON.stringify({
      type: 'result',
      is_error: process.env.FAKE_AGENT_RESULT_ERROR === '1',
      result: 'pushed',
    }),
  );
} else {
  console.log('thought about it, did nothing');
}
