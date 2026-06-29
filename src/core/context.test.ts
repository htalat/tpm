import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { context, repoPath, resolveRepo, trimTaskBody } from "./context.ts";
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
    assert.match(out, /^- Type: pr$/m);
    assert.match(out, /Alpha goal\./);
    assert.match(out, /## Working agreement/);
  } finally {
    rmTempDir(root);
  }
});

test("context: drops File / Status / Created / Closed metadata lines", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\ncreated: 2026-05-16 21:10 PDT\nclosed: 2026-05-17 09:00 PDT\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.doesNotMatch(out, /^- File:/m);
    assert.doesNotMatch(out, /^- Status:/m);
    assert.doesNotMatch(out, /Status: open/);
    assert.doesNotMatch(out, /^- Created:/m);
    assert.doesNotMatch(out, /^- Closed:/m);
    // Type still present on its own line.
    assert.match(out, /^- Type: pr$/m);
  } finally {
    rmTempDir(root);
  }
});

test("context: omits PRs line when prs is empty", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "alpha-only");
    assert.doesNotMatch(out, /^- PRs:/m);
  } finally {
    rmTempDir(root);
  }
});

test("context: renders PRs line when prs is non-empty", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: needs-review\ntype: pr\nprs:\n  - https://github.com/example/repo/pull/42\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.match(out, /^- PRs: https:\/\/github\.com\/example\/repo\/pull\/42$/m);
  } finally {
    rmTempDir(root);
  }
});

test("context: strips ## Log section from task body", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\n---\n\n# T\n\n## Plan\nDo the thing.\n\n## Log\n- 2026-05-16 21:10 PDT: created\n- 2026-05-16 21:11 PDT: promoted to ready\n\n## Outcome\n<!-- Filled when closed: ... -->\n`,
    );
    const out = context(root, "p/t");
    assert.doesNotMatch(out, /## Log/);
    assert.doesNotMatch(out, /promoted to ready/);
    // Plan content survives.
    assert.match(out, /## Plan\nDo the thing\./);
  } finally {
    rmTempDir(root);
  }
});

test("context: strips placeholder-only ## Outcome section but keeps non-empty one", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    // Empty Outcome — should be stripped.
    writeFileSync(
      join(root, "p", "tasks", "001-empty.md"),
      `---\ntitle: Empty\nslug: empty\nproject: p\nstatus: open\ntype: pr\n---\n\n# Empty\n\n## Plan\nWork.\n\n## Outcome\n<!-- Filled when closed: what shipped, what changed, what we learned -->\n`,
    );
    // Real Outcome — should be retained.
    writeFileSync(
      join(root, "p", "tasks", "002-real.md"),
      `---\ntitle: Real\nslug: real\nproject: p\nstatus: done\ntype: pr\n---\n\n# Real\n\n## Plan\nWork.\n\n## Outcome\nShipped X, learned Y.\n`,
    );
    const emptyOut = context(root, "p/empty");
    assert.doesNotMatch(emptyOut, /## Outcome/);
    assert.doesNotMatch(emptyOut, /Filled when closed/);
    const realOut = context(root, "p/real");
    assert.match(realOut, /## Outcome\nShipped X, learned Y\./);
  } finally {
    rmTempDir(root);
  }
});

test("trimTaskBody: drops Log, drops empty Outcome, keeps real Outcome", () => {
  const withLogOnly = `# T\n\n## Plan\nWork.\n\n## Log\n- 2026: x\n`;
  assert.equal(trimTaskBody(withLogOnly), `# T\n\n## Plan\nWork.`);

  const withEmptyOutcome = `# T\n\n## Plan\nWork.\n\n## Outcome\n<!-- placeholder -->\n`;
  assert.equal(trimTaskBody(withEmptyOutcome), `# T\n\n## Plan\nWork.`);

  const withRealOutcome = `# T\n\n## Plan\nWork.\n\n## Outcome\nShipped.\n`;
  assert.equal(trimTaskBody(withRealOutcome), `# T\n\n## Plan\nWork.\n\n## Outcome\nShipped.`);

  const logBetweenSections = `# T\n\n## Plan\nWork.\n\n## Log\n- a\n- b\n\n## Outcome\nReal outcome.\n`;
  assert.equal(
    trimTaskBody(logBetweenSections),
    `# T\n\n## Plan\nWork.\n\n## Outcome\nReal outcome.`,
  );
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

test("context: defaults Host to github when project doesn't set host", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "alpha-only");
    assert.match(out, /^- Host: github$/m);
  } finally {
    rmTempDir(root);
  }
});

test("context: surfaces explicit host: ado from project frontmatter", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "ado-proj", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "ado-proj", "project.md"),
      `---\nname: ADO\nslug: ado-proj\nstatus: active\nhost: ado\n---\n\n# ADO\n\n## Goal\n.\n`,
    );
    writeFileSync(
      join(root, "ado-proj", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: ado-proj\nstatus: open\ntype: pr\n---\n\n# T\n`,
    );
    const out = context(root, "ado-proj/t");
    assert.match(out, /^- Host: ado$/m);
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

test("context: inlines the project's Notes section verbatim, labelled as conventions", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n\n## Goal\nShip P.\n\n## Notes\nWork from \`dist/\`, branch off \`master\`, validate with \`node serve.js\`.\n\n## Log\n- 2026: x\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.match(out, /### Project notes \(conventions/);
    assert.match(out, /Work from `dist\/`, branch off `master`, validate with `node serve\.js`\./);
    // The Log section is project-internal — not part of the briefing.
    assert.doesNotMatch(out, /## Log/);
  } finally {
    rmTempDir(root);
  }
});

test("context: omits the Notes section when it holds only its scaffold placeholder", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n\n## Goal\nShip P.\n\n## Notes\n<!-- Living notes, decisions, open questions -->\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.doesNotMatch(out, /Project notes/);
  } finally {
    rmTempDir(root);
  }
});

test("context: container task lists its children with qualified refs + status", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks", "002-parent"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "002-parent", "task.md"),
      `---\ntitle: Parent\nslug: parent\nproject: p\nstatus: in-progress\ntype: pr\n---\n\n# Parent\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "002-parent", "002-child.md"),
      `---\ntitle: A child task\nslug: child\nproject: p\nparent: 002-parent\nstatus: ready\ntype: pr\n---\n\n# A child task\n`,
    );
    const out = context(root, "p/parent");
    assert.match(out, /### Children/);
    assert.match(out, /This task is a container/);
    assert.match(out, /- p\/002-parent\/002-child — A child task \[ready\]/);
  } finally {
    rmTempDir(root);
  }
});

test("context: leaf task has no Children section", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "alpha-only");
    assert.doesNotMatch(out, /### Children/);
  } finally {
    rmTempDir(root);
  }
});

test("context: working agreement names CLI verbs, not direct task-file edits", () => {
  const root = mkTempDir();
  try {
    setup(root);
    const out = context(root, "alpha-only");
    assert.match(out, /`tpm log alpha\/001-alpha-only "/);
    assert.match(out, /`tpm pr alpha\/001-alpha-only <url>`/);
    assert.match(out, /`tpm complete alpha\/001-alpha-only`/);
    // No instruction to hand-edit the Log / frontmatter / prs of the task file.
    assert.doesNotMatch(out, /Append progress to the "Log" section/);
    assert.doesNotMatch(out, /set status: done in the frontmatter/);
    assert.doesNotMatch(out, /append its URL to the prs: list/);
    // The task-file path is never emitted as an edit target.
    assert.doesNotMatch(out, /001-alpha-only\.md/);
  } finally {
    rmTempDir(root);
  }
});

test("context: investigation task's working agreement points at tpm report, not tpm pr", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: investigation\n---\n\n# T\n`,
    );
    const out = context(root, "p/t");
    assert.match(out, /`tpm report p\/001-t`/);
    assert.doesNotMatch(out, /tpm pr /);
  } finally {
    rmTempDir(root);
  }
});

test("context: child task's working agreement uses the fully-qualified child ref", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, "p", "tasks", "002-parent"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "002-parent", "task.md"),
      `---\ntitle: Parent\nslug: parent\nproject: p\nstatus: in-progress\ntype: pr\n---\n\n# Parent\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "002-parent", "002-child.md"),
      `---\ntitle: Child\nslug: child\nproject: p\nparent: 002-parent\nstatus: ready\ntype: pr\n---\n\n# Child\n`,
    );
    const out = context(root, "p/parent/child");
    assert.match(out, /`tpm log p\/002-parent\/002-child "/);
  } finally {
    rmTempDir(root);
  }
});

test("context: surfaces the repo's current branch + clean/dirty state", () => {
  const root = mkTempDir();
  const repo = mkTempDir();
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x",
          GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x",
        },
      });
    git(["init", "--initial-branch=main", "--quiet"]);
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(["add", "."]);
    git(["commit", "-m", "init", "--quiet"]);

    mkdirSync(join(root, "p", "tasks"), { recursive: true });
    writeFileSync(
      join(root, "p", "project.md"),
      `---\nname: P\nslug: p\nstatus: active\nrepo:\n  local: ${repo}\n---\n\n# P\n`,
    );
    writeFileSync(
      join(root, "p", "tasks", "001-t.md"),
      `---\ntitle: T\nslug: t\nproject: p\nstatus: open\ntype: pr\n---\n\n# T\n`,
    );

    const clean = context(root, "p/t");
    assert.match(clean, /^- Branch: main \(clean\)$/m);

    writeFileSync(join(repo, "README.md"), "changed\n");
    const dirty = context(root, "p/t");
    assert.match(dirty, /^- Branch: main \(dirty — uncommitted changes\)$/m);
  } finally {
    rmTempDir(root);
    rmTempDir(repo);
  }
});

test("context: no Branch line when repo.local is not a git repo", () => {
  const root = mkTempDir();
  try {
    setup(root);
    // beta's repo.local is /tmp/beta — not a real git repo.
    const out = context(root, "beta/shared");
    assert.doesNotMatch(out, /^- Branch:/m);
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
