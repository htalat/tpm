import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useData, useDebounced, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard, StatusBadge, TaskRow, useFlash, LoadError } from "../components";
import { flatTasks } from "../lib";
import { SelectAll, useBulk, useKeyNav } from "../bulk";
import type { ProjectDetail, Section } from "../types";

// Project view: frontmatter meta, editable Goal/Context/Notes, tasks grouped
// by status, and the new-task form (create / create-&-ready).

const EDITABLE = new Set(["Goal", "Context", "Notes"]);
const GROUP_ORDER = ["in-progress", "rework", "review", "closing", "ready", "open", "blocked", "done", "dropped"];

export default function ProjectPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const showArchived = params.get("archived") === "1";
  const detail = useData(() => api.project(slug, showArchived), [slug, showArchived]);
  const reconcile = useDebounced(detail.refresh, 1_200);
  useSse(msg => {
    if (msg.kind === "harness") return;
    if (msg.event.task.startsWith(`${slug}/`)) reconcile();
  });
  useRevalidateOnFocus(detail.refresh);

  const allTasks = detail.data ? flatTasks(detail.data.tasks).filter(t => !t.isParent) : [];
  const bulk = useBulk(allTasks, detail.refresh);
  const cursor = useKeyNav(allTasks, bulk.selection, bulk.selectable);

  if (detail.error) return <LoadError error={detail.error} onRetry={detail.refresh} />;
  if (!detail.data) return <p className="text-sm text-muted">Loading…</p>;
  const p = detail.data;

  const groups = new Map<string, ReturnType<typeof flatTasks>>();
  for (const t of flatTasks(p.tasks).filter(t => !t.isParent)) {
    const g = groups.get(t.status) ?? [];
    g.push(t);
    groups.set(t.status, g);
  }
  const ordered = [...GROUP_ORDER.filter(s => groups.has(s)), ...[...groups.keys()].filter(s => !GROUP_ORDER.includes(s))];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        {p.status && <StatusBadge status={p.status} />}
        <h1 className="text-xl font-semibold">{p.name}</h1>
        <span className="font-mono text-sm text-faint">{p.slug}</span>
        {p.repo.remote && (
          <a href={p.repo.remote} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">repo →</a>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={showArchived}
                 onChange={e => setParams(e.target.checked ? { archived: "1" } : {})} />
          show archived
        </label>
      </header>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-4">
          {p.sections.filter(s => s.heading !== null).map(s => (
            <ProjectSection key={s.heading} project={p} section={s} onSaved={detail.refresh} />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <NewTaskForm project={p} onCreated={detail.refresh} />
          {ordered.map(status => (
            <SectionCard key={status} title={status} meta={<><SelectAll tasks={groups.get(status)!} selection={bulk.selection} selectable={bulk.selectable} />{`${groups.get(status)!.length}`}</>}>
              {groups.get(status)!.map(t => <TaskRow key={t.qualifiedSlug} task={t} cursor={cursor === t.qualifiedSlug} selection={bulk.rowsFor(groups.get(status)!)} />)}
            </SectionCard>
          ))}
          {ordered.length === 0 && <Empty text="No tasks yet." />}
        </div>
      </div>
      {bulk.bar}
    </div>
  );
}

function ProjectSection({ project, section, onSaved }: { project: ProjectDetail; section: Section; onSaved: () => void }) {
  const flash = useFlash();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(section.raw);
  const canEdit = EDITABLE.has(section.heading ?? "");

  const save = async () => {
    try {
      const r = await api.editProject(project.slug, {
        section: (section.heading ?? "").toLowerCase(),
        value,
        mtime: String(project.mtimeMs),
      });
      flash("ok", r.message ?? "saved");
      setEditing(false);
      onSaved();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
      onSaved();
    }
  };

  return (
    <SectionCard
      title={section.heading ?? ""}
      meta={canEdit && !editing ? (
        <button onClick={() => { setValue(section.raw); setEditing(true); }} className="text-accent hover:underline">edit</button>
      ) : undefined}
    >
      {editing ? (
        <div className="flex flex-col gap-2 p-3">
          <textarea value={value} onChange={e => setValue(e.target.value)} rows={Math.max(4, value.split("\n").length + 1)}
                    className="w-full rounded border border-edge bg-surface p-2 font-mono text-sm" />
          <div className="flex gap-2">
            <button onClick={save} className="rounded bg-accent-solid px-3 py-1 text-sm text-on-accent hover:brightness-110">Save</button>
            <button onClick={() => setEditing(false)} className="rounded border border-edge px-3 py-1 text-sm">Cancel</button>
          </div>
        </div>
      ) : section.raw.trim() === "" ? (
        <Empty text="(empty)" />
      ) : (
        <div className="markdown px-3 py-2 text-sm" dangerouslySetInnerHTML={{ __html: section.html }} />
      )}
    </SectionCard>
  );
}

function NewTaskForm({ project, onCreated }: { project: ProjectDetail; onCreated: () => void }) {
  const flash = useFlash();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("pr");
  const [context, setContext] = useState("");

  const create = async (ready: boolean) => {
    try {
      const r = await api.newTask(project.slug, { title, type, context, ...(ready ? { ready: "1" } : {}) });
      flash("ok", r.message ?? "created");
      setTitle(""); setContext(""); setOpen(false);
      onCreated();
      if (r.segments) navigate(`/t/${r.segments.map(encodeURIComponent).join("/")}`);
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
              className="self-start rounded border border-dashed border-edge px-3 py-1 text-sm text-muted hover:border-muted hover:text-ink/90">
        + New task
      </button>
    );
  }
  return (
    <SectionCard title="New task">
      <div className="flex flex-col gap-2 p-3 text-sm">
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Title"
               className="rounded border border-edge bg-surface px-2 py-1" />
        <select value={type} onChange={e => setType(e.target.value)}
                className="w-40 rounded border border-edge bg-surface px-2 py-1">
          <option value="pr">pr</option>
          <option value="investigation">investigation</option>
        </select>
        <textarea value={context} onChange={e => setContext(e.target.value)} placeholder="Context (optional; lands in ## Context)" rows={3}
                  className="rounded border border-edge bg-surface px-2 py-1 font-mono" />
        <div className="flex gap-2">
          <button onClick={() => create(false)} disabled={!title.trim()}
                  className="rounded bg-accent-solid px-3 py-1 text-on-accent hover:brightness-110 disabled:opacity-40">Create</button>
          <button onClick={() => create(true)} disabled={!title.trim()}
                  className="rounded border border-accent-solid px-3 py-1 text-accent hover:bg-accent/10 disabled:opacity-40">Create &amp; ready</button>
          <button onClick={() => setOpen(false)} className="rounded border border-edge px-3 py-1">Cancel</button>
        </div>
      </div>
    </SectionCard>
  );
}
