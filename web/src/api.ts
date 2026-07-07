import type {
  BulkResponse, ConfigSnapshot, HarnessSnapshot, LogSource, MutationResponse, ProjectDetail,
  ProjectSummary, QueueItem, RunsFeed, SearchHit, StatusEvent, TailChunk,
  TaskDetail, Vocab,
} from "./types";

// Thin typed client over the JSON API. Paths are same-origin: vite's dev
// proxy forwards them to tpm serve; in prod the SPA is served by tpm serve
// itself.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

async function postJson(path: string, fields: unknown): Promise<MutationResponse> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(fields ?? {}),
  });
  let body: MutationResponse;
  try {
    body = (await res.json()) as MutationResponse;
  } catch {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  }
  if (!res.ok || !body.ok) throw new ApiError(res.status, body.error ?? "mutation failed");
  return body;
}

const enc = encodeURIComponent;
const pathOf = (segments: string[]) => segments.map(enc).join("/");

export const api = {
  projects: (archived = false) =>
    getJson<{ projects: ProjectSummary[] }>(`/api/projects${archived ? "?archived=1" : ""}`),
  project: (slug: string, archived = false) =>
    getJson<ProjectDetail>(`/api/projects/${enc(slug)}${archived ? "?archived=1" : ""}`),
  task: (segments: string[]) =>
    getJson<TaskDetail>(`/api/tasks/${pathOf(segments)}`),
  inbox: () => getJson<{ items: QueueItem[] }>("/api/inbox"),
  queue: () => getJson<{ items: QueueItem[] }>("/api/queue"),
  search: (q: string, archived = false) =>
    getJson<{ q: string; hits: SearchHit[] }>(`/api/search?q=${enc(q)}${archived ? "&archived=1" : ""}`),
  vocab: () => getJson<Vocab>("/api/vocab"),
  recentEvents: () => getJson<{ events: StatusEvent[] }>("/api/events/recent"),
  harness: () => getJson<HarnessSnapshot>("/api/harness"),
  runs: (segments: string[]) => getJson<RunsFeed>(`/api/tasks/${pathOf(segments)}/runs`),
  tail: (tailPath: string, offset: number, format: string) =>
    getJson<TailChunk>(`${tailPath}?offset=${offset}&format=${enc(format)}`),
  logs: (category?: "orchestrate" | "poller", lines = 200) =>
    getJson<{ sources: LogSource[] }>(`/api/logs${category ? `/${category}` : ""}?lines=${lines}`),
  config: () => getJson<{ config: ConfigSnapshot }>("/api/config"),

  mutateTask: (qualifiedSlug: string, action: string, fields: Record<string, unknown> = {}) =>
    postJson(`/api/tasks/${enc(qualifiedSlug)}/${action}`, fields),
  newTask: (projectSlug: string, fields: Record<string, unknown>) =>
    postJson(`/api/projects/${enc(projectSlug)}/new-task`, fields),
  editProject: (projectSlug: string, fields: Record<string, unknown>) =>
    postJson(`/api/projects/${enc(projectSlug)}/edit`, fields),
  bulk: (action: string, slugs: string[], reason?: string) =>
    postJson(`/api/bulk/${action}`, reason ? { slugs, reason } : { slugs }) as Promise<MutationResponse & BulkResponse>,
  setWorkers: (value: number) => postJson("/api/harness/workers", { value }),
};
