import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenSuite } from "./evals_golden.ts";

// The suite runner itself, exercised with FAKE agents (CLAUDE_BIN seam) so CI
// never spends tokens: a well-behaved agent must pass the golden checks, a
// lazy one must fail them — proving the checks discriminate, not just pass.

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

// A fake agent is an executable that receives claude's argv (buildArgs shape:
// -p <prompt> --add-dir <repoLocal> …), performs scripted behavior with the
// real tpm CLI + git, and emits claude-stream-json NDJSON on stdout.
function writeAgent(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const repo = argv[argv.indexOf("--add-dir") + 1] ?? ".";
const slug = (prompt.match(/00\\d-[a-z-]+/) ?? ["?"])[0];
const CLI = ${JSON.stringify(CLI)};
const tpm = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
say({ type: "system", subtype: "init", session_id: "fake-" + slug });
const act = (name, fn) => {
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name: "Bash", input: { command: name } }] } });
  let out = "", err = false;
  try { out = String(fn() ?? "ok"); } catch (e) { out = String(e.message ?? e); err = true; }
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: name, is_error: err, content: out.slice(0, 200) }] } });
};
${body}
say({ type: "result", subtype: "success", is_error: false, result: "done", duration_ms: 1000, total_cost_usd: 0.01 });
`);
  chmodSync(path, 0o755);
  return path;
}

const GOOD_FIX_BUG = `
const briefing = tpm("context", slug);
const prLine = (briefing.match(/tpm pr \\S+ (\\S+)/) ?? [])[1];
act("fix add.js", () => writeFileSync(join(repo, "add.js"), "export function add(a, b) {\\n  return a + b;\\n}\\n"));
act("validate", () => execFileSync(process.execPath, ["test.js"], { cwd: repo, encoding: "utf8" }));
act("branch+push", () => {
  git("checkout", "-q", "-b", "fix/" + slug);
  git("add", "-A");
  git("commit", "-q", "-m", "fix add()");
  git("push", "-q", "origin", "fix/" + slug);
});
act("tpm pr", () => tpm("pr", slug, prLine));
`;

const GOOD_INVESTIGATE = `
act("read config", () => readFileSync(join(repo, "config.json"), "utf8"));
act("scaffold report", () => tpm("report", slug));
act("write report", () => {
  const root = tpm("root").trim();
  writeFileSync(join(root, "golden", "tasks", slug, "report.md"), "# Report\\n\\n## Summary\\nThe service binds port 7443.\\n\\n## Findings\\n- config.json sets port 7443\\n\\n## Recommendation\\nNone.\\n");
});
act("attach", () => tpm("report", slug));
`;

const LAZY = `
act("look around", () => "nothing to see");
`;

test("golden runner: a well-behaved agent passes fix-bug end to end", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-fake-agent-"));
  try {
    const agent = writeAgent(dir, "good-fix.mjs", GOOD_FIX_BUG);
    const report = await runGoldenSuite({ reps: 1, only: "fix-bug", agentBin: agent, minutes: 2 });
    assert.equal(report.results.length, 1);
    const r = report.results[0];
    assert.equal(r.pass, true, JSON.stringify(r.checks.filter(c => !c.ok), null, 2));
    assert.equal(r.metrics?.costUsd, 0.01);
    assert.equal(report.spentUsd, 0.01);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden runner: a well-behaved agent passes investigate", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-fake-agent-"));
  try {
    const agent = writeAgent(dir, "good-inv.mjs", GOOD_INVESTIGATE);
    const report = await runGoldenSuite({ reps: 1, only: "investigate", agentBin: agent, minutes: 2 });
    const r = report.results[0];
    assert.equal(r.pass, true, JSON.stringify(r.checks.filter(c => !c.ok), null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden runner: a lazy agent fails the checks (they discriminate)", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-fake-agent-"));
  try {
    const agent = writeAgent(dir, "lazy.mjs", LAZY);
    const report = await runGoldenSuite({ reps: 1, only: "fix-bug", agentBin: agent, minutes: 2 });
    const r = report.results[0];
    assert.equal(r.pass, false);
    const failed = r.checks.filter(c => !c.ok).map(c => c.name);
    assert.ok(failed.includes("pushed branch passes the test"), failed.join(", "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden runner: budget stops the suite before the next dispatch", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-fake-agent-"));
  try {
    const agent = writeAgent(dir, "lazy2.mjs", LAZY);
    // Each fake run reports $0.01; budget $0.005 exhausts after rep 1.
    const report = await runGoldenSuite({ reps: 3, only: "fix-bug", agentBin: agent, budgetUsd: 0.005, minutes: 2 });
    assert.equal(report.results.length, 1);
    assert.equal(report.budgetExhausted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden runner: a FILE-form task survives the fold at dispatch (tpm/188 regression)", { timeout: 120_000 }, async () => {
  // Reproduce the pre-fix crash shape: seed the fixture as file-form by
  // converting the folder task back to a flat .md, then dispatch.
  const dir = mkdtempSync(join(tmpdir(), "tpm-fake-agent-"));
  try {
    const agent = writeAgent(dir, "good-fix2.mjs", GOOD_FIX_BUG);
    const report = await runGoldenSuite({
      reps: 1,
      only: "fix-bug",
      agentBin: agent,
      minutes: 2,
      mutateEnv: (env) => {
        // fold back to file-form: tasks/<slug>/task.md -> tasks/<slug>.md
        const folder = join(env.root, "golden", "tasks", env.slug);
        const flat = join(env.root, "golden", "tasks", `${env.slug}.md`);
        writeFileSync(flat, readFileSync(join(folder, "task.md"), "utf8"));
        rmSync(folder, { recursive: true, force: true });
      },
    });
    const r = report.results[0];
    assert.equal(r.pass, true, JSON.stringify(r.checks.filter(c => !c.ok), null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
