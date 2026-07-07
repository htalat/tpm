import { createContext, useCallback, useContext, useState } from "react";
import type { SVGProps } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
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
                ? "border-danger/40 bg-danger-soft/95 text-danger"
                : "border-ok/40 bg-ok-soft/95 text-ok"
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

export interface RowSelection {
  selectable: (task: TaskSummary) => boolean;
  isSelected: (slug: string) => boolean;
  toggle: (slug: string) => void;
}

export function TaskRow({ task, actions, selection }: { task: TaskSummary; actions?: ReactNode; selection?: RowSelection }) {
  return (
    <div className="flex items-center gap-3 border-b border-edge px-2 py-1.5 text-sm last:border-0 hover:bg-surface-hover">
      {selection && (
        <input
          type="checkbox"
          className="accent-[var(--accent-solid)]"
          disabled={!selection.selectable(task)}
          checked={selection.isSelected(task.qualifiedSlug)}
          onChange={() => selection.toggle(task.qualifiedSlug)}
          aria-label={`select ${task.qualifiedSlug}`}
        />
      )}
      <StatusBadge status={task.status} />
      <Link to={taskHref(task)} className="shrink-0 font-mono text-[13px] text-accent hover:underline">
        {task.qualifiedSlug}
      </Link>
      <span className="min-w-0 flex-1 truncate text-ink/90">{task.title}</span>
      {task.lock && (
        <span title={`held by ${task.lock.agentId} (pid ${task.lock.pid}) since ${task.lock.acquired}`}
              className="rounded bg-warn-soft px-1.5 text-xs text-warn">
          {task.lock.agentId}
        </span>
      )}
      {task.prs.length > 0 && (
        <a href={task.prs[task.prs.length - 1]} target="_blank" rel="noreferrer"
           className="rounded bg-hairline px-1.5 text-xs text-muted hover:bg-edge">
          PR{task.prs.length > 1 ? ` ×${task.prs.length}` : ""}
        </a>
      )}
      {task.type === "investigation" && (
        <span className="rounded bg-hairline px-1.5 text-xs text-muted">inv</span>
      )}
      {actions}
    </div>
  );
}

// ---- section card -----------------------------------------------------------

export function SectionCard({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-surface">
      <header className="flex items-baseline justify-between border-b border-edge px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {meta && <span className="text-xs text-muted">{meta}</span>}
      </header>
      <div>{children}</div>
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="px-3 py-3 text-sm text-muted">{text}</p>;
}

// ---- theme toggle -----------------------------------------------------------

// Tri-state: light / system / dark. The choice is stamped as data-theme on
// <html> (index.html re-applies it pre-bundle so there's no flash) and every
// token flips via CSS light-dark() — no per-component theme knowledge.
type Theme = "light" | "system" | "dark";

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

function applyTheme(theme: Theme) {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem("tpm-theme"); } catch { /* private mode */ }
  } else {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("tpm-theme", theme); } catch { /* private mode */ }
  }
}

const icon = (d: string) => (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
       strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d={d} />
  </svg>
);
// Sun: core + rays. Monitor: screen + stand. Moon: crescent.
const SunIcon = icon("M8 5.2A2.8 2.8 0 1 1 8 10.8 2.8 2.8 0 0 1 8 5.2Zm0-3.7v1.6M8 12.9v1.6M2.3 8h1.6M12.1 8h1.6M3.9 3.9l1.2 1.2M10.9 10.9l1.2 1.2M12.1 3.9l-1.2 1.2M5.1 10.9l-1.2 1.2");
const MonitorIcon = icon("M2 3.5h12v8H2zM6 14h4M8 11.5V14");
const MoonIcon = icon("M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z");

const THEME_OPTIONS: { value: Theme; label: string; Icon: ReturnType<typeof icon> }[] = [
  { value: "light", label: "light", Icon: SunIcon },
  { value: "system", label: "system", Icon: MonitorIcon },
  { value: "dark", label: "dark", Icon: MoonIcon },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const choose = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <div className="flex items-center rounded-full border border-edge p-0.5" role="radiogroup" aria-label="color theme">
      {THEME_OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          title={`${label} theme`}
          onClick={() => choose(value)}
          className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
            theme === value
              ? "bg-surface-hover text-ink shadow-sm ring-1 ring-edge"
              : "text-faint hover:text-muted"
          }`}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

// ---- masthead ---------------------------------------------------------------

function MastheadSearch() {
  const navigate = useNavigate();
  return (
    <form
      className="flex-1"
      onSubmit={e => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
        if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
      }}
    >
      <input
        type="search"
        name="q"
        placeholder="slug, title, status, tag, PR URL, body…"
        className="w-full max-w-md rounded-lg border border-edge bg-surface px-3 py-1 text-sm outline-none focus:border-accent"
      />
    </form>
  );
}

export function Masthead() {
  return (
    <header className="mb-6 flex items-center gap-4 border-b border-edge pb-3">
      <Link to="/" className="text-lg font-bold tracking-tight text-ink">
        tpm
      </Link>
      <MastheadSearch />
      <nav className="flex items-center gap-3 text-xs text-muted">
        <Link to="/logs" className="hover:underline">logs</Link>
        <Link to="/config" className="hover:underline">config</Link>
      </nav>
      <ThemeToggle />
    </header>
  );
}
