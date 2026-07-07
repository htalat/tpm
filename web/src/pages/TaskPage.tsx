import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useData, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard, StatusBadge, useFlash } from "../components";
import type { PrDigest, Section, TaskDetail } from "../types";

// Task detail: rendered sections with inline editors, meta rail, status-gated
// actions, PR cards. The action gate map mirrors serve.ts's renderActions —
// the CLI verb is still the enforcer; the map only decides what to offer.

const EDITABLE = new Set(["Context", "Plan", "Outcome"]);

interface ActionSpec {
  action: string;
  label: string;
  field?: { name: string; placeholder: string; required: boolean; multiline?: boolean };
  fixed?: Record<string, string>;
  confirm?: boolean;
}

const block: ActionSpec = { action: "block", label: "Block", field: { name: "reason", placeholder: "why it's blocked", required: true } };
const complete: ActionSpec = { action: "complete", label: "Close", field: { name: "outcome", placeholder: "outcome (optional)", required: false, multiline: true } };
const drop: ActionSpec = { action: "drop", label: "Drop", field: { name: "reason", placeholder: "reason (optional)", required: false }, confirm: true };
const logAction: ActionSpec = { action: "log", label: "Log", field: { name: "message", placeholder: "what changed", required: true } };
const prAction: ActionSpec = { action: "pr", label: "Link PR", field: { name: "url", placeholder: "https://github.com/…/pull/N", required: true } };
const pull: ActionSpec = { action: "pull", label: "Pull from queue" };
const reopen: ActionSpec = { action: "reopen", label: "Reopen", field: { name: "reason", placeholder: "reason (optional)", required: false } };

const ACTIONS_BY_STATUS: Record<string, ActionSpec[]> = {
  open: [{ action: "ready", label: "Promote to ready" }, block, complete, drop],
  ready: [pull, block, complete, drop],
  "in-progress": [pull, block, complete, logAction, prAction, drop],
  rework: [pull, logAction, complete, block, drop],
  closing: [complete, logAction, block, drop],
  review: [logAction, complete, block, { action: "status", label: "Reopen for agent (→ rework)", fixed: { status: "rework" } }, drop],
  blocked: [reopen, complete, drop],
};
const FALLBACK_ACTIONS = [logAction, complete, drop];

export default function TaskPage() {
  // Route: /t/* under the /app basename — the wildcard is the slug path.
  const segments = useLocation().pathname.replace(/^\/t\//, "").split("/").map(decodeURIComponent);
  const detail = useData(() => api.task(segments), [segments.join("/")]);
  useSse(detail.refresh);
  useRevalidateOnFocus(detail.refresh);

  if (detail.error) return <p className="text-sm text-danger">Failed to load: {detail.error}</p>;
  if (!detail.data) return <p className="text-sm text-muted">Loading…</p>;
  const t = detail.data;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <StatusBadge status={t.status} />
        <h1 className="text-xl font-semibold">{t.title}</h1>
        <span className="font-mono text-sm text-faint">{t.qualifiedSlug}</span>
        {t.archived && <span className="badge s-archived">archived</span>}
        <span className="flex-1" />
        <Link to={`/p/${encodeURIComponent(t.project.slug)}`} className="text-sm text-accent hover:underline">
          {t.project.name} →
        </Link>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-4">
          {t.prDetails.length > 0 && <PrPanel prs={t.prDetails} />}
          {t.report && (
            <SectionCard title="Report" meta="report.md">
              <div className="markdown px-3 py-2 text-sm" dangerouslySetInnerHTML={{ __html: t.report.html }} />
            </SectionCard>
          )}
          {t.sections.filter(s => s.heading !== null).map(s => (
            <EditableSection key={s.heading} task={t} section={s} onSaved={detail.refresh} />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <MetaRail task={t} />
          {!t.archived && !t.isParent && !["done", "dropped"].includes(t.status) && (
            <ActionsPanel task={t} onDone={detail.refresh} />
          )}
          <SettingsPanel task={t} onDone={detail.refresh} />
        </div>
      </div>
    </div>
  );
}

function MetaRail({ task }: { task: TaskDetail }) {
  const rows: [string, React.ReactNode][] = [
    ["Type", task.type ?? "—"],
    ["Created", task.created ?? "—"],
  ];
  if (task.closed) rows.push(["Closed", task.closed]);
  if (task.parentSlug) rows.push(["Parent", task.parentSlug]);
  if (task.tags.length) rows.push(["Tags", task.tags.join(", ")]);
  if (task.lock) rows.push(["Lock", `${task.lock.agentId} (pid ${task.lock.pid})`]);
  rows.push(["Autonomous", task.allowOrchestrator ? "true" : "false"]);
  return (
    <SectionCard title="Meta">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {task.sessionId && (
        <p className="border-t border-edge px-3 py-2 text-xs">
          <code className="select-all">claude --resume {task.sessionId}</code>
        </p>
      )}
      <p className="border-t border-edge px-3 py-2 text-xs">
        <Link className="text-accent hover:underline" to={`/t/${task.segments.map(encodeURIComponent).join("/")}/runs`}>
          Runs →
        </Link>
      </p>
    </SectionCard>
  );
}

function EditableSection({ task, section, onSaved }: { task: TaskDetail; section: Section; onSaved: () => void }) {
  const flash = useFlash();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(section.raw);
  const canEdit = !task.archived && !task.isParent && EDITABLE.has(section.heading ?? "");

  const save = async () => {
    try {
      const r = await api.mutateTask(task.qualifiedSlug, "edit", {
        section: (section.heading ?? "").toLowerCase(),
        value,
        mtime: String(task.mtimeMs),
      });
      flash("ok", r.message ?? "saved");
      setEditing(false);
      onSaved();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
      onSaved(); // stale mtime → reload fresh content
    }
  };

  return (
    <SectionCard
      title={section.heading ?? ""}
      meta={canEdit && !editing ? (
        <button onClick={() => { setValue(section.raw); setEditing(true); }} className="text-accent hover:underline">
          edit
        </button>
      ) : undefined}
    >
      {editing ? (
        <div className="flex flex-col gap-2 p-3">
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            rows={Math.max(6, value.split("\n").length + 1)}
            className="w-full rounded border border-edge bg-surface p-2 font-mono text-sm"
          />
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

function ActionsPanel({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const specs = ACTIONS_BY_STATUS[task.status] ?? FALLBACK_ACTIONS;
  const extra: ActionSpec[] = [];
  if (task.type === "investigation" && task.hasReport && task.status === "review") {
    extra.push({ action: "lgtm", label: "LGTM (approve report)" });
    extra.push({ action: "request-changes", label: "Request changes", field: { name: "comment", placeholder: "what to change", required: true, multiline: true } });
  }
  return (
    <SectionCard title="Actions">
      <div className="flex flex-col gap-2 p-3">
        {[...extra, ...specs].map(spec => <ActionRow key={spec.label} task={task} spec={spec} onDone={onDone} />)}
      </div>
    </SectionCard>
  );
}

function ActionRow({ task, spec, onDone }: { task: TaskDetail; spec: ActionSpec; onDone: () => void }) {
  const flash = useFlash();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const disabled = spec.field?.required === true && value.trim() === "";

  const run = async () => {
    if (spec.confirm && !window.confirm(`${spec.label} ${task.qualifiedSlug}?`)) return;
    const fields: Record<string, string> = { ...(spec.fixed ?? {}) };
    if (spec.field && value.trim() !== "") fields[spec.field.name] = value;
    try {
      const r = await api.mutateTask(task.qualifiedSlug, spec.action, fields);
      flash("ok", r.message ?? `${spec.action}: ok`);
      setValue("");
      // Archive moves the file: complete (type=pr default) and archive both
      // can leave this URL resolving to the archived copy — stay put, refetch.
      onDone();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    }
    void navigate; // reserved for future redirects
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button onClick={run} disabled={disabled}
                className="rounded border border-edge px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-40">
          {spec.label}
        </button>
        {spec.field && !spec.field.multiline && (
          <input value={value} onChange={e => setValue(e.target.value)} placeholder={spec.field.placeholder}
                 className="min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-xs" />
        )}
      </div>
      {spec.field?.multiline && (
        <textarea value={value} onChange={e => setValue(e.target.value)} placeholder={spec.field.placeholder} rows={2}
                  className="w-full rounded border border-edge bg-surface px-2 py-1 text-xs" />
      )}
    </div>
  );
}

function SettingsPanel({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const flash = useFlash();
  if (task.archived || task.isParent) return null;
  const set = async (action: string, fields: Record<string, string>) => {
    try {
      const r = await api.mutateTask(task.qualifiedSlug, action, fields);
      flash("ok", r.message ?? "ok");
      onDone();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <SectionCard title="Settings">
      <div className="flex flex-col gap-2 p-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={task.allowOrchestrator}
                 onChange={e => set("allow-orchestrator", { allow: e.target.checked ? "true" : "false" })} />
          autonomous (allow_orchestrator)
        </label>
        <label className="flex items-center gap-2">
          type
          <select value={task.type ?? "pr"} onChange={e => set("set-type", { type: e.target.value })}
                  className="rounded border border-edge bg-surface px-2 py-0.5 text-xs">
            <option value="pr">pr</option>
            <option value="investigation">investigation</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          status
          <select
            value={task.status}
            onChange={e => set("status", { status: e.target.value })}
            className="rounded border border-edge bg-surface px-2 py-0.5 text-xs"
            title="raw status set — the transition table refuses illegal moves"
          >
            {["open", "ready", "in-progress", "rework", "closing", "review", "blocked", "done", "dropped"].map(st => (
              <option key={st} value={st}>{st}</option>
            ))}
          </select>
        </label>
      </div>
    </SectionCard>
  );
}

const BADGE_TONES: Record<string, string> = {
  good: "bg-ok-soft text-ok",
  bad: "bg-danger-soft text-danger",
  warn: "bg-warn-soft text-warn",
  meh: "bg-hairline text-muted",
};

function tone(kind: string, v: string | undefined): string {
  if (!v) return BADGE_TONES.meh;
  const val = v.toUpperCase();
  if (kind === "state") return val === "MERGED" ? BADGE_TONES.good : val === "CLOSED" ? BADGE_TONES.bad : BADGE_TONES.warn;
  if (kind === "ci") return val === "PASS" ? BADGE_TONES.good : val === "FAIL" ? BADGE_TONES.bad : val === "PENDING" ? BADGE_TONES.warn : BADGE_TONES.meh;
  if (kind === "review") return val === "APPROVED" ? BADGE_TONES.good : val === "CHANGES_REQUESTED" ? BADGE_TONES.bad : BADGE_TONES.meh;
  if (kind === "mergeable") return val === "CLEAN" ? BADGE_TONES.good : val === "DIRTY" || val === "BLOCKED" ? BADGE_TONES.bad : BADGE_TONES.meh;
  return BADGE_TONES.meh;
}

function PrPanel({ prs }: { prs: PrDigest[] }) {
  return (
    <SectionCard title={`Pull request${prs.length === 1 ? "" : "s"}`}>
      {prs.map(pr => (
        <div key={pr.url} className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2 text-sm last:border-0">
          <a href={pr.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
            PR {pr.displayId ?? pr.url}
          </a>
          {pr.title && <span className="min-w-0 flex-1 truncate text-muted">{pr.title}</span>}
          {pr.fresh ? (
            <span className="flex gap-1.5">
              {(["state", "ci", "review", "mergeable"] as const).map(k => pr[k] && (
                <span key={k} className={`rounded px-1.5 py-0.5 text-xs ${tone(k, pr[k])}`} title={k}>
                  {String(pr[k]).toLowerCase()}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-xs text-faint">
              {pr.fetchedAt ? "cache stale — awaiting next poll" : "no PR data cached yet"}
            </span>
          )}
        </div>
      ))}
    </SectionCard>
  );
}
