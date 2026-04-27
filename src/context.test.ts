import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { context, repoPath, resolveRepo } from "./context.ts";
import { loadProjects } from "./tree.ts";
import type { Project, Task } from "./tree.ts";

function makeProjectAndTask(overrides: {
  projectRepo?: { remote?: string; local?: string } | null;
  taskRepo?: { remote?: string; local?: string } | null;
} = {}): { project: Project; task: Task } {
  const project: Project = {
    slug: "p",
    path: "/x/p/project.md",
    dir: "/x/p",
    data: overrides.projectRepo === undefined
      ? {}
      : { repo: overrides.projectRepo },
    body: "",
    tasks: [],
  };
  const task: Task = {
    slug: "001-t",
    path: "/x/p/tasks/001-t.md",
    archived: false,
    data: overrides.taskRepo === undefined
      ? {}
      : { repo: overrides.taskRepo },
    body: "",
  };
  return { project, task };
}

test("resolveRepo: null when neither project nor task sets repo", () => {
  const { project, task } = makeProjectAndTask();
  assert.deepEqual(resolveRepo(project, task), { remote: null, local: null });
});

test("resolveRepo: falls back to project repo when task has none", () => {
  const { project, task } = makeProjectAndTask({
    projectRepo: { remote: "https://p", local: "/p" },
  });
  assert.deepEqual(resolveRepo(project, task), { remote: "https://p", local: "/p" });
});

test("resolveRepo: task overrides project per-field", () => {
  const { project, task } = makeProjectAndTask({
    projectRepo: { remote: "https://p", local: "/p" },
    taskRepo: { local: "/t" },
  });
  assert.deepEqual(resolveRepo(project, task), {
    remote: "https://p",
    local: "/t",
  });
});

test("resolveRepo: ignores non-object repo values", () => {
  const project: Project = {
    slug: "p", path: "/x", dir: "/x",
    data: { repo: "not-an-object" },
    body: "", tasks: [],
  };
  assert.deepEqual(resolveRepo(project), { remote: null, local: null });
});

// --- integration via context() / repoPath() against real files ---

function setup(root: string): void {
  // project alpha with no repo, project beta with repo, ambiguous task slug "shared"
  for (const slug of ["alpha", "beta"]) {
    const dir = join(root, slug);
    mkdirSync(join(dir, "tasks"), { recursive: true });
  }
  writeFileSync(
    join(root, "alpha", "project.md"),
    `---\nname: Alpha\nslug: alpha\nstatus: active\n---\n\n# Alpha\n\n## Goal\nAlpha goal.\n`,
  );
  writeFileSync(
    join(root, "beta", "project.md"),
    `---\nname: Beta\nslug: beta\nstatus: active\nrepo:\n  remote: https://example.com/beta.git\n  local: /tmp/beta\n---\n\n# Beta\n\n## Goal\nBeta goal.\n`,
  );
  // unique task slug "alpha-only" in alpha
  writeFileSync(
    join(root, "alpha", "tasks", "001-alpha-only.md"),
    `---\ntitle: Alpha only\nslug: alpha-only\nproject: alpha\nstatus: open\ntype: pr\n---\n\n# Alpha only\n\n## Context\nctx\n`,
  );
  // shared slug in both projects (ambiguous)
  for (const p of ["alpha", "beta"]) {
    writeFileSync(
      join(root, p, "tasks", "002-shared.md"),
      `---\ntitle: Shared\nslug: shared\nproject: ${p}\nstatus: open\ntype: pr\n---\n\n# Shared\n`,
    );
  }
  // task in beta with its own repo override
  writeFileSync(
    join(root, "beta", "tasks", "003-with-override.md"),
    `---\ntitle: Override\nslug: with-override\nproject: beta\nstatus: open\ntype: pr\nrepo:\n  local: /tmp/beta-override\n---\n\n# Override\n`,
  );
}

test("context: builds briefing for unique slug", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "alpha-only");
    assert.match(out, /# Task briefing: Alpha only/);
    assert.match(out, /Project: Alpha \(alpha\)/);
    assert.match(out, /Status: open  ·  Type: pr/);
    assert.match(out, /Alpha goal\./);
    assert.match(out, /## Working agreement/);
  } finally {
    rmTempDir(root);
  }
});

test("context: project/task disambiguates", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "beta/shared");
    assert.match(out, /Project: Beta \(beta\)/);
  } finally {
    rmTempDir(root);
  }
});

test("context: ambiguous slug throws with all matches listed", () => {
  const root = mkTempDir();
  try {
    setup(root);
    assert.throws(
      () => context(root, "shared"),
      (err: Error) => /Ambiguous task "shared"/.test(err.message)
        && /alpha\/002-shared/.test(err.message)
        && /beta\/002-shared/.test(err.message),
    );
  } finally {
    rmTempDir(root);
  }
});

test("context: unknown task throws", () => {
  const root = mkTempDir();
  try {
    setup(root);
    assert.throws(() => context(root, "no-such-task"), /No task matched/);
  } finally {
    rmTempDir(root);
  }
});

test("context: includes inherited project repo on the briefing", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "beta/shared");
    assert.match(out, /Repo: https:\/\/example\.com\/beta\.git/);
    assert.match(out, /Local: \/tmp\/beta/);
  } finally {
    rmTempDir(root);
  }
});

test("context: task-level repo override wins for local", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "beta/with-override");
    // remote inherited from project, local overridden by task
    assert.match(out, /Repo: https:\/\/example\.com\/beta\.git/);
    assert.match(out, /Local: \/tmp\/beta-override/);
  } finally {
    rmTempDir(root);
  }
});

test("context: workflow from project surfaces in briefing + working agreement names the doc", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\nworkflow: docs/agents.md\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.match(out, /Workflow: docs\/agents\.md/);
    assert.match(out, /follow the repo's workflow doc: read docs\/agents\.md/);
  } finally {
    rmTempDir(root);
  }
});

test("context: task-level workflow overrides project-level workflow", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\nworkflow: AGENTS.md\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\nworkflow: docs/special-flow.md\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.match(out, /Workflow: docs\/special-flow\.md/);
  } finally {
    rmTempDir(root);
  }
});

test("context: no workflow set -> working agreement names the fallback chain", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.doesNotMatch(out, /Workflow:/);
    assert.match(out, /look for AGENTS\.md, then CLAUDE\.md, in the repo root/);
    assert.match(out, /If no doc is found, ask before each step/);
  } finally {
    rmTempDir(root);
  }
});

test("repoPath: returns task-level local override", () => {
  const root = mkTempDir();
  try {
    setup(root);
    assert.equal(repoPath(root, "beta/with-override"), "/tmp/beta-override");
  } finally {
    rmTempDir(root);
  }
});

test("repoPath: falls back to project local for project-level query", () => {
  const root = mkTempDir();
  try {
    setup(root);
    assert.equal(repoPath(root, "beta"), "/tmp/beta");
  } finally {
    rmTempDir(root);
  }
});

test("repoPath: throws when no local set anywhere", () => {
  const root = mkTempDir();
  try {
    setup(root);
    assert.throws(() => repoPath(root, "alpha-only"), /No local path set/);
  } finally {
    rmTempDir(root);
  }
});

test("repoPath: throws on unknown query", () => {
  const root = mkTempDir();
  try {
    setup(root);
    assert.throws(() => repoPath(root, "nope"), /No project or task matched/);
  } finally {
    rmTempDir(root);
  }
});

test("findTask: matches by short slug (after numeric prefix)", () => {
  // unique short slug "alpha-only" via "001-alpha-only" filename
  const root = mkTempDir();
  try {
    setup(root);
    const projects = loadProjects(root);
    // Sanity: slug stored in tree is the filename minus .md
    assert.ok(projects[0].tasks.some(t => t.slug === "001-alpha-only"));
    // context should resolve the short form
    const out = context(root, "alpha-only");
    assert.match(out, /Alpha only/);
  } finally {
    rmTempDir(root);
  }
});
