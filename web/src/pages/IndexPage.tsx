import { useState } from "react";
import { api } from "../api";
import { useData, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard, StatusBadge, TaskRow, useFlash } from "../components";
import type { ProjectSummary, TaskSummary } from "../types";
import { flatTasks, shortStamp } from "../lib";

// The control surface: harness panel, inbox, agent queue, in flight, projects,
// activity feed. Mirrors the SSR index's information architecture; refreshes
// on journal SSE + tab focus.

export default function IndexPage() {
  const flash = useFlash();
  const overview = useData(async () => {
    const [projects, inbox, queue, events, harness] = await Promise.all([
      api.projects(), api.inbox(), api.queue(), api.recentEvents(), api.harness(),
    ]);
    return { projects: projects.projects, inbox: inbox.items, queue: queue.items, events: events.events, harness };
  });
  useSse(overview.refresh);
  useRevalidateOnFocus(overview.refresh);

  const act = async (task: TaskSummary, action: string, fields: Record<string, unknown> = {}) => {
    try {
      const r = await api.mutateTask(task.qualifiedSlug, action, fields);
      flash("ok", r.message ?? `${action}: ok`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    }
    overview.refresh();
  };

  if (overview.error) return <p className="text-sm text-red-600">Failed to load: {overview.error}</p>;
  if (!overview.data) return <p className="text-sm text-neutral-500">Loading…</p>;
  const { projects, inbox, queue, events, harness } = overview.data;
  const inFlight = projects
    .flatMap(p => flatTasks(p.tasks))
    .filter(t => t.status === "in-progress");

  return (
    <div className="flex flex-col gap-5">
      {harness.running && <HarnessPanel harness={harness} onChanged={overview.refresh} />}

      <SectionCard title="Your inbox" meta={`${inbox.length} task${inbox.length === 1 ? "" : "s"}`}>
        {inbox.length === 0 ? <Empty text="Inbox zero." /> : inbox.map(t => (
          <TaskRow key={t.qualifiedSlug} task={t} actions={
            (t.status === "open" || t.status === "blocked") ? (
              <button
                onClick={() => act(t, t.status === "blocked" ? "reopen" : "ready")}
                title={t.status === "blocked" ? "reopen" : "promote to ready"}
                className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                {t.status === "blocked" ? "reopen" : "▶ ready"}
              </button>
            ) : undefined
          } />
        ))}
      </SectionCard>

      <SectionCard title="Agent queue" meta={`${queue.length} eligible`}>
        {queue.length === 0 ? <Empty text="Nothing queued for agents." /> : queue.map(t => (
          <TaskRow key={t.qualifiedSlug} task={t} />
        ))}
      </SectionCard>

      <SectionCard title="In flight" meta={`${inFlight.length} running`}>
        {inFlight.length === 0 ? <Empty text="No task is in progress." /> : inFlight.map(t => (
          <TaskRow key={t.qualifiedSlug} task={t} />
        ))}
      </SectionCard>

      <SectionCard title="Projects">
        {projects.map(p => <ProjectBlock key={p.slug} project={p} />)}
      </SectionCard>

      <SectionCard title="Activity">
        {events.length === 0 ? <Empty text="No journal entries yet." /> : (
          <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
            {events.slice(0, 12).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-40 shrink-0 font-mono text-xs text-neutral-400">{shortStamp(e.at)}</span>
                <span className="font-mono text-xs">{e.task}</span>
                <StatusBadge status={e.from || "?"} />
                <span className="text-neutral-400">→</span>
                <StatusBadge status={e.to} />
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{e.verb} · {e.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function ProjectBlock({ project }: { project: ProjectSummary }) {
  const [open, setOpen] = useState(false);
  const visible = flatTasks(project.tasks).filter(t => !t.isParent && !["done", "dropped"].includes(t.status));
  const badgeCounts = Object.entries(project.counts).sort();
  return (
    <div className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900">
        <span className="w-4 text-xs text-neutral-400">{open ? "▾" : "▸"}</span>
        <span className="font-medium">{project.name}</span>
        <span className="font-mono text-xs text-neutral-400">{project.slug}</span>
        <span className="flex-1" />
        {badgeCounts.map(([status, n]) => (
          <span key={status} className="flex items-center gap-1 text-xs text-neutral-500">
            <StatusBadge status={status} /> {n}
          </span>
        ))}
      </button>
      {open && (
        <div className="pb-1 pl-6">
          {visible.length === 0 ? <Empty text="No open tasks." /> : visible.map(t => (
            <TaskRow key={t.qualifiedSlug} task={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function HarnessPanel({ harness, onChanged }: { harness: { desiredWorkers?: number; stopping?: boolean; poolDied?: string | null; lastPoll?: { at: string; error?: string } | null }; onChanged: () => void }) {
  const flash = useFlash();
  const workers = harness.desiredWorkers ?? 0;
  const state = harness.poolDied ? "pool died" : harness.stopping ? "draining" : workers === 0 ? "paused" : "running";
  const stateCls = harness.poolDied
    ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
    : workers === 0
      ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
      : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";

  const setWorkers = async (n: number) => {
    if (n < 0 || n > 16) return;
    try {
      const r = await api.setWorkers(n);
      flash("ok", r.message ?? `workers -> ${n}`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    }
    onChanged();
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateCls}`}>{state}</span>
      {harness.poolDied && <span className="text-xs text-red-600">{harness.poolDied}</span>}
      <span className="text-neutral-500">workers</span>
      <div className="flex items-center gap-1">
        <button onClick={() => setWorkers(workers - 1)} className="h-6 w-6 rounded border border-neutral-300 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">−</button>
        <span className="w-6 text-center font-mono">{workers}</span>
        <button onClick={() => setWorkers(workers + 1)} className="h-6 w-6 rounded border border-neutral-300 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">+</button>
      </div>
      <button
        onClick={() => setWorkers(workers === 0 ? 1 : 0)}
        className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {workers === 0 ? "resume" : "pause"}
      </button>
      <span className="flex-1" />
      {harness.lastPoll && (
        <span className="text-xs text-neutral-400" title={harness.lastPoll.error ?? ""}>
          last poll {harness.lastPoll.at.replace("T", " ").slice(0, 19)}{harness.lastPoll.error ? " ⚠" : ""}
        </span>
      )}
    </div>
  );
}
