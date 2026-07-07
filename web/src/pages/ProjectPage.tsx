import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useData, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard, StatusBadge, TaskRow, useFlash } from "../components";
import { flatTasks } from "../lib";
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
  useSse(detail.refresh);
  useRevalidateOnFocus(detail.refresh);

  if (detail.error) return <p className="text-sm text-red-600">Failed to load: {detail.error}</p>;
  if (!detail.data) return <p className="text-sm text-neutral-500">Loading…</p>;
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
        <span className="font-mono text-sm text-neutral-400">{p.slug}</span>
        {p.repo.remote && (
          <a href={p.repo.remote} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">repo →</a>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          <input type="checkbox" checked={showArchived}
                 onChange={e => setParams(e.target.checked ? { archived: "1" } : {})} />
          show archived
        </label>
        <a href={`/p/${encodeURIComponent(p.slug)}`} className="text-xs text-neutral-500 hover:underline">classic</a>
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
            <SectionCard key={status} title={status} meta={`${groups.get(status)!.length}`}>
              {groups.get(status)!.map(t => <TaskRow key={t.qualifiedSlug} task={t} />)}
            </SectionCard>
          ))}
          {ordered.length === 0 && <Empty text="No tasks yet." />}
        </div>
      </div>
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
        <button onClick={() => { setValue(section.raw); setEditing(true); }} className="text-blue-600 hover:underline dark:text-blue-400">edit</button>
      ) : undefined}
    >
      {editing ? (
        <div className="flex flex-col gap-2 p-3">
          <textarea value={value} onChange={e => setValue(e.target.value)} rows={Math.max(4, value.split("\n").length + 1)}
                    className="w-full rounded border border-neutral-300 bg-white p-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900" />
          <div className="flex gap-2">
            <button onClick={save} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700">Save</button>
            <button onClick={() => setEditing(false)} className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">Cancel</button>
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
              className="self-start rounded border border-dashed border-neutral-300 px-3 py-1 text-sm text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-700 dark:hover:text-neutral-300">
        + New task
      </button>
    );
  }
  return (
    <SectionCard title="New task">
      <div className="flex flex-col gap-2 p-3 text-sm">
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Title"
               className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        <select value={type} onChange={e => setType(e.target.value)}
                className="w-40 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
          <option value="pr">pr</option>
          <option value="investigation">investigation</option>
        </select>
        <textarea value={context} onChange={e => setContext(e.target.value)} placeholder="Context (optional; lands in ## Context)" rows={3}
                  className="rounded border border-neutral-300 bg-white px-2 py-1 font-mono dark:border-neutral-700 dark:bg-neutral-900" />
        <div className="flex gap-2">
          <button onClick={() => create(false)} disabled={!title.trim()}
                  className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-40">Create</button>
          <button onClick={() => create(true)} disabled={!title.trim()}
                  className="rounded border border-blue-600 px-3 py-1 text-blue-600 hover:bg-blue-50 disabled:opacity-40 dark:hover:bg-blue-950">Create &amp; ready</button>
          <button onClick={() => setOpen(false)} className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">Cancel</button>
        </div>
      </div>
    </SectionCard>
  );
}
