import { useState } from "react";
import { api } from "../api";
import { useData, useDebounced, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard, StatusBadge, TaskRow, useFlash } from "../components";
import type { ProjectSummary, TaskSummary } from "../types";
import { flatTasks, patchTaskStatus, shortStamp } from "../lib";
import { SelectAll, useBulk, useKeyNav } from "../bulk";
import type { RowSelection } from "../components";

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
  // Push path: apply the journal event immediately (badges + activity feed),
  // reconcile membership (inbox/queue are server logic) with one debounced
  // refetch per burst — a bulk action emits N events but costs one round trip.
  const reconcile = useDebounced(overview.refresh, 1_200);
  useSse(msg => {
    if (msg.kind === "harness") {
      reconcile();
      return;
    }
    const e = msg.event;
    overview.mutate(d => ({
      ...d,
      projects: d.projects.map(p => ({ ...p, tasks: patchTaskStatus(p.tasks, e.task, e.to) })),
      inbox: patchTaskStatus(d.inbox, e.task, e.to),
      queue: patchTaskStatus(d.queue, e.task, e.to),
      events: [e, ...d.events].slice(0, 50),
    }));
    reconcile();
  });
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

  const allTasks = overview.data
    ? dedupe([...overview.data.projects.flatMap(p => flatTasks(p.tasks)), ...overview.data.inbox, ...overview.data.queue])
    : [];
  const bulk = useBulk(allTasks, overview.refresh);
  const inFlightNow = overview.data
    ? overview.data.projects.flatMap(p => flatTasks(p.tasks)).filter(t => t.status === "in-progress")
    : [];
  // j/k cursor walks the three queue sections in visual order.
  const navOrder = overview.data ? dedupe([...overview.data.inbox, ...inFlightNow, ...overview.data.queue]) : [];
  const cursor = useKeyNav(navOrder, bulk.selection, bulk.selectable);

  if (overview.error) return <p className="text-sm text-danger">Failed to load: {overview.error}</p>;
  if (!overview.data) return <p className="text-sm text-muted">Loading…</p>;
  const { projects, inbox, queue, events, harness } = overview.data;
  const inFlight = projects
    .flatMap(p => flatTasks(p.tasks))
    .filter(t => t.status === "in-progress");

  return (
    <div className="flex flex-col gap-5">
      {harness.running && <HarnessPanel harness={harness} onChanged={overview.refresh} />}

      <SectionCard title="Your inbox" meta={<><SelectAll tasks={inbox} selection={bulk.selection} selectable={bulk.selectable} />{`${inbox.length} task${inbox.length === 1 ? "" : "s"}`}</>}>
        {inbox.length === 0 ? <Empty text="Inbox zero." /> : inbox.map(t => (
          <TaskRow key={t.qualifiedSlug} task={t} cursor={cursor === t.qualifiedSlug} selection={bulk.rowsFor(inbox)} actions={
            (t.status === "open" || t.status === "blocked") ? (
              <button
                onClick={() => act(t, t.status === "blocked" ? "reopen" : "ready")}
                title={t.status === "blocked" ? "reopen" : "promote to ready"}
                className="rounded border border-edge px-2 py-0.5 text-xs text-muted hover:bg-surface-hover"
              >
                {t.status === "blocked" ? "reopen" : "▶ ready"}
              </button>
            ) : undefined
          } />
        ))}
      </SectionCard>

      <SectionCard title="Agent queue" meta={<><SelectAll tasks={queue} selection={bulk.selection} selectable={bulk.selectable} />{`${queue.length} eligible`}</>}>
        {queue.length === 0 ? <Empty text="Nothing queued for agents." /> : queue.map(t => (
          <TaskRow key={t.qualifiedSlug} task={t} cursor={cursor === t.qualifiedSlug} selection={bulk.rowsFor(queue)} />
        ))}
      </SectionCard>

      <SectionCard title="In flight" meta={<><SelectAll tasks={inFlight} selection={bulk.selection} selectable={bulk.selectable} />{`${inFlight.length} running`}</>}>
        {inFlight.length === 0 ? <Empty text="No task is in progress." /> : inFlight.map(t => (
          <TaskRow key={t.qualifiedSlug} task={t} cursor={cursor === t.qualifiedSlug} selection={bulk.rowsFor(inFlight)} />
        ))}
      </SectionCard>

      <SectionCard title="Projects">
        {projects.map(p => <ProjectBlock key={p.slug} project={p} rowsFor={bulk.rowsFor} />)}
      </SectionCard>

      <SectionCard title="Activity">
        {events.length === 0 ? <Empty text="No journal entries yet." /> : (
          <ul className="divide-y divide-hairline text-sm">
            {events.slice(0, 12).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-40 shrink-0 font-mono text-xs text-faint">{shortStamp(e.at)}</span>
                <span className="font-mono text-xs">{e.task}</span>
                <StatusBadge status={e.from || "?"} />
                <span className="text-faint">→</span>
                <StatusBadge status={e.to} />
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{e.verb} · {e.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {bulk.bar}
    </div>
  );
}

function dedupe(tasks: TaskSummary[]): TaskSummary[] {
  const seen = new Map<string, TaskSummary>();
  for (const t of tasks) if (!seen.has(t.qualifiedSlug)) seen.set(t.qualifiedSlug, t);
  return [...seen.values()];
}

function ProjectBlock({ project, rowsFor }: { project: ProjectSummary; rowsFor: (tasks: TaskSummary[]) => RowSelection }) {
  const [open, setOpen] = useState(false);
  const visible = flatTasks(project.tasks).filter(t => !t.isParent && !["done", "dropped"].includes(t.status));
  const badgeCounts = Object.entries(project.counts).sort();
  return (
    <div className="border-b border-hairline last:border-0">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover">
        <span className="w-4 text-xs text-faint">{open ? "▾" : "▸"}</span>
        <span className="font-medium">{project.name}</span>
        <span className="font-mono text-xs text-faint">{project.slug}</span>
        <span className="flex-1" />
        {badgeCounts.map(([status, n]) => (
          <span key={status} className="flex items-center gap-1 text-xs text-muted">
            <StatusBadge status={status} /> {n}
          </span>
        ))}
      </button>
      {open && (
        <div className="pb-1 pl-6">
          {visible.length === 0 ? <Empty text="No open tasks." /> : visible.map(t => (
            <TaskRow key={t.qualifiedSlug} task={t} selection={rowsFor(visible)} />
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
    ? "bg-danger-soft text-danger"
    : workers === 0
      ? "bg-hairline text-muted"
      : "bg-ok-soft text-ok";

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
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface px-3 py-2 text-sm">
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateCls}`}>{state}</span>
      {harness.poolDied && <span className="text-xs text-danger">{harness.poolDied}</span>}
      <span className="text-muted">workers</span>
      <div className="flex items-center gap-1">
        <button onClick={() => setWorkers(workers - 1)} className="h-6 w-6 rounded border border-edge text-xs hover:bg-surface-hover">−</button>
        <span className="w-6 text-center font-mono">{workers}</span>
        <button onClick={() => setWorkers(workers + 1)} className="h-6 w-6 rounded border border-edge text-xs hover:bg-surface-hover">+</button>
      </div>
      <button
        onClick={() => setWorkers(workers === 0 ? 1 : 0)}
        className="rounded border border-edge px-2 py-0.5 text-xs hover:bg-surface-hover"
      >
        {workers === 0 ? "resume" : "pause"}
      </button>
      <span className="flex-1" />
      {harness.lastPoll && (
        <span className="text-xs text-faint" title={harness.lastPoll.error ?? ""}>
          last poll {harness.lastPoll.at.replace("T", " ").slice(0, 19)}{harness.lastPoll.error ? " ⚠" : ""}
        </span>
      )}
    </div>
  );
}
