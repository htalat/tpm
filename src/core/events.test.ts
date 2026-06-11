import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { appendStatusEvent, eventsPath, readRecentEvents } from "./events.ts";
import type { Task } from "./tree.ts";

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: "001-a",
    path: "/nonexistent/001-a.md",
    archived: false,
    data: { project: "alpha" },
    body: "",
    ...overrides,
  };
}

test("appendStatusEvent: writes one NDJSON line with qualified slug + actor", () => {
  const root = mkTempDir();
  const prevAgentId = process.env.TPM_AGENT_ID;
  delete process.env.TPM_AGENT_ID;
  try {
    appendStatusEvent(root, { task: fakeTask(), from: "ready", to: "in-progress", verb: "started" });
    const lines = readFileSync(eventsPath(root), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.task, "alpha/001-a");
    assert.equal(rec.from, "ready");
    assert.equal(rec.to, "in-progress");
    assert.equal(rec.verb, "started");
    assert.equal(rec.actor, "cli");
    assert.ok(!Number.isNaN(Date.parse(rec.at)), `at not ISO: ${rec.at}`);
  } finally {
    if (prevAgentId !== undefined) process.env.TPM_AGENT_ID = prevAgentId;
    rmTempDir(root);
  }
});

test("appendStatusEvent: child tasks journal project/parent/slug; TPM_AGENT_ID becomes actor", () => {
  const root = mkTempDir();
  const prevAgentId = process.env.TPM_AGENT_ID;
  process.env.TPM_AGENT_ID = "worker-2";
  try {
    appendStatusEvent(root, {
      task: fakeTask({ slug: "002-b", parent: "001-a" }),
      from: "in-progress",
      to: "needs-review",
      verb: "PR opened",
    });
    const rec = JSON.parse(readFileSync(eventsPath(root), "utf8").trim());
    assert.equal(rec.task, "alpha/001-a/002-b");
    assert.equal(rec.actor, "worker-2");
  } finally {
    if (prevAgentId !== undefined) process.env.TPM_AGENT_ID = prevAgentId;
    else delete process.env.TPM_AGENT_ID;
    rmTempDir(root);
  }
});

test("appendStatusEvent: appends, never truncates; creates .tpm dir on demand", () => {
  const root = mkTempDir();
  try {
    assert.ok(!existsSync(eventsPath(root)));
    appendStatusEvent(root, { task: fakeTask(), from: "open", to: "ready", verb: "promoted to ready" });
    appendStatusEvent(root, { task: fakeTask(), from: "ready", to: "in-progress", verb: "started" });
    const lines = readFileSync(eventsPath(root), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).to, "ready");
    assert.equal(JSON.parse(lines[1]).to, "in-progress");
  } finally {
    rmTempDir(root);
  }
});

test("readRecentEvents: empty when no journal exists", () => {
  const root = mkTempDir();
  try {
    assert.deepEqual(readRecentEvents(root, 5), []);
  } finally {
    rmTempDir(root);
  }
});

test("readRecentEvents: newest-first, honors limit, skips unparseable lines", () => {
  const root = mkTempDir();
  try {
    for (let i = 1; i <= 5; i++) {
      appendStatusEvent(root, { task: fakeTask(), from: "open", to: "ready", verb: `v${i}` });
    }
    // Torn / hand-edited line in the middle of the journal must not break the tail.
    appendFileSync(eventsPath(root), "not json\n");
    appendStatusEvent(root, { task: fakeTask(), from: "ready", to: "in-progress", verb: "v6" });

    const recent = readRecentEvents(root, 3);
    assert.equal(recent.length, 3);
    assert.deepEqual(recent.map(e => e.verb), ["v6", "v5", "v4"], "newest first");
    assert.equal(recent[0].to, "in-progress");
  } finally {
    rmTempDir(root);
  }
});
