import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], { timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()),
    ),
  );

/**
 * Refuse to start an agent on a checkout that is not on the default branch or
 * has uncommitted changes (ported from tpm's drift check). A dirty tree after
 * a crashed attempt is a human decision, not something to push through.
 */
export async function checkCheckout(
  path: string,
  defaultBranch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let branch: string;
  let status: string;
  try {
    branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    status = await git(path, ['status', '--porcelain']);
  } catch (e) {
    return { ok: false, reason: `not a usable git checkout: ${(e as Error).message}` };
  }
  if (branch !== defaultBranch)
    return { ok: false, reason: `checkout is on "${branch}", expected "${defaultBranch}"` };
  if (status) return { ok: false, reason: `checkout has uncommitted changes:\n${status.slice(0, 500)}` };
  return { ok: true };
}

/**
 * The worker owns the checkout between runs. Agents leave it on their feature
 * branch; if the tree is clean, switching back to the default branch loses
 * nothing, so do it. A dirty tree is never touched: that needs a human.
 */
export async function resetCheckout(
  path: string,
  defaultBranch: string,
): Promise<{ ok: true; switchedFrom?: string } | { ok: false; reason: string }> {
  let branch: string;
  try {
    const status = await git(path, ['status', '--porcelain']);
    if (status) return { ok: false, reason: `checkout has uncommitted changes:\n${status.slice(0, 500)}` };
    branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === defaultBranch) return { ok: true };
    await git(path, ['checkout', '-q', defaultBranch]);
  } catch (e) {
    return { ok: false, reason: `not a usable git checkout: ${(e as Error).message}` };
  }
  return { ok: true, switchedFrom: branch };
}

/**
 * The separate, read-only review checkout, positioned exactly at `sha`.
 * Reviewers and verify never touch the author's checkout.
 */
export async function prepareReviewClone(o: {
  authorPath: string;
  reviewPath: string;
  branch: string;
  defaultBranch: string;
  sha: string;
}): Promise<void> {
  if (!existsSync(o.reviewPath)) {
    // Clone from the same origin as the author checkout (or the checkout itself if it has none).
    const origin = await git(o.authorPath, ['remote', 'get-url', 'origin']).catch(() => o.authorPath);
    await new Promise<void>((resolve, reject) =>
      execFile('git', ['clone', '-q', origin, o.reviewPath], { timeout: 600_000 }, (err, _o, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(),
      ),
    );
  }
  await git(o.reviewPath, [
    'fetch',
    '-q',
    'origin',
    `+refs/heads/${o.branch}:refs/remotes/origin/${o.branch}`,
    `+refs/heads/${o.defaultBranch}:refs/remotes/origin/${o.defaultBranch}`,
  ]);
  await git(o.reviewPath, ['checkout', '-q', '--detach', o.sha]);
  await git(o.reviewPath, ['reset', '-q', '--hard', o.sha]);
  await git(o.reviewPath, ['clean', '-qfd']); // keeps ignored files (node_modules) for faster verify runs
  const head = await git(o.reviewPath, ['rev-parse', 'HEAD']);
  if (head !== o.sha) throw new Error(`review clone is at ${head}, expected ${o.sha}`);
}
