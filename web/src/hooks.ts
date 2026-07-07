import { useCallback, useEffect, useRef, useState } from "react";

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

  return { data, error, loading, refresh };
}

// Subscribe to the status-journal SSE stream and invoke `onEvent` per journal
// message. The server heartbeats every 25s; EventSource auto-reconnects.
// Named-event contract mirrors the SSR live script: journal entries arrive as
// `event: status`, harness edges as `event: harness`.
export function useSse(onEvent: () => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const source = new EventSource("/events");
    const handler = () => cb.current();
    source.addEventListener("status", handler);
    source.addEventListener("harness", handler);
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
