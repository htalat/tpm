import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.ts";

test("markdown: paragraph", () => {
  assert.equal(renderMarkdown("hello world"), "<p>hello world</p>");
});

test("markdown: multi-line paragraph joins with space", () => {
  assert.equal(renderMarkdown("hello\nworld"), "<p>hello world</p>");
});

test("markdown: ATX headings 1-6", () => {
  assert.equal(renderMarkdown("# h1"),       "<h1>h1</h1>");
  assert.equal(renderMarkdown("## h2"),      "<h2>h2</h2>");
  assert.equal(renderMarkdown("###### h6"),  "<h6>h6</h6>");
});

test("markdown: unordered list with mixed bullets", () => {
  const out = renderMarkdown("- one\n- two\n* three\n+ four");
  assert.equal(out, "<ul><li>one</li><li>two</li><li>three</li><li>four</li></ul>");
});

test("markdown: ordered list", () => {
  const out = renderMarkdown("1. one\n2. two\n3. three");
  assert.equal(out, "<ol><li>one</li><li>two</li><li>three</li></ol>");
});

test("markdown: fenced code block (no language)", () => {
  const out = renderMarkdown("```\nlet x = 1;\n```");
  assert.equal(out, "<pre><code>let x = 1;</code></pre>");
});

test("markdown: fenced code block with language", () => {
  const out = renderMarkdown("```ts\nlet x: number = 1;\n```");
  assert.match(out, /<pre><code class="language-ts">let x: number = 1;<\/code><\/pre>/);
});

test("markdown: fenced code escapes HTML inside", () => {
  const out = renderMarkdown("```\n<script>alert(1)</script>\n```");
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("markdown: inline code spans", () => {
  const out = renderMarkdown("use `tpm next` here");
  assert.equal(out, "<p>use <code>tpm next</code> here</p>");
});

test("markdown: links", () => {
  const out = renderMarkdown("see [docs](https://example.com)");
  assert.equal(out, '<p>see <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>');
});

test("markdown: external links open in a new tab", () => {
  const out = renderMarkdown("see [PR](https://github.com/x/y/pull/1)");
  assert.match(out, /href="https:\/\/github\.com\/x\/y\/pull\/1" target="_blank" rel="noopener noreferrer"/);
});

test("markdown: internal links (root-relative) stay in-tab", () => {
  const out = renderMarkdown("see [task](/t/alpha/001)");
  assert.equal(out, '<p>see <a href="/t/alpha/001">task</a></p>');
  assert.doesNotMatch(out, /target="_blank"/);
});

test("markdown: anchor links stay in-tab", () => {
  const out = renderMarkdown("jump to [log](#log)");
  assert.equal(out, '<p>jump to <a href="#log">log</a></p>');
  assert.doesNotMatch(out, /target="_blank"/);
});

test("markdown: bold and italic", () => {
  const out = renderMarkdown("a **strong** and *em* word");
  assert.equal(out, "<p>a <strong>strong</strong> and <em>em</em> word</p>");
});

test("markdown: escapes raw HTML in paragraphs", () => {
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.equal(out, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("markdown: inline code preserves angle brackets without escaping inline code's contents twice", () => {
  const out = renderMarkdown("see `<task>` placeholder");
  assert.equal(out, "<p>see <code>&lt;task&gt;</code> placeholder</p>");
});

test("markdown: link URL is escaped (defense in depth)", () => {
  // Quote in the URL must be attribute-escaped — never raw in href.
  const out = renderMarkdown('[x](https://example.com/a"b)');
  assert.match(out, /href="https:\/\/example\.com\/a&quot;b"/);
  assert.doesNotMatch(out, /href="https:\/\/example\.com\/a"b"/);
});

test("markdown: blank lines separate paragraphs", () => {
  const out = renderMarkdown("first\n\nsecond");
  assert.equal(out, "<p>first</p>\n<p>second</p>");
});

test("markdown: heading then list (no merge)", () => {
  const out = renderMarkdown("## Plan\n- one\n- two");
  assert.equal(out, "<h2>Plan</h2>\n<ul><li>one</li><li>two</li></ul>");
});

test("markdown: nested list (single level)", () => {
  const out = renderMarkdown("- top\n  - nested\n- next");
  // Matters that nested becomes a child <ul>, not a sibling top-level item.
  assert.match(out, /<li>top<ul><li>nested<\/li><\/ul><\/li><li>next<\/li>/);
});

test("markdown: canonical table with leading/trailing pipes", () => {
  const out = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(
    out,
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("markdown: table without leading/trailing pipes", () => {
  const out = renderMarkdown("a | b\n--- | ---\n1 | 2");
  assert.equal(
    out,
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("markdown: table honors alignment markers", () => {
  const out = renderMarkdown("| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
  assert.match(out, /<th style="text-align:left">l<\/th>/);
  assert.match(out, /<th style="text-align:center">c<\/th>/);
  assert.match(out, /<th style="text-align:right">r<\/th>/);
  assert.match(out, /<td style="text-align:center">2<\/td>/);
});

test("markdown: table with an empty cell", () => {
  const out = renderMarkdown("| a | b |\n| --- | --- |\n| 1 |  |");
  assert.match(out, /<tbody><tr><td>1<\/td><td><\/td><\/tr><\/tbody>/);
});

test("markdown: table cell renders inline code and links", () => {
  const out = renderMarkdown("| cmd | doc |\n| --- | --- |\n| `tpm next` | [docs](https://example.com) |");
  assert.match(out, /<td><code>tpm next<\/code><\/td>/);
  assert.match(out, /<td><a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a><\/td>/);
});

test("markdown: table cell with escaped pipe keeps a literal pipe", () => {
  const out = renderMarkdown("| op | meaning |\n| --- | --- |\n| a \\| b | or |");
  assert.match(out, /<td>a \| b<\/td>/);
});

test("markdown: header row with no separator is a paragraph, not a table", () => {
  const out = renderMarkdown("| a | b |\nplain text");
  assert.doesNotMatch(out, /<table>/);
  assert.match(out, /^<p>/);
});

test("markdown: table immediately following a heading (no blank line)", () => {
  const out = renderMarkdown("## Matrix\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(
    out,
    "<h2>Matrix</h2>\n<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});
