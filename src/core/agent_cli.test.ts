import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_CLIS,
  DEFAULT_AGENT_CLI,
  resolveAgentCli,
} from "./agent_cli.ts";
import type { Project, Task } from "./tree.ts";

function task(extra: Record<string, unknown> = {}): Task {
  return {
    slug: "001-t",
    path: "/tmp/t.md",
    archived: false,
    data: { slug: "001-t", status: "ready", ...extra },
    body: "",
  };
}

function project(extra: Record<string, unknown> = {}): Project {
  return {
    slug: "p",
    path: "/tmp/p/project.md",
    dir: "/tmp/p",
    data: { slug: "p", status: "active", ...extra },
    body: "",
    tasks: [],
  };
}

test("registry: claude entry has the canonical claude stream-json shape", () => {
  // Pin the args contract — these flags are what make claude emit NDJSON
  // events as they happen instead of just the final message.
  const claude = AGENT_CLIS["claude"];
  assert.equal(claude.name, "claude");
  assert.equal(claude.outputFormat, "claude-stream-json");
  assert.equal(claude.envVar, "CLAUDE_BIN");
  const args = claude.buildArgs("PROMPT", "/path/to/repo");
  assert.deepEqual(args, [
    "-p", "PROMPT",
    "--add-dir", "/path/to/repo",
    "--output-format", "stream-json",
    "--verbose",
    "--disallowed-tools", "AskUserQuestion",
  ]);
});

// Regression: claude's `--disallowed-tools` is variadic-greedy — it consumes
// subsequent positional-shaped tokens as additional disallowed-tool names.
// If `prompt` is placed trailing, it gets eaten as a tool name and claude
// exits with "Input must be provided either through stdin or as a prompt
// argument when using --print." Lock the prompt to the slot immediately after
// `-p` so this can't regress (task 116).
test("registry: claude prompt is anchored to -p, not trailing after --disallowed-tools", () => {
  const args = AGENT_CLIS["claude"].buildArgs("THE-PROMPT", "/r");
  const pIdx = args.indexOf("-p");
  assert.notEqual(pIdx, -1, "claude args must include -p");
  assert.equal(args[pIdx + 1], "THE-PROMPT", "prompt must immediately follow -p");
  const disIdx = args.indexOf("--disallowed-tools");
  assert.notEqual(disIdx, -1);
  assert.ok(pIdx < disIdx, "-p (with prompt) must precede --disallowed-tools");
  assert.equal(
    args[args.length - 1],
    "AskUserQuestion",
    "the trailing arg must be the disallowed tool name, not the prompt — otherwise --disallowed-tools eats the prompt",
  );
});

test("registry: claude entry disallows AskUserQuestion structurally", () => {
  // Belt-and-suspenders to task 085's prompt-side rule. An orchestrator run
  // is non-interactive (`-p`), so the question tool can only ever halt — the
  // structural deny here means a prompt regression can't put it back. If the
  // flag spelling changes upstream, the assertion below is what catches it.
  // Copilot has no analogous `--disallowed-tools` flag, but its own
  // `--no-ask-user` (covered by the copilot test below) closes the same gap.
  const args = AGENT_CLIS["claude"].buildArgs("P", "/r");
  const idx = args.indexOf("--disallowed-tools");
  assert.notEqual(idx, -1, "claude args must include --disallowed-tools");
  assert.equal(args[idx + 1], "AskUserQuestion");
});

test("registry: copilot entry includes the non-interactive flag triad", () => {
  // `--allow-all-tools` (skip permission prompts), `--no-ask-user` (the
  // copilot equivalent of task 085's prompt rule), `--autopilot` (don't
  // bail after one turn). Any of these missing turns a copilot dispatch
  // into a one-shot or a hang on the first permission gate.
  const copilot = AGENT_CLIS["copilot"];
  assert.equal(copilot.name, "copilot");
  assert.equal(copilot.outputFormat, "copilot-json");
  assert.equal(copilot.envVar, "COPILOT_BIN");
  const args = copilot.buildArgs("PROMPT", "/path/to/repo");
  assert.deepEqual(args, [
    "-p", "PROMPT",
    "--add-dir", "/path/to/repo",
    "--output-format", "json",
    "--allow-all-tools",
    "--no-ask-user",
    "--autopilot",
  ]);
});

test("resolveAgentCli: returns the registry default when nothing is set", () => {
  const cli = resolveAgentCli({});
  assert.equal(cli.name, DEFAULT_AGENT_CLI);
  assert.equal(cli.name, "claude");
});

test("resolveAgentCli: config wins over default", () => {
  const cli = resolveAgentCli({ configAgent: "copilot" });
  assert.equal(cli.name, "copilot");
});

test("resolveAgentCli: project frontmatter wins over config", () => {
  const cli = resolveAgentCli({
    project: project({ agent: "copilot" }),
    configAgent: "claude",
  });
  assert.equal(cli.name, "copilot");
});

test("resolveAgentCli: task frontmatter wins over project", () => {
  const cli = resolveAgentCli({
    task: task({ agent: "copilot" }),
    project: project({ agent: "claude" }),
    configAgent: "claude",
  });
  assert.equal(cli.name, "copilot");
});

test("resolveAgentCli: explicit override wins over task frontmatter", () => {
  // The `--agent <name>` flag on `tpm orchestrate`. Sanity-check path for
  // an operator wanting to dispatch a claude-default task as copilot once.
  const cli = resolveAgentCli({
    override: "copilot",
    task: task({ agent: "claude" }),
    project: project({ agent: "claude" }),
    configAgent: "claude",
  });
  assert.equal(cli.name, "copilot");
});

test("resolveAgentCli: ignores empty / non-string frontmatter values", () => {
  // A hand-edited `agent:` field that's an empty string or wrong type
  // shouldn't poison the cascade — fall through to the next level.
  const cli = resolveAgentCli({
    task: task({ agent: "" }),
    project: project({ agent: 42 }),
    configAgent: "copilot",
  });
  assert.equal(cli.name, "copilot");
});

test("resolveAgentCli: unknown agent name throws with the known list", () => {
  // A typo in frontmatter should fail the dispatch loudly so it surfaces in
  // the orchestrator log envelope, not deep inside a child process spawning
  // a binary that doesn't exist.
  assert.throws(
    () => resolveAgentCli({ override: "cursor" }),
    /unknown agent "cursor"\. Known: claude, copilot/,
  );
});

test("resolveAgentCli: env var override replaces bin path on the resolved entry", () => {
  // The pre-092 CLAUDE_BIN path stays honored; COPILOT_BIN is the new
  // analogue. The override is shallow-copied so the registry constant
  // doesn't get mutated mid-process.
  const prev = process.env.CLAUDE_BIN;
  try {
    process.env.CLAUDE_BIN = "/custom/claude";
    const cli = resolveAgentCli({});
    assert.equal(cli.bin, "/custom/claude");
    // Registry unchanged.
    assert.equal(AGENT_CLIS["claude"].bin, "claude");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
  }
});

test("resolveAgentCli: env var override leaves bin alone when env var is unset", () => {
  const prev = process.env.COPILOT_BIN;
  try {
    delete process.env.COPILOT_BIN;
    const cli = resolveAgentCli({ override: "copilot" });
    assert.equal(cli.bin, "copilot");
  } finally {
    if (prev !== undefined) process.env.COPILOT_BIN = prev;
  }
});

test("buildArgs: TPM_AGENT_MODEL pins --model; unset leaves args untouched", () => {
  const before = AGENT_CLIS.claude.buildArgs("hi", "/repo");
  assert.ok(!before.includes("--model"));
  process.env.TPM_AGENT_MODEL = "claude-sonnet-5";
  try {
    const pinned = AGENT_CLIS.claude.buildArgs("hi", "/repo");
    assert.deepEqual(pinned.slice(-2), ["--model", "claude-sonnet-5"]);
    assert.deepEqual(AGENT_CLIS.copilot.buildArgs("hi", "/repo").slice(-2), ["--model", "claude-sonnet-5"]);
  } finally {
    delete process.env.TPM_AGENT_MODEL;
  }
});
