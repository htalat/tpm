import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLI_NAME } from "../util/cli_name.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Stand up an isolated tpm tree (the data root) plus an isolated HOME holding
// the `~/.tpm/config.json` that points at it. Returns the env to pass to runCli
// so the spawned CLI resolves this tree instead of the developer's real one.
function setupTree(): { root: string; home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "tpm-cli-root-"));
  const home = mkdtempSync(join(tmpdir(), "tpm-cli-home-"));
  mkdirSync(join(root, ".tpm"), { recursive: true }); // root marker findRoot() requires
  mkdirSync(join(home, ".tpm"), { recursive: true });
  writeFileSync(join(home, ".tpm", "config.json"), JSON.stringify({ root }));
  return { root, home, env: { HOME: home, USERPROFILE: home } };
}

// Regression guard for task 114: a top-level help/config branch referencing a
// const declared *after* the dispatch crashes with a TDZ ReferenceError before
// any of the assertions below would have caught it. Spawning the real entry
// point is the only thing that exercises module-load order.
for (const variant of ["help", "--help", "-h"]) {
  test(`entry point: \`tpm ${variant}\` exits clean and prints usage`, () => {
    const r = runCli([variant]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Usage:/);
    assert.doesNotMatch(r.stderr, /before initialization/);
  });
}

test("entry point: bare `tpm` prints usage and exits clean", () => {
  const r = runCli([]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage:/);
});

test("entry point: `tpm drop` with no task prints usage and exits non-zero", () => {
  // The drop verb (task 140) gates on a task arg before touching the tree, so
  // this exercises the dispatch + usage path without needing a configured root.
  const r = runCli(["drop"]);
  assert.notEqual(r.status, 0);
  // `tpm` on macOS/Linux, `tpmgr` on Windows (see util/cli_name.ts).
  assert.match(r.stderr, new RegExp(`${CLI_NAME} drop <task>`));
});

test("entry point: `tpm help` documents the drop verb", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`${CLI_NAME} drop <task>`));
});

// Task 156: `tpm done` is the alias agents reach for (it matches the `/tpm done`
// slash command and the AGENTS "close out" action) — it must dispatch to
// complete, not die with "Unknown command: done".
test("entry point: `tpm help` documents the done alias and no-arg status listing", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`alias: ${CLI_NAME} done`));
  assert.match(r.stdout, /list the valid statuses/);
});

// `tpm status` with no new-status arg self-documents the vocabulary so agents
// stop grepping mutate.ts for VALID_STATUSES. No tree needed — it prints before
// resolving a task.
test("status: `tpm status` with no arg lists valid statuses + reaching verbs", () => {
  const r = runCli(["status"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Valid task statuses/);
  for (const s of ["open", "ready", "in-progress", "needs-review", "needs-feedback", "needs-close", "blocked", "done", "dropped"]) {
    assert.match(r.stdout, new RegExp(`\\b${s}\\b`), `missing status: ${s}`);
  }
  // The verbs that reach a status are listed alongside it.
  assert.match(r.stdout, /complete, done, lgtm/);
});

test("status: `tpm status <task>` (no new-status) also lists the vocabulary", () => {
  // Half-typed transition — print the listing rather than a bare usage error.
  const r = runCli(["status", "some-task"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Valid task statuses/);
});

test("done: `tpm done <task>` dispatches to complete (sets status: done)", () => {
  const { root, home, env } = setupTree();
  try {
    const tasksDir = join(root, "p", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    const taskFile = join(tasksDir, "001-foo.md");
    writeFileSync(
      taskFile,
      `---\ntitle: Foo\nslug: foo\nproject: p\nstatus: in-progress\ntype: pr\nclosed:\n---\n\n# Foo\n\n## Log\n- 2026-01-01 00:00 PDT: created\n\n## Outcome\n<!-- Filled when closed -->\n`,
    );
    // --no-archive keeps the file at its original path so we can assert on it.
    const r = runCli(["done", "foo", "--no-archive"], env);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(readFileSync(taskFile, "utf8"), /status: done/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("entry point: `tpm config get <unknown>` reports the known-keys list (no TDZ)", () => {
  // Hits the same const that broke `help`. Validation error is expected; a
  // TDZ ReferenceError is not.
  const r = runCli(["config", "get", "definitely-not-a-key"]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /before initialization/);
  assert.match(r.stderr, /unknown key.*known: workers/);
});

// Regression guard for task 150: `tpm session` used the live-only resolver, so
// any archived task (pr-type tasks archive on completion) returned "No task
// matched" even though its run log — and session id — moved into the archive
// with it. Resuming a *closed* task's agent run is exactly when you reach for
// this command, so it must resolve archived tasks the way `tpm context` does.
test("session: resolves an archived task and prints its latest session id", () => {
  const { root, home, env } = setupTree();
  try {
    const tasksDir = join(root, "p", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    // Archived folder-form task with a captured run log under archive/.
    const archived = join(tasksDir, "archive", "001-foo");
    const runs = join(archived, "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(archived, "task.md"),
      `---\ntitle: Foo\nslug: foo\nproject: p\nstatus: done\ntype: pr\n---\n\n# Foo\n`,
    );
    writeFileSync(
      join(runs, "20260601T080000Z.log"),
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-archived-1" }) + "\n",
    );

    const r = runCli(["session", "foo"], env);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "sess-archived-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
