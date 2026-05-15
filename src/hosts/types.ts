// Host-agnostic PR signal abstraction.
//
// The poller's decision space is tiny: did the PR merge, does the agent need
// to act, does the human need to act, was it abandoned, or is there nothing
// to do. Each host adapter answers that question in its native dialect — no
// shared wire schema to keep in sync, no `if host === 'ado'` branches
// inside what claims to be host-agnostic logic. Adding a new host is one
// adapter file plus an entry in the registry array (see src/pr_signal.ts).

// Coarse decision the poller acts on. The reason strings on needs-agent /
// needs-human double as evidence — they show up in the task Log and in the
// poller's structured log lines, so a future operator can tell *why* a
// classification fired without re-running the fetch.
export type PrSignal =
  | { kind: "no-action" }
  | { kind: "needs-agent"; reason: string }
  | { kind: "needs-human"; reason: string }
  | { kind: "merged"; mergedAt: string; title: string; body: string; url: string }
  | { kind: "abandoned" };

// Parsed view of a PR URL. `cachePath` is the path segment under
// ~/.tpm/pr-cache/ where this PR's snapshot is stored; it must be unique
// across all hosts so they can share the cache root without collisions
// (github → `<owner>/<repo>/<n>.json`; ado → `ado/<org>/<project>/<repo>/<id>.json`).
// `displayId` is the short label used in chips (e.g. `#42`).
export interface PrRef {
  host: string;
  cachePath: string;
  displayId: string;
}

export interface FetchedSignal {
  signal: PrSignal;
  raw: unknown; // host-native wire JSON — opaque to the harness, useful to the cache + serve UI
}

// One adapter per host. Plain value, no class hierarchy.
export interface PrHost {
  name: string;
  matches: (url: string) => boolean;
  parse: (url: string) => PrRef | null; // null when matches() is false
  fetchSignal: (url: string) => Promise<FetchedSignal>;
}
