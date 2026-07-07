// Mirrors the JSON shapes src/web/api.ts serializes. Kept by hand (the
// backend is plain JS objects, no codegen); api.test.ts pins the wire shapes
// server-side and these types pin the client's assumptions.

export interface TaskLock {
  agentId: string;
  pid: number;
  acquired: string;
}

export interface TaskSummary {
  slug: string;
  qualifiedSlug: string;
  segments: string[];
  title: string;
  status: string;
  ownStatus: string;
  type: string | null;
  parentSlug: string | null;
  isParent: boolean;
  archived: boolean;
  created: string | null;
  closed: string | null;
  prs: string[];
  tags: string[];
  allowOrchestrator: boolean;
  hasReport: boolean;
  lock: TaskLock | null;
  children: TaskSummary[];
}

export interface ProjectSummary {
  slug: string;
  name: string;
  status: string | null;
  repo: { remote: string | null; local: string | null };
  counts: Record<string, number>;
  tasks: TaskSummary[];
}

export interface Section {
  heading: string | null;
  raw: string;
  html: string;
}

export interface PrDigest {
  url: string;
  displayId: string | null;
  host: string | null;
  fetchedAt: string | null;
  fresh: boolean;
  title?: string | null;
  state?: string;
  ci?: string;
  review?: string;
  mergeable?: string;
}

export interface TaskDetail extends TaskSummary {
  project: { slug: string; name: string };
  sections: Section[];
  sessionId: string | null;
  report: { raw: string; html: string } | null;
  prDetails: PrDigest[];
  mtimeMs: number;
}

// GET /api/tasks/<path>/runs (served by route(): transcript html is
// server-rendered, same fragments the SSR panel shows).
export interface RunsFeed {
  runs: { name: string; timestamp: string }[];
  latest: {
    name: string;
    running: boolean;
    html: string;
    totalEvents: number;
    shownEvents: number;
    parsed: number;
    skipped: number;
    offset: number;
    format: string;
    sessionId: string | null;
    tailPath: string;
    rawPath: string;
  } | null;
}

export interface TailChunk {
  html: string;
  offset: number;
  running: boolean;
}

// GET /api/logs — parsed harness log sources (core/harness_log.ts shapes).
export interface LogLine {
  raw: string;
  timestamp?: string;
  level?: "INFO" | "WARN" | "ERROR";
  script?: string;
  message?: string;
  source?: "task-log";
}

export interface LogSource {
  name: string;
  path: string;
  exists: boolean;
  lines: LogLine[];
  totalLines: number;
}

// GET /api/config — non-throwing snapshot of ~/.tpm/config.json.
export interface ConfigSnapshot {
  path: string;
  raw: string;
  parsed: Record<string, unknown> | null;
  error: string | null;
  missing: boolean;
}

export interface ProjectDetail extends ProjectSummary {
  sections: Section[];
  mtimeMs: number;
}

export interface QueueItem extends TaskSummary {
  projectSlug: string;
}

export interface SearchHit extends QueueItem {
  snippet: string | null;
}

export interface StatusEvent {
  at: string;     // ISO-8601 UTC
  task: string;   // qualified slug
  from: string;
  to: string;
  verb: string;
  actor: string;  // TPM_AGENT_ID or "cli"
}

export interface VocabEntry {
  status: string;
  verbs: string[];
  note?: string;
}

export interface Vocab {
  statuses: VocabEntry[];
  types: string[];
  mutationActions: string[];
  bulkActions: Record<string, { verb: string; label: string; needsReason?: boolean }>;
}

// GET /api/harness (pre-v1 endpoint, still served by route()): {running:false}
// when tpm serve runs without the harness, else {running:true, ...snapshot}.
export interface HarnessSnapshot {
  running: boolean;
  startedAt?: string;
  pollIntervalSec?: number;
  desiredWorkers?: number;
  stopping?: boolean;
  lastPoll?: { at: string; summary?: Record<string, unknown>; error?: string } | null;
  poolDied?: string | null;
}

export interface MutationResponse {
  ok: boolean;
  message?: string;
  error?: string;
  slug?: string;
  segments?: string[];
}
