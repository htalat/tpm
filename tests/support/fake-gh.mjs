#!/usr/bin/env node
// Minimal stand-in for the GitHub CLI, backed by a JSON file ($FAKE_GH_STATE).
// Supports exactly the calls GitHubIssuesSource makes.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const load = () => JSON.parse(readFileSync(file, 'utf8'));
const save = (s) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
};
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const [group, verb, num] = args;
const repo = opt('--repo');
// `gh pr view <url>` has no --repo
const s = load();
const key = `${repo}#${num}`;
const out = (v) => process.stdout.write(JSON.stringify(v));
const asGh = (i) => ({ ...i, labels: i.labels.map((name) => ({ name })) });

if (group === 'issue' && verb === 'list') {
  out(
    Object.values(s.issues)
      .filter((i) => i.repo === repo && i.labels.includes(opt('--label')))
      .map(asGh),
  );
} else if (group === 'issue' && verb === 'view') {
  const i = s.issues[key];
  if (!i) process.exit(1);
  out(opt('--json') === 'comments' ? { comments: i.comments.map((body) => ({ body })) } : asGh(i));
} else if (group === 'issue' && verb === 'edit') {
  const i = s.issues[key];
  for (const l of all('--remove-label')) {
    if (!i.labels.includes(l)) {
      console.error(`label ${l} not on issue`);
      process.exit(1);
    }
  }
  i.labels = [
    ...new Set([...i.labels.filter((l) => !all('--remove-label').includes(l)), ...all('--add-label')]),
  ];
  save(s);
} else if (group === 'issue' && verb === 'comment') {
  s.issues[key].comments.push(opt('--body'));
  save(s);
} else if (group === 'pr' && verb === 'view') {
  const pr = Object.values(s.prs).find((p) => p.url === num);
  if (!pr) process.exit(1);
  out(pr);
} else if (group === 'pr' && verb === 'list') {
  const pr = s.prs[`${repo}:${opt('--head')}`];
  out(pr ? [pr] : []);
} else if (group === 'label' && verb === 'create') {
  // no-op
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(2);
}
