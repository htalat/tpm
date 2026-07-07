import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useFlash } from "./components";
import type { RowSelection } from "./components";
import { useData } from "./hooks";
import { intersectCaps } from "./lib";
import type { TaskSummary, Vocab } from "./types";

// Multi-select + bulk state updates. One selection set per page (keyed by
// qualified slug); rows opt in via TaskRow's `selection` prop. The bulk bar
// offers the intersection of the selected statuses' capabilities (served by
// /api/vocab as bulkCaps) — the per-row CLI call remains the enforcer, and a
// refusal never aborts the rest of the batch.

export interface Selection {
  selected: Set<string>;
  toggle: (slug: string) => void;
  // Shift-click: toggle the whole range between the last toggled slug and
  // this one, in the section's visual order.
  toggleRange: (slug: string, ordered: string[]) => void;
  setMany: (slugs: string[], on: boolean) => void;
  clear: () => void;
  isSelected: (slug: string) => boolean;
}

export function useSelection(): Selection {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const toggle = useCallback((slug: string) => {
    anchor.current = slug;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);
  const toggleRange = useCallback((slug: string, ordered: string[]) => {
    const from = anchor.current ? ordered.indexOf(anchor.current) : -1;
    const to = ordered.indexOf(slug);
    if (from === -1 || to === -1) {
      toggle(slug);
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const range = ordered.slice(lo, hi + 1);
    setSelected(prev => {
      const next = new Set(prev);
      for (const s of range) next.add(s);
      return next;
    });
  }, [toggle]);
  const setMany = useCallback((slugs: string[], on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const s of slugs) {
        if (on) next.add(s);
        else next.delete(s);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(new Set());
  }, []);
  const isSelected = useCallback((slug: string) => selected.has(slug), [selected]);
  return { selected, toggle, toggleRange, setMany, clear, isSelected };
}

// One-stop wiring for a page: selection state + row gating + the bar itself.
// `tasks` is everything selectable on the page (deduped by qualified slug).
// `rowsFor(sectionTasks)` binds a section's visual order so shift-click
// ranges and select-all stay section-scoped.
export function useBulk(tasks: TaskSummary[], onDone: () => void) {
  const selection = useSelection();
  const vocab = useData(() => api.vocab(), []);
  const selectable = useCallback(
    (t: TaskSummary) => Boolean(vocab.data?.bulkCaps?.[t.status]?.length),
    [vocab.data],
  );
  const rowsFor = useCallback((sectionTasks: TaskSummary[]): RowSelection => {
    const ordered = sectionTasks.map(t => t.qualifiedSlug);
    return {
      selectable,
      isSelected: selection.isSelected,
      toggle: (slug, shift) => (shift ? selection.toggleRange(slug, ordered) : selection.toggle(slug)),
    };
  }, [selectable, selection]);
  const bar = <BulkBar selection={selection} tasks={tasks} vocab={vocab.data} onDone={onDone} />;
  return { selection, selectable, rowsFor, bar };
}

// Header checkbox for a section: all / some / none of its selectable rows.
export function SelectAll({ tasks, selection, selectable }: {
  tasks: TaskSummary[];
  selection: Selection;
  selectable: (t: TaskSummary) => boolean;
}) {
  const slugs = tasks.filter(selectable).map(t => t.qualifiedSlug);
  const picked = slugs.filter(s => selection.isSelected(s)).length;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = picked > 0 && picked < slugs.length;
  }, [picked, slugs.length]);
  if (slugs.length === 0) return null;
  return (
    <input
      ref={ref}
      type="checkbox"
      className="mr-1 accent-[var(--accent-solid)]"
      checked={picked === slugs.length && slugs.length > 0}
      onChange={e => selection.setMany(slugs, e.target.checked)}
      title="select all in this section"
      aria-label="select all in this section"
    />
  );
}

// Keyboard layer: j/k move a cursor through the page's rows in visual order,
// x toggles the cursor row's selection, Escape clears, / focuses search.
// Skipped while typing in an input/textarea/select.
export function useKeyNav(ordered: TaskSummary[], selection: Selection, selectable: (t: TaskSummary) => boolean) {
  const [cursor, setCursor] = useState<string | null>(null);
  const state = useRef({ ordered, selection, selectable, cursor });
  state.current = { ordered, selection, selectable, cursor };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only real typing surfaces swallow shortcuts — a just-clicked checkbox
      // keeps focus and must not disable the keyboard layer.
      const target = e.target as HTMLElement;
      const inputType = target.tagName === "INPUT" ? (target as HTMLInputElement).type : null;
      const isTyping = target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable
        || (inputType !== null && inputType !== "checkbox" && inputType !== "radio" && inputType !== "button");
      if (isTyping) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { ordered, selection, selectable, cursor } = state.current;
      if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
        return;
      }
      if (e.key === "Escape") {
        selection.clear();
        setCursor(null);
        return;
      }
      if (e.key === "j" || e.key === "k") {
        if (ordered.length === 0) return;
        e.preventDefault();
        const idx = cursor ? ordered.findIndex(t => t.qualifiedSlug === cursor) : -1;
        const next = e.key === "j" ? Math.min(idx + 1, ordered.length - 1) : Math.max(idx - 1, 0);
        const slug = ordered[next]?.qualifiedSlug ?? null;
        setCursor(slug);
        if (slug) {
          document.querySelector(`[data-row="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      if (e.key === "x" && cursor) {
        const t = ordered.find(t => t.qualifiedSlug === cursor);
        if (t && selectable(t)) selection.toggle(cursor);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return cursor;
}

export function BulkBar({ selection, tasks, vocab, onDone }: {
  selection: Selection;
  tasks: TaskSummary[];
  vocab: Vocab | null;
  onDone: () => void;
}) {
  const flash = useFlash();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedTasks = useMemo(
    () => tasks.filter(t => selection.selected.has(t.qualifiedSlug)),
    [tasks, selection.selected],
  );

  // Intersection of every selected status's capabilities: only actions valid
  // for the whole selection are offered.
  const actions = useMemo(
    () => (vocab ? intersectCaps(selectedTasks.map(t => t.status), vocab.bulkCaps) : []),
    [vocab, selectedTasks],
  );

  if (selection.selected.size === 0) return null;
  const specs = vocab?.bulkActions ?? {};

  const run = async (action: string) => {
    const spec = specs[action];
    if (spec?.needsReason && !reason.trim()) return;
    setBusy(true);
    try {
      const r = await api.bulk(action, selectedTasks.map(t => t.qualifiedSlug), spec?.needsReason ? reason : undefined);
      const failures = r.results?.filter(x => !x.ok) ?? [];
      const summary = failures.length === 0
        ? `${spec?.label ?? action}: ${selectedTasks.length} task${selectedTasks.length === 1 ? "" : "s"} updated`
        : `${spec?.label ?? action}: ${selectedTasks.length - failures.length} updated, ${failures.length} refused\n` +
          failures.map(f => `${f.slug}: ${f.message}`).join("\n");
      flash(failures.length === 0 ? "ok" : "error", summary);
      selection.clear();
      setReason("");
    } catch (e) {
      flash("error", e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
    onDone();
  };

  const needsReason = actions.some(a => specs[a]?.needsReason);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2 text-sm">
        <span className="font-medium">{selection.selected.size} selected</span>
        <button onClick={selection.clear} className="text-xs text-muted hover:underline">clear</button>
        <span className="flex-1" />
        {actions.length === 0 && <span className="text-xs text-muted">no action applies to every selected task</span>}
        {actions.map(a => (
          <button
            key={a}
            disabled={busy || (specs[a]?.needsReason === true && reason.trim() === "")}
            onClick={() => run(a)}
            className="rounded border border-edge px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-40"
          >
            {specs[a]?.label ?? a}
          </button>
        ))}
        {needsReason && (
          <input
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="reason (required for Block; shared by all)"
            className="w-64 rounded border border-edge bg-surface px-2 py-1 text-xs"
          />
        )}
      </div>
    </div>
  );
}
