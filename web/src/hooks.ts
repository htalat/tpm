import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusEvent } from "./types";

// Load-once-then-revalidate data hook. `deps` re-triggers; `refresh` is the
// imperative knob mutations + SSE use. Keeps the last good value during
// revalidation so the page never flashes empty.
export function useData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const gen = ++generation.current;
    loader().then(
      (value) => {
        if (generation.current !== gen) return; // superseded
        setData(value);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (generation.current !== gen) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  // In-place patch for push updates (SSE): callers apply what the event
  // says immediately and reconcile with a debounced refetch.
  const mutate = useCallback((updater: (current: T) => T) => {
    setData(current => (current === null ? current : updater(current)));
  }, []);

  return { data, error, loading, refresh, mutate };
}

// Trailing-edge debounce that survives re-renders. Bulk operations emit one
// journal line per task — the reconcile refetch should fire once per burst.
export function useDebounced(fn: () => void, ms: number): () => void {
  const cb = useRef(fn);
  cb.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => cb.current(), ms);
  }, [ms]);
}

// Subscribe to the status-journal SSE stream. Journal entries arrive as
// `event: status` with the StatusEventRecord line as data; harness edges as
// `event: harness`. The server heartbeats every 25s; EventSource reconnects.
export type SseMessage =
  | { kind: "status"; event: StatusEvent }
  | { kind: "harness" };

export function useSse(onMessage: (msg: SseMessage) => void) {
  const cb = useRef(onMessage);
  cb.current = onMessage;
  useEffect(() => {
    const source = new EventSource("/events");
    source.addEventListener("status", (ev: MessageEvent) => {
      try {
        cb.current({ kind: "status", event: JSON.parse(ev.data) as StatusEvent });
      } catch {
        // torn line — the debounced reconcile still runs via the next event
      }
    });
    source.addEventListener("harness", () => cb.current({ kind: "harness" }));
    return () => source.close();
  }, []);
}

// Revalidate-on-focus: fire `onFocus` when the tab regains visibility. The
// journal only carries status transitions — content edits don't emit events —
// so focus is the catch-all resync signal.
export function useRevalidateOnFocus(onFocus: () => void) {
  const cb = useRef(onFocus);
  cb.current = onFocus;
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") cb.current();
    };
    document.addEventListener("visibilitychange", handler);
    window.addEventListener("focus", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("focus", handler);
    };
  }, []);
}
