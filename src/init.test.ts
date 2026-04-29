// Side-effect: re-home this process so init writes its config under a
// throwaway HOME, not the user's real ~/.tpm.
import "./_test_helpers.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, CONFIG_PATH, DEFAULT_TIMEZONE, readConfig } from "./config.ts";
import { init } from "./init.ts";

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

test("init: creates root, reports/, .tpm/templates/, and writes config", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    const result = init(target);
    assert.equal(result.root, target);
    assert.equal(result.configPath, CONFIG_PATH);
    assert.ok(existsSync(target));
    assert.ok(existsSync(join(target, "reports")));
    assert.ok(existsSync(join(target, ".tpm", "templates", "project.md")));
    assert.ok(existsSync(join(target, ".tpm", "templates", "task.md")));
    const cfg = readConfig();
    assert.equal(cfg.root, target);
    assert.equal(cfg.timezone, DEFAULT_TIMEZONE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: created list lists every newly-made path", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    const { created } = init(target);
    // Directories appear with trailing slash; templates are bare paths.
    assert.ok(created.includes(target + "/"));
    assert.ok(created.includes(join(target, "reports") + "/"));
    assert.ok(created.includes(join(target, ".tpm", "templates") + "/"));
    assert.ok(created.includes(join(target, ".tpm", "templates", "project.md")));
    assert.ok(created.includes(join(target, ".tpm", "templates", "task.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: idempotent — second run creates nothing new", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    init(target);
    const second = init(target);
    assert.deepEqual(second.created, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: preserves existing timezone in config on re-run", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    init(target);
    // User customizes timezone, then re-runs init.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ root: target, timezone: "Europe/Berlin" }, null, 2) + "\n",
    );
    init(target);
    assert.equal(readConfig().timezone, "Europe/Berlin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: re-run after deleting one template restores it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    init(target);
    const taskTpl = join(target, ".tpm", "templates", "task.md");
    rmSync(taskTpl);
    const second = init(target);
    assert.ok(existsSync(taskTpl));
    assert.deepEqual(second.created, [taskTpl]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: project.md template contains the expected frontmatter shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    init(target);
    const tpl = readFileSync(join(target, ".tpm", "templates", "project.md"), "utf8");
    assert.match(tpl, /name: \{\{name\}\}/);
    assert.match(tpl, /slug: \{\{slug\}\}/);
    assert.match(tpl, /repo:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: project.md template includes ## Log for project-level timeline", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpm-init-"));
  try {
    const target = join(dir, "tree");
    init(target);
    const tpl = readFileSync(join(target, ".tpm", "templates", "project.md"), "utf8");
    assert.match(tpl, /^## Log$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
