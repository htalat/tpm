#!/usr/bin/env node
// Stand-in for a reviewer CLI. argv: <name> <prompt>. Verdict from FAKE_REVIEW_<NAME>
// (approve | request-changes | needs-human | garbage). Records the commit it saw.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [name] = process.argv.slice(2);
const verdict = process.env[`FAKE_REVIEW_${name.toUpperCase()}`] ?? 'approve';
let head = 'none';
try {
  head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
} catch {
  // not a checkout
}
if (process.env.FAKE_REVIEW_CALLS)
  appendFileSync(process.env.FAKE_REVIEW_CALLS, `${name} ${head} ${verdict}\n`);
const body = {
  verdict,
  summary: `${name} says ${verdict}`,
  findings:
    verdict === 'request-changes'
      ? [{ file: 'docs/x.md', line: 1, severity: 'major', comment: `${name}: please fix the wording` }]
      : [],
};
if (verdict === 'garbage') console.log('I am not sure what to say.');
else if (name === 'claude')
  console.log(
    JSON.stringify({ type: 'result', is_error: false, structured_output: body, total_cost_usd: 0.01 }),
  );
else console.log(`Looks fine overall.\n<verdict>${JSON.stringify(body)}</verdict>`);
