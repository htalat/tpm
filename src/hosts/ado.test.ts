import { test } from "node:test";
import assert from "node:assert/strict";
import { ado, mapAdo, parseAdoUrl, type AdoPrJson, type AdoCi } from "./ado.ts";

const URL = "https://dev.azure.com/myorg/myproj/_git/myrepo/pullrequest/123";

function adoPr(extra: AdoPrJson = {}): AdoPrJson {
  return {
    pullRequestId: 123,
    status: "active",
    isDraft: false,
    url: URL,
    sourceRefName: "refs/heads/feature/x",
    ...extra,
  };
}

// ---- mapAdo: 5-variant compression in ADO's native dialect ----------------

test("mapAdo: status=completed -> merged (mergedAt from closedDate, body from description)", () => {
  const s = mapAdo(
    adoPr({
      status: "completed",
      title: "Ship it",
      description: "## Summary\nthings shipped",
      closedDate: "2026-05-10T19:00:00Z",
    }),
    [],
  );
  assert.deepEqual(s, {
    kind: "merged",
    url: URL,
    title: "Ship it",
    body: "## Summary\nthings shipped",
    mergedAt: "2026-05-10T19:00:00Z",
  });
});

test("mapAdo: status=abandoned -> abandoned", () => {
  assert.deepEqual(
    mapAdo(adoPr({ status: "abandoned", mergeStatus: "conflicts" }), []),
    { kind: "abandoned" },
  );
});

test("mapAdo: draft PR -> no-action even with conflicts / failed CI", () => {
  assert.deepEqual(
    mapAdo(
      adoPr({ isDraft: true, mergeStatus: "conflicts" }),
      [{ result: "failed" }],
    ),
    { kind: "no-action" },
  );
});

test("mapAdo: active PR with merge conflicts -> needs-agent", () => {
  const s = mapAdo(adoPr({ mergeStatus: "conflicts" }), []);
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /merge conflict on .*pullrequest\/123/);
});

test("mapAdo: latest pipeline run result=failed -> needs-agent", () => {
  const s = mapAdo(adoPr({ mergeStatus: "succeeded" }), [{ result: "failed", status: "completed" }]);
  assert.equal(s.kind, "needs-agent");
  if (s.kind === "needs-agent") assert.match(s.reason, /CI failed/);
});

test("mapAdo: reviewer vote=-10 (rejected) -> needs-human", () => {
  const s = mapAdo(
    adoPr({ reviewers: [{ vote: -10, displayName: "Alex" }, { vote: 0, displayName: "Sam" }] }),
    [],
  );
  assert.equal(s.kind, "needs-human");
  if (s.kind === "needs-human") {
    assert.match(s.reason, /vote=-10/);
    assert.match(s.reason, /Alex/);
  }
});

test("mapAdo: reviewer vote=-5 (waiting for author) -> needs-human", () => {
  // ADO -5 most closely maps to GitHub's COMMENTED *in tone* (a reviewer
  // saying "please revise") but it's the explicit "waiting for author"
  // signal — route to the human inbox, not the agent's rebase loop.
  const s = mapAdo(
    adoPr({ reviewers: [{ vote: -5, displayName: "Casey" }] }),
    [],
  );
  assert.equal(s.kind, "needs-human");
  if (s.kind === "needs-human") assert.match(s.reason, /vote=-5/);
});

test("mapAdo: reviewer vote=5 (approved with suggestions) -> no-action", () => {
  // Positive votes don't trigger the agent's feedback loop; suggestions are
  // optional. If they were blocking they'd come back as a -5 follow-up.
  assert.deepEqual(
    mapAdo(adoPr({ mergeStatus: "succeeded", reviewers: [{ vote: 5 }] }), []),
    { kind: "no-action" },
  );
});

test("mapAdo: vote precedence — -5 wins over conflict", () => {
  const s = mapAdo(
    adoPr({ mergeStatus: "conflicts", reviewers: [{ vote: -5, displayName: "Reviewer" }] }),
    [],
  );
  assert.equal(s.kind, "needs-human");
});

test("mapAdo: clean active PR -> no-action", () => {
  assert.deepEqual(
    mapAdo(
      adoPr({ mergeStatus: "succeeded", reviewers: [{ vote: 10 }] }),
      [{ result: "succeeded" }],
    ),
    { kind: "no-action" },
  );
});

test("mapAdo: urlHint fills in when pr.url is empty", () => {
  const s = mapAdo(
    adoPr({ url: undefined, status: "completed", title: "T", description: "" }),
    [],
    URL,
  );
  assert.equal(s.kind, "merged");
  if (s.kind === "merged") assert.equal(s.url, URL);
});

// ---- parseAdoUrl + ado.parse / ado.matches --------------------------------

test("parseAdoUrl: extracts org/project/repo/id", () => {
  assert.deepEqual(parseAdoUrl(URL), {
    org: "myorg",
    project: "myproj",
    repo: "myrepo",
    id: 123,
  });
});

test("parseAdoUrl: returns null for non-ADO URLs", () => {
  assert.equal(parseAdoUrl("https://github.com/o/r/pull/1"), null);
  assert.equal(parseAdoUrl(""), null);
});

test("ado.matches: ADO PR URLs only", () => {
  assert.ok(ado.matches(URL));
  assert.ok(!ado.matches("https://github.com/htalat/tpm/pull/1"));
  assert.ok(!ado.matches("https://dev.azure.com/o/p/_git/r/issue/9"));
});

test("ado.parse: cachePath is host-namespaced (ado/...) and displayId is !N", () => {
  const ref = ado.parse(URL);
  assert.deepEqual(ref, {
    host: "ado",
    cachePath: "ado/myorg/myproj/myrepo/123.json",
    displayId: "!123",
  });
});

test("ado.parse: returns null for non-ADO URLs", () => {
  assert.equal(ado.parse("https://github.com/x/y/pull/1"), null);
});
