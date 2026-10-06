// Stand-in for an agent CLI (claude -p ...). Driven by env so tests can choose behaviour.
//   FAKE_AGENT_MODE: pr (default) | noop | ratelimit | slow
//   FAKE_PR_DIR:     where "opened PRs" are recorded (read by FakeSource)
//   FAKE_AGENT_CALLS: file that gets one line per invocation
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = process.argv[2] ?? '';
const ref = /\((github:[^)]+)\)/.exec(prompt)?.[1] ?? 'unknown';
const branch = /branch name: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';
const mode = process.env.FAKE_AGENT_MODE ?? 'pr';
if (process.env.FAKE_AGENT_CALLS) appendFileSync(process.env.FAKE_AGENT_CALLS, `${ref} ${mode}\n`);

if (mode === 'slow') {
  await new Promise((r) => setTimeout(r, 60_000));
} else if (mode === 'ratelimit') {
  console.log(
    '{"type":"result","is_error":true,"result":"Claude usage limit reached. Your limit will reset at 2099-01-01T00:00:00Z"}',
  );
  process.exit(1);
} else if (mode === 'pr') {
  mkdirSync(process.env.FAKE_PR_DIR, { recursive: true });
  const n = /#(\d+)$/.exec(ref)?.[1];
  writeFileSync(
    join(process.env.FAKE_PR_DIR, `${ref.replace(/[^A-Za-z0-9]+/g, '_')}.json`),
    JSON.stringify({ url: `https://github.example/pr/${n}`, state: 'OPEN', branch }),
  );
  console.log('opened pull request');
} else {
  console.log('thought about it, did nothing');
}
