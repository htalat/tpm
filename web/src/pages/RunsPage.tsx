import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { useData } from "../hooks";
import { Empty, SectionCard } from "../components";

// Per-task runs: run-log list + the latest run's transcript tail. While the
// task is in-progress the tail advances every 2s via the byte-offset endpoint
// (same JSON contract the SSR live script consumes); fragments arrive as
// server-rendered <li> HTML.

export default function RunsPage() {
  const segments = useLocation().pathname.replace(/^\/t\//, "").replace(/\/runs$/, "").split("/").map(decodeURIComponent);
  const feed = useData(() => api.runs(segments), [segments.join("/")]);

  if (feed.error) return <p className="text-sm text-red-600">Failed to load: {feed.error}</p>;
  if (!feed.data) return <p className="text-sm text-neutral-500">Loading…</p>;
  const { runs, latest } = feed.data;
  const taskPath = `/t/${segments.map(encodeURIComponent).join("/")}`;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Runs</h1>
        <span className="font-mono text-sm text-neutral-400">{segments.join("/")}</span>
        <span className="flex-1" />
        <Link to={taskPath} className="text-sm text-blue-600 hover:underline dark:text-blue-400">Back to task →</Link>
      </header>

      {latest ? (
        <LiveRunPanel key={latest.name} latest={latest} />
      ) : (
        <Empty text="No run log on disk yet — this task hasn't been dispatched by tpm orchestrate." />
      )}

      <SectionCard title="All runs" meta={`${runs.length}`}>
        {runs.length === 0 ? <Empty text="None." /> : (
          <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-900">
            {runs.map(r => (
              <li key={r.name} className="flex items-center gap-3 px-3 py-1.5">
                <a href={`${taskPath.replace("/app", "")}/runs/${encodeURIComponent(r.name)}`}
                   className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400">{r.name}</a>
                <span className="text-xs text-neutral-400">{r.timestamp}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function LiveRunPanel({ latest }: { latest: NonNullable<Awaited<ReturnType<typeof api.runs>>["latest"]> }) {
  const [running, setRunning] = useState(latest.running);
  const listRef = useRef<HTMLOListElement>(null);
  const offsetRef = useRef(latest.offset);

  useEffect(() => {
    if (!latest.running) return;
    const timer = setInterval(async () => {
      try {
        const chunk = await api.tail(latest.tailPath, offsetRef.current, latest.format);
        if (chunk.html && listRef.current) {
          listRef.current.insertAdjacentHTML("beforeend", chunk.html);
          listRef.current.parentElement?.scrollTo({ top: listRef.current.parentElement.scrollHeight });
        }
        offsetRef.current = chunk.offset;
        if (!chunk.running) setRunning(false);
      } catch {
        // transient — next tick retries
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [latest.running, latest.tailPath, latest.format]);

  return (
    <SectionCard
      title={running ? "Current run (live)" : "Last run"}
      meta={<span className="font-mono">{latest.name}{running && <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 align-middle" />}</span>}
    >
      {latest.skipped > 0 && (
        <p className="px-3 pt-2 text-xs text-amber-600">{latest.parsed} events parsed, {latest.skipped} skipped — file may be truncated.</p>
      )}
      <div className="max-h-[32rem] overflow-y-auto px-3 py-2">
        {latest.html === "" && !running ? (
          <Empty text="Log file is empty." />
        ) : (
          <ol ref={listRef} className="run-events flex flex-col gap-1 text-sm" dangerouslySetInnerHTML={{ __html: latest.html }} />
        )}
      </div>
      <p className="border-t border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-800">
        {latest.totalEvents > latest.shownEvents && <span className="text-neutral-400">showing last {latest.shownEvents} of {latest.totalEvents} events · </span>}
        {latest.sessionId && <span className="text-neutral-400">session <code className="select-all">{latest.sessionId}</code> · </span>}
        <a href={latest.rawPath} className="text-blue-600 hover:underline dark:text-blue-400">View raw log →</a>
      </p>
    </SectionCard>
  );
}
