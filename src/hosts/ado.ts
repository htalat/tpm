// Azure DevOps PR host adapter.
//
// ADO's wire shape differs fundamentally from GitHub's: PR state lives in
// `status` (active/completed/abandoned), merge state in `mergeStatus`
// (succeeded/conflicts/...), reviewer disposition in a `vote` integer
// (-10 rejected / -5 waiting / 0 / 5 approved-with-suggestions / 10 approved),
// and CI is a separate `az pipelines runs list` call against the source
// branch. Normalizing that into the GitHub-shape JSON would lose intent
// (vote=-5 nearest GitHub COMMENTED, but the actual meaning is "please
// revise" — should flip to needs-agent, not no-action). So this adapter
// reads ADO fields in their native dialect and emits the same coarse
// PrSignal the GitHub adapter does.

import { execSync } from "node:child_process";
import type { FetchedSignal, PrHost, PrRef, PrSignal } from "./types.ts";

const URL_RE =
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i;

export interface AdoPrJson {
  pullRequestId?: number;
  status?: string;           // 'active' | 'completed' | 'abandoned'
  mergeStatus?: string;      // 'succeeded' | 'conflicts' | 'queued' | 'rejectedByPolicy' | ...
  isDraft?: boolean;
  closedDate?: string;
  creationDate?: string;
  title?: string;
  description?: string;
  url?: string;
  sourceRefName?: string;    // e.g. 'refs/heads/feature/foo'
  reviewers?: Array<{ vote?: number; displayName?: string }>;
}

export interface AdoCiRun {
  result?: string;           // 'succeeded' | 'failed' | 'canceled' | 'partiallySucceeded'
  status?: string;           // 'completed' | 'inProgress' | ...
}

export type AdoCi = AdoCiRun[];

// Compress an ADO PR + recent pipeline run into the coarse PrSignal.
//
// Priority inside a single PR: completed → merged > abandoned > non-actionable
// (draft / unknown status) > human-blocking (vote <= -5; covers both -10
// "rejected" and -5 "waiting for author") > agent-actionable (conflicts >
// CI red) > no-action. `urlHint` lets the caller pass the original URL when
// the wire JSON omits `url` (older `az` versions).
export function mapAdo(pr: AdoPrJson, ci: AdoCi, urlHint?: string): PrSignal {
  const status = (pr.status ?? "").toLowerCase();
  const url = pr.url || urlHint || "";

  if (status === "completed") {
    return {
      kind: "merged",
      url,
      title: pr.title ?? "",
      body: pr.description ?? "",
      mergedAt: pr.closedDate ?? "",
    };
  }
  if (status === "abandoned") return { kind: "abandoned" };
  if (status !== "active" || pr.isDraft === true) return { kind: "no-action" };

  const merge = (pr.mergeStatus ?? "").toLowerCase();
  const conflicting = merge === "conflicts";
  const ciFailed = (ci ?? []).some(
    (r) => (r.result ?? "").toLowerCase() === "failed",
  );

  let minVote = 0;
  let minVoter = "";
  for (const r of pr.reviewers ?? []) {
    const v = typeof r.vote === "number" ? r.vote : 0;
    if (v < minVote) {
      minVote = v;
      minVoter = r.displayName ?? "";
    }
  }

  const ref = url || "<unknown>";

  if (minVote <= -5) {
    const who = minVoter ? ` from ${minVoter}` : "";
    return { kind: "needs-human", reason: `vote=${minVote}${who} on ${ref}` };
  }
  if (conflicting) return { kind: "needs-agent", reason: `merge conflict on ${ref}` };
  if (ciFailed) return { kind: "needs-agent", reason: `CI failed on ${ref}` };

  return { kind: "no-action" };
}

export interface AdoUrlParts {
  org: string;
  project: string;
  repo: string;
  id: number;
}

export function parseAdoUrl(url: string): AdoUrlParts | null {
  const m = url.match(URL_RE);
  if (!m) return null;
  return { org: m[1], project: m[2], repo: m[3], id: Number(m[4]) };
}

export const ado: PrHost = {
  name: "ado",

  matches: (url) => URL_RE.test(url),

  parse(url) {
    const parts = parseAdoUrl(url);
    if (!parts) return null;
    const ref: PrRef = {
      host: "ado",
      // `ado/...` prefix keeps ADO snapshots strictly under their own subtree
      // so they can't collide with existing GitHub `<owner>/<repo>/<n>.json`.
      cachePath: `ado/${parts.org}/${parts.project}/${parts.repo}/${parts.id}.json`,
      displayId: `!${parts.id}`,
    };
    return ref;
  },

  async fetchSignal(url): Promise<FetchedSignal> {
    if (!hasCli("az")) {
      throw new Error("az CLI not found on PATH");
    }
    const parts = parseAdoUrl(url);
    if (!parts) throw new Error(`not an ADO PR URL: ${url}`);
    const orgUrl = `https://dev.azure.com/${parts.org}`;
    const prOut = execSync(
      `az repos pr show --id ${parts.id} --org ${shq(orgUrl)} --output json`,
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
    const pr = JSON.parse(prOut) as AdoPrJson;

    // CI is a second call. Best-effort — if it fails (no pipelines wired up
    // for this repo, auth scope missing for the pipelines endpoint) we
    // proceed with empty CI and let the rest of the signal carry.
    let ci: AdoCi = [];
    const branch = (pr.sourceRefName ?? "").replace(/^refs\/heads\//, "");
    if (branch) {
      try {
        const ciOut = execSync(
          `az pipelines runs list --org ${shq(orgUrl)} --project ${shq(parts.project)} --branch ${shq(branch)} --top 1 --output json`,
          { stdio: ["ignore", "pipe", "pipe"] },
        ).toString();
        const parsed = JSON.parse(ciOut) as unknown;
        if (Array.isArray(parsed)) ci = parsed as AdoCi;
      } catch {
        // ignore — empty ci means mapAdo won't flag CI failure for this tick
      }
    }

    return { signal: mapAdo(pr, ci, url), raw: { pr, ci } };
  },
};

function hasCli(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
