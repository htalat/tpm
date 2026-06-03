import { test } from "node:test";
import assert from "node:assert/strict";
import { taskPath, taskDeepLink } from "./serve_url.ts";
import type { Project, Task } from "./tree.ts";

function task(slug: string, parent?: string): Task {
  return { slug, path: `/tmp/${slug}.md`, archived: false, data: { slug, status: "ready", ...(parent ? { parent } : {}) }, body: "", parent };
}

function project(slug: string): Project {
  return { slug, path: `/tmp/${slug}/project.md`, dir: `/tmp/${slug}`, data: { slug, status: "active" }, body: "", tasks: [] };
}

test("taskPath: top-level task → /t/<project>/<slug>", () => {
  assert.equal(taskPath(project("tpm"), task("130-foo")), "/t/tpm/130-foo");
});

test("taskPath: child task includes the parent segment", () => {
  assert.equal(taskPath(project("tpm"), task("003-child", "002-parent")), "/t/tpm/002-parent/003-child");
});

test("taskPath: URL-encodes reserved characters in a segment", () => {
  // tpm slugs are [a-z0-9-], but the builder must stay correct if one isn't.
  assert.equal(taskPath(project("a b"), task("x/y")), "/t/a%20b/x%2Fy");
});

test("taskDeepLink: joins base + path", () => {
  assert.equal(
    taskDeepLink("http://127.0.0.1:7777", project("tpm"), task("130-foo")),
    "http://127.0.0.1:7777/t/tpm/130-foo",
  );
});

test("taskDeepLink: drops a trailing slash on the base so we don't emit //t/", () => {
  assert.equal(
    taskDeepLink("http://127.0.0.1:7777/", project("tpm"), task("130-foo")),
    "http://127.0.0.1:7777/t/tpm/130-foo",
  );
});
