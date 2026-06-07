import { test } from "node:test";
import assert from "node:assert/strict";
import { prShort, repoShort } from "./report.ts";

test("repoShort: github https URL", () => {
  assert.equal(repoShort("https://github.com/htalat/tpm"), "htalat/tpm");
});

test("repoShort: github https URL with .git suffix", () => {
  assert.equal(repoShort("https://github.com/htalat/tpm.git"), "htalat/tpm");
});

test("repoShort: github ssh URL", () => {
  assert.equal(repoShort("git@github.com:htalat/tpm.git"), "htalat/tpm");
});

test("repoShort: ADO repo URL", () => {
  assert.equal(
    repoShort("https://dev.azure.com/myorg/MyProject/_git/myrepo"),
    "myorg/myrepo",
  );
});

test("repoShort: ADO repo URL with trailing slash", () => {
  assert.equal(
    repoShort("https://dev.azure.com/myorg/MyProject/_git/myrepo/"),
    "myorg/myrepo",
  );
});

test("repoShort: unknown URL falls back to truncation", () => {
  assert.equal(repoShort("https://example.com/x"), "https://example.com/x");
});

test("prShort: github PR URL", () => {
  assert.equal(
    prShort("https://github.com/htalat/tpm/pull/27"),
    "htalat/tpm#27",
  );
});

test("prShort: ADO PR URL", () => {
  assert.equal(
    prShort("https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42"),
    "myorg/myrepo!42",
  );
});

test("prShort: ADO PR URL with extra path segments", () => {
  assert.equal(
    prShort("https://dev.azure.com/myorg/MyProject/_git/myrepo/pullrequest/42?_a=overview"),
    "myorg/myrepo!42",
  );
});

test("prShort: bare /pull/N falls back to #N", () => {
  assert.equal(prShort("https://example.com/foo/pull/9"), "#9");
});
