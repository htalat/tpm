import { useCallback, useMemo, useState } from "react";
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
  clear: () => void;
  isSelected: (slug: string) => boolean;
}

export function useSelection(): Selection {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = useCallback((slug: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const isSelected = useCallback((slug: string) => selected.has(slug), [selected]);
  return { selected, toggle, clear, isSelected };
}

// One-stop wiring for a page: selection state + row gating + the bar itself.
// `tasks` is everything selectable on the page (deduped by qualified slug).
export function useBulk(tasks: TaskSummary[], onDone: () => void) {
  const selection = useSelection();
  const vocab = useData(() => api.vocab(), []);
  const rowSelection: RowSelection = useMemo(() => ({
    selectable: t => Boolean(vocab.data?.bulkCaps?.[t.status]?.length),
    isSelected: selection.isSelected,
    toggle: selection.toggle,
  }), [vocab.data, selection]);
  const bar = <BulkBar selection={selection} tasks={tasks} vocab={vocab.data} onDone={onDone} />;
  return { rowSelection, bar };
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
