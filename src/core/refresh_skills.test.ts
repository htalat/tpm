import "./_test_helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRefreshEnv,
  defaultSourceRoot,
  refreshSkills,
  targetRoot,
  type RefreshEnv,
} from "./refresh_skills.ts";

// Build a sandboxed env that points sourceRoot at a fresh tmpdir and homeDir
// at another, so the real ~/.claude isn't touched. Returns the dirs so tests
// can populate them and assert against them.
function sandbox(platform: NodeJS.Platform): {
  env: RefreshEnv;
  source: string;
  home: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "tpm-refresh-skills-"));
  const source = join(root, "skills");
  const home = join(root, "home");
  mkdirSync(source, { recursive: true });
  mkdirSync(home, { recursive: true });
  const real = defaultRefreshEnv();
  return {
    env: { ...real, platform, sourceRoot: source, homeDir: home },
    source,
    home,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("defaultSourceRoot: resolves to <repo>/skills next to bin/, src/", () => {
  // The skills/ dir is sibling to src/ in this checkout; defaultSourceRoot
  // walks from src/refresh_skills.ts up one level to find it. This is the
  // contract the CLI relies on for a zero-arg `tpm refresh-skills`.
  const root = defaultSourceRoot();
  assert.ok(root.endsWith("/skills"), `expected /skills suffix, got ${root}`);
  assert.ok(existsSync(root), `defaultSourceRoot ${root} must exist for the CLI to work`);
});

test("targetRoot: resolves to <home>/.claude/skills", () => {
  assert.equal(targetRoot("/tmp/fake-home"), "/tmp/fake-home/.claude/skills");
});

test("refreshSkills (linux): symlinks each top-level skill dir", () => {
  const { env, source, home, cleanup } = sandbox("linux");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "# tpm skill\n");
    mkdirSync(join(source, "release"));
    writeFileSync(join(source, "release", "SKILL.md"), "# release skill\n");

    const entries = refreshSkills(env);

    const target = targetRoot(home);
    const tpmDest = join(target, "tpm");
    const releaseDest = join(target, "release");
    assert.ok(lstatSync(tpmDest).isSymbolicLink());
    assert.ok(lstatSync(releaseDest).isSymbolicLink());
    assert.equal(readlinkSync(tpmDest), join(source, "tpm"));
    assert.equal(readlinkSync(releaseDest), join(source, "release"));
    // SKILL.md is reachable through the link.
    assert.equal(readFileSync(join(tpmDest, "SKILL.md"), "utf8"), "# tpm skill\n");

    assert.deepEqual(
      entries.map(e => ({ name: e.name, action: e.action })).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: "release", action: "linked" },
        { name: "tpm", action: "linked" },
      ],
    );
  } finally { cleanup(); }
});

test("refreshSkills (darwin): same symlink behavior as linux", () => {
  const { env, source, home, cleanup } = sandbox("darwin");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "x\n");
    refreshSkills(env);
    assert.ok(lstatSync(join(home, ".claude", "skills", "tpm")).isSymbolicLink());
  } finally { cleanup(); }
});

test("refreshSkills (linux): idempotent — re-run on existing correct symlink leaves it alone", () => {
  const { env, source, home, cleanup } = sandbox("linux");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "v1\n");
    refreshSkills(env);
    const first = lstatSync(join(home, ".claude", "skills", "tpm")).mtimeMs;
    const entries = refreshSkills(env);
    assert.equal(entries[0].action, "unchanged");
    const second = lstatSync(join(home, ".claude", "skills", "tpm")).mtimeMs;
    assert.equal(first, second, "symlink should not be recreated on no-op refresh");
  } finally { cleanup(); }
});

test("refreshSkills (linux): replaces a symlink pointing to a stale source", () => {
  const { env, source, home, cleanup } = sandbox("linux");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "v1\n");
    const target = join(home, ".claude", "skills");
    mkdirSync(target, { recursive: true });
    // Pre-existing symlink to a different source (e.g. an old checkout path).
    symlinkSync("/tmp/old-tpm-checkout/skills/tpm", join(target, "tpm"));

    const entries = refreshSkills(env);
    assert.equal(entries[0].action, "linked");
    assert.equal(readlinkSync(join(target, "tpm")), join(source, "tpm"));
  } finally { cleanup(); }
});

test("refreshSkills (linux): replaces a real directory at the target (migrating from a copy install)", () => {
  const { env, source, home, cleanup } = sandbox("linux");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "v2\n");
    const target = join(home, ".claude", "skills", "tpm");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "stale copy\n");

    refreshSkills(env);
    const dest = join(home, ".claude", "skills", "tpm");
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readFileSync(join(dest, "SKILL.md"), "utf8"), "v2\n");
  } finally { cleanup(); }
});

test("refreshSkills (win32): recursively copies each skill dir", () => {
  const { env, source, home, cleanup } = sandbox("win32");
  try {
    mkdirSync(join(source, "tpm", "sub"), { recursive: true });
    writeFileSync(join(source, "tpm", "SKILL.md"), "# tpm\n");
    writeFileSync(join(source, "tpm", "sub", "extra.md"), "nested\n");

    const entries = refreshSkills(env);

    const target = join(home, ".claude", "skills", "tpm");
    assert.ok(!lstatSync(target).isSymbolicLink(), "win32 should produce a real dir, not a symlink");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "# tpm\n");
    assert.equal(readFileSync(join(target, "sub", "extra.md"), "utf8"), "nested\n");
    assert.equal(entries[0].action, "copied");
  } finally { cleanup(); }
});

test("refreshSkills (win32): re-run overwrites stale file contents", () => {
  const { env, source, home, cleanup } = sandbox("win32");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "v1\n");
    refreshSkills(env);
    writeFileSync(join(source, "tpm", "SKILL.md"), "v2 (edited)\n");
    refreshSkills(env);
    const dest = join(home, ".claude", "skills", "tpm", "SKILL.md");
    assert.equal(readFileSync(dest, "utf8"), "v2 (edited)\n");
  } finally { cleanup(); }
});

test("refreshSkills (win32): re-run drops files removed from source", () => {
  // The copy strategy wipes the dest tree before re-copying, so a file
  // deleted from source must not linger in the install. This is the whole
  // reason refresh-skills exists as a verb rather than a one-shot installer.
  const { env, source, home, cleanup } = sandbox("win32");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "x\n");
    writeFileSync(join(source, "tpm", "stale.md"), "old\n");
    refreshSkills(env);
    rmSync(join(source, "tpm", "stale.md"));
    refreshSkills(env);
    const dest = join(home, ".claude", "skills", "tpm");
    assert.ok(existsSync(join(dest, "SKILL.md")));
    assert.ok(!existsSync(join(dest, "stale.md")));
  } finally { cleanup(); }
});

test("refreshSkills: skips non-directory entries in source", () => {
  // skills/ might pick up a stray .DS_Store or README; only real skill dirs
  // (those containing a SKILL.md) should be installed.
  const { env, source, home, cleanup } = sandbox("linux");
  try {
    writeFileSync(join(source, ".DS_Store"), "junk\n");
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "ok\n");
    const entries = refreshSkills(env);
    assert.deepEqual(entries.map(e => e.name), ["tpm"]);
    assert.ok(!existsSync(join(home, ".claude", "skills", ".DS_Store")));
  } finally { cleanup(); }
});

test("refreshSkills: creates ~/.claude/skills/ if missing", () => {
  const { env, source, home, cleanup } = sandbox("linux");
  try {
    mkdirSync(join(source, "tpm"));
    writeFileSync(join(source, "tpm", "SKILL.md"), "x\n");
    // Note: ~/.claude doesn't exist yet in the sandbox.
    assert.ok(!existsSync(join(home, ".claude")));
    refreshSkills(env);
    assert.ok(existsSync(join(home, ".claude", "skills", "tpm")));
  } finally { cleanup(); }
});

test("refreshSkills: errors loudly if sourceRoot doesn't exist", () => {
  const root = mkdtempSync(join(tmpdir(), "tpm-refresh-skills-"));
  try {
    const real = defaultRefreshEnv();
    const env: RefreshEnv = {
      ...real,
      platform: "linux",
      sourceRoot: join(root, "does-not-exist"),
      homeDir: join(root, "home"),
    };
    assert.throws(() => refreshSkills(env), /source skills dir not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
