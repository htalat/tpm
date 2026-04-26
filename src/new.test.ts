import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTempDir, rmTempDir } from "./_test_helpers.ts";
import { newProject, newTask } from "./new.ts";
import { parse } from "./frontmatter.ts";

test("newProject: scaffolds project.md with substituted vars and tasks/notes dirs", () => {
  const root = mkTempDir();
  try {
    const path = newProject(root, "alpha", {
      name: "Alpha",
      repoRemote: "https://github.com/x/alpha.git",
      repoLocal: "/Users/x/alpha",
    });
    assert.equal(path, join(root, "alpha", "project.md"));
    assert.ok(existsSync(join(root, "alpha", "tasks")));
    assert.ok(existsSync(join(root, "alpha", "notes")));
    const { data } = parse(readFileSync(path, "utf8"));
    assert.equal(data.name, "Alpha");
    assert.equal(data.slug, "alpha");
    assert.equal(data.status, "active");
    assert.deepEqual(data.repo, {
      remote: "https://github.com/x/alpha.git",
      local: "/Users/x/alpha",
    });
  } finally {
    rmTempDir(root);
  }
});

test("newProject: humanizes slug when no name given", () => {
  const root = mkTempDir();
  try {
    const path = newProject(root, "my-cool-thing");
    const { data } = parse(readFileSync(path, "utf8"));
    assert.equal(data.name, "My Cool Thing");
  } finally {
    rmTempDir(root);
  }
});

test("newProject: rejects already-existing slug", () => {
  const root = mkTempDir();
  try {
    newProject(root, "alpha");
    assert.throws(() => newProject(root, "alpha"), /already exists/);
  } finally {
    rmTempDir(root);
  }
});

test("newProject: rejects invalid slugs", () => {
  const root = mkTempDir();
  try {
    for (const bad of ["Alpha", "-leading", "a b", "a/b", "", "foo!"]) {
      assert.throws(() => newProject(root, bad), /Invalid slug/, `expected reject for "${bad}"`);
    }
  } finally {
    rmTempDir(root);
  }
});

test("newProject: uses custom template from .tpm/templates/project.md if present", () => {
  const root = mkTempDir();
  try {
    mkdirSync(join(root, ".tpm", "templates"), { recursive: true });
    writeFileSync(
      join(root, ".tpm", "templates", "project.md"),
      "---\nname: {{name}}\nslug: {{slug}}\n---\nCUSTOM\n",
    );
    const path = newProject(root, "alpha", { name: "Alpha" });
    const text = readFileSync(path, "utf8");
    assert.match(text, /CUSTOM/);
  } finally {
    rmTempDir(root);
  }
});

function setupProject(root: string, slug: string): void {
  const dir = join(root, slug);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(
    join(dir, "project.md"),
    `---\nname: ${slug}\nslug: ${slug}\nstatus: active\n---\n# ${slug}\n`,
  );
}

test("newTask: rejects unknown project", () => {
  const root = mkTempDir();
  try {
    assert.throws(() => newTask(root, "missing", "x"), /Unknown project/);
  } finally {
    rmTempDir(root);
  }
});

test("newTask: rejects invalid task slugs", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    assert.throws(() => newTask(root, "alpha", "Bad-Slug"), /Invalid slug/);
  } finally {
    rmTempDir(root);
  }
});

test("newTask: numbers from 001 in an empty project", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    const path = newTask(root, "alpha", "first");
    assert.equal(path, join(root, "alpha", "tasks", "001-first.md"));
  } finally {
    rmTempDir(root);
  }
});

test("newTask: continues numbering after existing tasks", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    const tasksDir = join(root, "alpha", "tasks");
    writeFileSync(join(tasksDir, "001-one.md"), "x");
    writeFileSync(join(tasksDir, "002-two.md"), "x");
    const path = newTask(root, "alpha", "three");
    assert.equal(path, join(tasksDir, "003-three.md"));
  } finally {
    rmTempDir(root);
  }
});

test("newTask: auto-numbers across tasks/ and tasks/archive/", () => {
  // archived 005 should not be overwritten by a new 005.
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    const tasksDir = join(root, "alpha", "tasks");
    const archive = join(tasksDir, "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(tasksDir, "001-live.md"), "x");
    writeFileSync(join(archive, "005-old.md"), "x");
    const path = newTask(root, "alpha", "next");
    assert.equal(path, join(tasksDir, "006-next.md"));
  } finally {
    rmTempDir(root);
  }
});

test("newTask: substitutes title and slug into template", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    const path = newTask(root, "alpha", "do-stuff", "Do the stuff");
    const { data, body } = parse(readFileSync(path, "utf8"));
    assert.equal(data.title, "Do the stuff");
    assert.equal(data.slug, "do-stuff");
    assert.equal(data.project, "alpha");
    assert.equal(data.status, "open");
    assert.match(body, /# Do the stuff/);
  } finally {
    rmTempDir(root);
  }
});

test("newTask: humanizes title when none given", () => {
  const root = mkTempDir();
  try {
    setupProject(root, "alpha");
    const path = newTask(root, "alpha", "do-the-thing");
    const { data } = parse(readFileSync(path, "utf8"));
    assert.equal(data.title, "Do The Thing");
  } finally {
    rmTempDir(root);
  }
});
