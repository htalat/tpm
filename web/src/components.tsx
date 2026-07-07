import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { TaskSummary } from "./types";
import { taskHref } from "./lib";

// ---- status badge -----------------------------------------------------------

const KNOWN_STATUSES = new Set([
  "open", "ready", "in-progress", "rework", "closing", "review",
  "blocked", "done", "dropped", "active", "archived", "paused",
]);

export function StatusBadge({ status }: { status: string }) {
  const cls = KNOWN_STATUSES.has(status) ? `s-${status}` : "s-unknown";
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ---- flash toasts -----------------------------------------------------------

interface Flash {
  id: number;
  kind: "ok" | "error";
  text: string;
}

const FlashContext = createContext<(kind: Flash["kind"], text: string) => void>(() => {});

export function useFlash() {
  return useContext(FlashContext);
}

export function FlashProvider({ children }: { children: ReactNode }) {
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const push = useCallback((kind: Flash["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setFlashes(f => [...f, { id, kind, text }]);
    setTimeout(() => setFlashes(f => f.filter(x => x.id !== id)), 6000);
  }, []);
  return (
    <FlashContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-96 max-w-[90vw] flex-col gap-2">
        {flashes.map(f => (
          <div
            key={f.id}
            className={`rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur ${
              f.kind === "error"
                ? "border-red-300 bg-red-50/95 text-red-900 dark:border-red-800 dark:bg-red-950/95 dark:text-red-200"
                : "border-emerald-300 bg-emerald-50/95 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/95 dark:text-emerald-200"
            }`}
          >
            <pre className="whitespace-pre-wrap break-words font-sans">{f.text}</pre>
          </div>
        ))}
      </div>
    </FlashContext.Provider>
  );
}

// ---- task rows --------------------------------------------------------------

export function TaskRow({ task, actions }: { task: TaskSummary; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-neutral-200 px-2 py-1.5 text-sm last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
      <StatusBadge status={task.status} />
      <a href={taskHref(task)} className="shrink-0 font-mono text-[13px] text-blue-700 hover:underline dark:text-blue-400">
        {task.qualifiedSlug}
      </a>
      <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">{task.title}</span>
      {task.lock && (
        <span title={`held by ${task.lock.agentId} (pid ${task.lock.pid}) since ${task.lock.acquired}`}
              className="rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {task.lock.agentId}
        </span>
      )}
      {task.prs.length > 0 && (
        <a href={task.prs[task.prs.length - 1]} target="_blank" rel="noreferrer"
           className="rounded bg-neutral-100 px-1.5 text-xs text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700">
          PR{task.prs.length > 1 ? ` ×${task.prs.length}` : ""}
        </a>
      )}
      {task.type === "investigation" && (
        <span className="rounded bg-neutral-100 px-1.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500">inv</span>
      )}
      {actions}
    </div>
  );
}

// ---- section card -----------------------------------------------------------

export function SectionCard({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex items-baseline justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{title}</h2>
        {meta && <span className="text-xs text-neutral-500">{meta}</span>}
      </header>
      <div>{children}</div>
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="px-3 py-3 text-sm text-neutral-500">{text}</p>;
}

// ---- masthead ---------------------------------------------------------------

export function Masthead() {
  return (
    <header className="mb-6 flex items-center gap-4 border-b border-neutral-200 pb-3 dark:border-neutral-800">
      <Link to="/" className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
        tpm
      </Link>
      <form action="/search" method="get" className="flex-1">
        <input
          type="search"
          name="q"
          placeholder="slug, title, status, tag, PR URL, body…"
          className="w-full max-w-md rounded-lg border border-neutral-300 bg-white px-3 py-1 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
        />
      </form>
      <a href="/" className="text-xs text-neutral-500 hover:underline" title="server-rendered pages">
        classic
      </a>
    </header>
  );
}
