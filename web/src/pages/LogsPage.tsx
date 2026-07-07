import { useState } from "react";
import { api } from "../api";
import { useData, useRevalidateOnFocus, useSse } from "../hooks";
import { Empty, SectionCard } from "../components";
import type { LogLine } from "../types";

const LEVEL_CLS: Record<string, string> = {
  ERROR: "text-danger",
  WARN: "text-warn",
  INFO: "text-muted",
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
                className="rounded border border-edge bg-surface px-2 py-1 text-sm">
          <option value="">all sources</option>
          <option value="orchestrate">orchestrate</option>
          <option value="poller">poller</option>
        </select>
        <select value={lines} onChange={e => setLines(Number(e.target.value))}
                className="rounded border border-edge bg-surface px-2 py-1 text-sm">
          {[50, 200, 500, 2000].map(n => <option key={n} value={n}>last {n}</option>)}
        </select>
        <a href="/logs" className="text-xs text-muted hover:underline">classic</a>
      </header>

      {feed.error && <p className="text-sm text-danger">{feed.error}</p>}
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
  if (!line.timestamp) return <div className="whitespace-pre-wrap break-all text-muted">{line.raw}</div>;
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-faint">{line.timestamp}</span>
      {line.level && <span className={`w-12 shrink-0 ${LEVEL_CLS[line.level] ?? ""}`}>{line.level}</span>}
      {line.script && <span className="shrink-0 text-faint">{line.script}</span>}
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.message ?? line.raw}</span>
    </div>
  );
}
