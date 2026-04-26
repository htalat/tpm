import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "./frontmatter.ts";

test("parse: returns empty data and original body when no frontmatter", () => {
  const text = "# just a heading\n\nbody text\n";
  const { data, body } = parse(text);
  assert.deepEqual(data, {});
  assert.equal(body, text);
});

test("parse: scalars (string, number, boolean, null, dates)", () => {
  const text = `---
title: Hello world
count: 42
ratio: 1.5
done: true
draft: false
closed:
explicit_null: null
tilde: ~
---
body
`;
  const { data } = parse(text);
  assert.equal(data.title, "Hello world");
  assert.equal(data.count, 42);
  assert.equal(data.ratio, 1.5);
  assert.equal(data.done, true);
  assert.equal(data.draft, false);
  assert.equal(data.closed, null);
  assert.equal(data.explicit_null, null);
  assert.equal(data.tilde, null);
});

test("parse: quoted strings preserve content (single and double)", () => {
  const text = `---
double: "hello: world"
single: 'a, b, c'
empty: ""
---
`;
  const { data } = parse(text);
  assert.equal(data.double, "hello: world");
  assert.equal(data.single, "a, b, c");
  assert.equal(data.empty, "");
});

test("parse: flow list", () => {
  const { data } = parse(`---
tags: [a, b, c]
empty: []
mixed: [1, "two", true]
---
`);
  assert.deepEqual(data.tags, ["a", "b", "c"]);
  assert.deepEqual(data.empty, []);
  assert.deepEqual(data.mixed, [1, "two", true]);
});

test("parse: flow list with quoted strings containing commas", () => {
  const { data } = parse(`---
items: ["a, b", "c"]
---
`);
  assert.deepEqual(data.items, ["a, b", "c"]);
});

test("parse: block list", () => {
  const { data } = parse(`---
prs:
  - https://example.com/1
  - https://example.com/2
---
`);
  assert.deepEqual(data.prs, ["https://example.com/1", "https://example.com/2"]);
});

test("parse: block map (single level nested)", () => {
  const { data } = parse(`---
repo:
  remote: https://github.com/htalat/tpm.git
  local: /Users/x/Developer/tpm
---
`);
  assert.deepEqual(data.repo, {
    remote: "https://github.com/htalat/tpm.git",
    local: "/Users/x/Developer/tpm",
  });
});

test("parse: empty key produces null when no children follow", () => {
  const { data } = parse(`---
closed:
prs: []
---
`);
  assert.equal(data.closed, null);
  assert.deepEqual(data.prs, []);
});

test("parse: comments and blank lines are ignored", () => {
  const { data } = parse(`---
# leading comment
title: test

# another
count: 1
---
`);
  assert.equal(data.title, "test");
  assert.equal(data.count, 1);
});

test("parse: Windows (CRLF) line endings", () => {
  const text = "---\r\ntitle: hi\r\ntags: [a, b]\r\n---\r\nbody\r\n";
  const { data, body } = parse(text);
  assert.equal(data.title, "hi");
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.equal(body, "body\r\n");
});

test("parse: empty body is preserved as empty string", () => {
  const { body } = parse(`---
title: x
---
`);
  assert.equal(body, "");
});

test("parse: malformed frontmatter (no closing ---) returns empty data", () => {
  const text = `---
title: x
no closing fence
`;
  const { data, body } = parse(text);
  assert.deepEqual(data, {});
  assert.equal(body, text);
});

test("parse: lines that don't match key:value are skipped", () => {
  const { data } = parse(`---
this is not a key
title: ok
---
`);
  assert.equal(data.title, "ok");
  assert.ok(!("this is not a key" in data));
});

test("stringify: scalars round-trip", () => {
  const data = { title: "Hello", count: 42, done: true, closed: null };
  const text = stringify(data, "body\n");
  const { data: parsed, body } = parse(text);
  assert.deepEqual(parsed, data);
  assert.equal(body, "body\n");
});

test("stringify: empty array renders as []", () => {
  const text = stringify({ tags: [] }, "");
  assert.match(text, /tags: \[\]/);
});

test("stringify: nested map renders as block", () => {
  const text = stringify(
    { repo: { remote: "https://x", local: "/a/b" } },
    "",
  );
  assert.match(text, /repo:\n {2}remote: https:\/\/x\n {2}local: \/a\/b/);
});

test("stringify: preserves key order", () => {
  const text = stringify(
    { z: 1, a: 2, m: 3 },
    "",
  );
  const order = text.split("\n").filter(l => /^[a-z]:/.test(l)).map(l => l[0]);
  assert.deepEqual(order, ["z", "a", "m"]);
});

test("stringify: quotes strings that need it", () => {
  const text = stringify({ s: "hello, world" }, "");
  assert.match(text, /s: "hello, world"/);
  const text2 = stringify({ s: "" }, "");
  assert.match(text2, /s: ""/);
});

test("stringify: leaves safe strings unquoted", () => {
  const text = stringify(
    { url: "https://example.com/path", date: "2026-04-26 10:22 PDT" },
    "",
  );
  assert.match(text, /url: https:\/\/example\.com\/path/);
  assert.match(text, /date: 2026-04-26 10:22 PDT/);
});

test("round-trip: tpm-shaped frontmatter", () => {
  const data = {
    title: "Add a test suite",
    slug: "test-suite",
    project: "tpm",
    status: "in-progress",
    type: "pr",
    created: "2026-04-26 00:38 PDT",
    closed: null,
    prs: ["https://github.com/htalat/tpm/pull/9"],
    tags: [],
    repo: { remote: "https://github.com/htalat/tpm.git", local: "/x/y" },
  };
  const body = "\n# Title\n\n## Context\nstuff\n";
  const text = stringify(data, body);
  const reparsed = parse(text);
  assert.deepEqual(reparsed.data, data);
  // Body is preserved (the leading newline is normalized but content matches).
  assert.equal(reparsed.body.trim(), body.trim());
});

test("round-trip: parse → stringify → parse is idempotent on data", () => {
  const original = `---
title: Sample
slug: s
status: open
prs: []
tags: [x, y]
repo:
  remote: https://e.com
  local: /p
---

body here
`;
  const first = parse(original);
  const restringified = stringify(first.data, first.body);
  const second = parse(restringified);
  assert.deepEqual(second.data, first.data);
  assert.equal(second.body, first.body);
});
