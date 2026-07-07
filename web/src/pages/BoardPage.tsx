import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useData, useDebounced, useRevalidateOnFocus, useSse } from "../hooks";
import { LoadError, StatusBadge, useFlash } from "../components";
import { flatTasks, patchTaskStatus, taskHref } from "../lib";
import type { TaskSummary } from "../types";

// Kanban: one column per lifecycle status, cards draggable between columns.
// A drop runs the generic `status` verb — the transition table stays the
// enforcer, so an illegal drag simply flashes the table's refusal and the
// card snaps back on reconcile. Terminal columns (done/dropped) render
// collapsed counts; archived tasks are excluded.

const COLUMNS = ["open", "ready", "in-progress", "rework", "review", "closing", "blocked"] as const;
const TERMINAL = ["done", "dropped"] as const;

export default function BoardPage() {
  const flash = useFlash();
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get("project") ?? "";
  const overview = useData(() => api.projects(), []);
  const reconcile = useDebounced(overview.refresh, 1_200);
  useSse(msg => {
    if (msg.kind === "harness") return;
    overview.mutate(d => ({
      ...d,
      projects: d.projects.map(p => ({ ...p, tasks: patchTaskStatus(p.tasks, msg.event.task, msg.event.to) })),
    }));
    reconcile();
  });
  useRevalidateOnFocus(overview.refresh);
  const [dragging, setDragging] = useState<string | null>(null);

  if (overview.error) return <LoadError error={overview.error} onRetry={overview.refresh} />;
  if (!overview.data) return <p className="text-sm text-muted">Loading…</p>;

  const projects = overview.data.projects;
  const tasks = projects
    .filter(p => !projectFilter || p.slug === projectFilter)
    .flatMap(p => flatTasks(p.tasks))
    .filter(t => !t.isParent && !t.archived);
  const byStatus = new Map<string, TaskSummary[]>();
  for (const t of tasks) {
    const g = byStatus.get(t.status) ?? [];
    g.push(t);
    byStatus.set(t.status, g);
  }

  const drop = async (status: string) => {
    const slug = dragging;
    setDragging(null);
    if (!slug) return;
    const task = tasks.find(t => t.qualifiedSlug === slug);
    if (!task || task.status === status) return;
    try {
      const r = await api.mutateTask(slug, "status", { status });
      flash("ok", r.message ?? `${slug} -> ${status}`);
    } catch (e) {
      // The transition table's refusal names why — surface it verbatim.
      flash("error", e instanceof Error ? e.message : String(e));
    }
    overview.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Board</h1>
        <span className="flex-1" />
        <select
          value={projectFilter}
          onChange={e => setParams(e.target.value ? { project: e.target.value } : {})}
          className="rounded border border-edge bg-surface px-2 py-1 text-sm"
        >
          <option value="">all projects</option>
          {projects.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </header>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {COLUMNS.map(status => (
          <div
            key={status}
            onDragOver={e => e.preventDefault()}
            onDrop={() => drop(status)}
            className={`flex w-64 shrink-0 flex-col gap-2 rounded-xl border p-2 ${
              dragging ? "border-accent/50 bg-accent/5" : "border-edge bg-canvas"
            }`}
            data-column={status}
          >
            <div className="flex items-center justify-between px-1">
              <StatusBadge status={status} />
              <span className="text-xs text-muted">{byStatus.get(status)?.length ?? 0}</span>
            </div>
            {(byStatus.get(status) ?? []).map(t => (
              <div
                key={t.qualifiedSlug}
                draggable
                onDragStart={e => {
                  setDragging(t.qualifiedSlug);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", t.qualifiedSlug);
                }}
                onDragEnd={() => setDragging(null)}
                className="cursor-grab rounded-lg border border-edge bg-surface p-2 text-sm shadow-sm active:cursor-grabbing"
                data-card={t.qualifiedSlug}
              >
                <Link to={taskHref(t)} className="font-mono text-xs text-accent hover:underline" draggable={false}>
                  {t.qualifiedSlug}
                </Link>
                <p className="mt-0.5 line-clamp-2 text-ink/90">{t.title}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  {t.prs.length > 0 && (
                    <a href={t.prs[t.prs.length - 1]} target="_blank" rel="noreferrer" draggable={false}
                       className="rounded bg-hairline px-1 text-[11px] text-muted hover:bg-edge">PR</a>
                  )}
                  {t.type === "investigation" && <span className="rounded bg-hairline px-1 text-[11px] text-muted">inv</span>}
                  {t.lock && <span className="rounded bg-warn-soft px-1 text-[11px] text-warn">{t.lock.agentId}</span>}
                </div>
              </div>
            ))}
          </div>
        ))}
        <div className="flex w-40 shrink-0 flex-col gap-2 rounded-xl border border-edge bg-canvas p-2 opacity-70">
          {TERMINAL.map(status => (
            <div key={status} className="flex items-center justify-between px-1">
              <StatusBadge status={status} />
              <span className="text-xs text-muted">{byStatus.get(status)?.length ?? 0}</span>
            </div>
          ))}
          <p className="px-1 text-[11px] text-faint">terminal — close via the task page</p>
        </div>
      </div>
    </div>
  );
}
