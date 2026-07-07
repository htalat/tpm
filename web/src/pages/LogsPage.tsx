import { useState } from "react";
import { api } from "../api";
import { useData, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard } from "../components";
import type { LogLine } from "../types";

const LEVEL_CLS: Record<string, string> = {
  ERROR: "text-red-600 dark:text-red-400",
  WARN: "text-amber-600 dark:text-amber-400",
  INFO: "text-neutral-500",
};

// Harness logs: one card per source (orchestrate-*, poller-*), tail-slice
// selectable. Data comes parsed from /api/logs; rendering stays dumb.
export default function LogsPage() {
  const [category, setCategory] = useState<"" | "orchestrate" | "poller">("");
  const [lines, setLines] = useState(200);
  const feed = useData(() => api.logs(category || undefined, lines), [category, lines]);
  useSse(feed.refresh);
  useRevalidateOnFocus(feed.refresh);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Logs</h1>
        <span className="flex-1" />
        <select value={category} onChange={e => setCategory(e.target.value as typeof category)}
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
          <option value="">all sources</option>
          <option value="orchestrate">orchestrate</option>
          <option value="poller">poller</option>
        </select>
        <select value={lines} onChange={e => setLines(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
          {[50, 200, 500, 2000].map(n => <option key={n} value={n}>last {n}</option>)}
        </select>
        <a href="/logs" className="text-xs text-neutral-500 hover:underline">classic</a>
      </header>

      {feed.error && <p className="text-sm text-red-600">{feed.error}</p>}
      {feed.data?.sources.length === 0 && <Empty text="No harness log files found under ~/.tpm." />}
      {feed.data?.sources.map(src => (
        <SectionCard key={src.name} title={src.name}
                     meta={src.exists ? `showing ${src.lines.length} of ${src.totalLines} · ${src.path}` : `missing — would be ${src.path}`}>
          {src.lines.length === 0 ? <Empty text="Empty." /> : (
            <div className="max-h-[28rem] overflow-y-auto px-3 py-2 font-mono text-xs leading-5">
              {src.lines.map((l, i) => <LogRow key={i} line={l} />)}
            </div>
          )}
        </SectionCard>
      ))}
    </div>
  );
}

function LogRow({ line }: { line: LogLine }) {
  if (!line.timestamp) return <div className="whitespace-pre-wrap break-all text-neutral-500">{line.raw}</div>;
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-neutral-400">{line.timestamp}</span>
      {line.level && <span className={`w-12 shrink-0 ${LEVEL_CLS[line.level] ?? ""}`}>{line.level}</span>}
      {line.script && <span className="shrink-0 text-neutral-400">{line.script}</span>}
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.message ?? line.raw}</span>
    </div>
  );
}
