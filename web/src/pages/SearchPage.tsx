import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useData } from "../hooks";
import { Empty, SectionCard, TaskRow } from "../components";

// Global search over slug / title / status / tags / PR URLs / body — the API
// reuses the SSR matcher, so ranking and snippets are identical.
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const archived = params.get("archived") === "1";
  const results = useData(() => (q ? api.search(q, archived) : Promise.resolve({ q, hits: [] })), [q, archived]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Search</h1>
        {q && results.data && (
          <span className="text-sm text-muted">
            {results.data.hits.length} result{results.data.hits.length === 1 ? "" : "s"} for <code>{q}</code>
          </span>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={archived}
                 onChange={e => setParams(e.target.checked ? { q, archived: "1" } : { q })} />
          include archived
        </label>
      </header>

      <form onSubmit={e => { e.preventDefault(); const v = new FormData(e.currentTarget).get("q"); setParams(archived ? { q: String(v ?? ""), archived: "1" } : { q: String(v ?? "") }); }}>
        <input
          name="q" type="search" defaultValue={q} autoFocus
          placeholder="slug, title, status, tag, PR URL, body…"
          className="w-full max-w-xl rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
      </form>

      {results.error && <p className="text-sm text-danger">{results.error}</p>}
      {q && results.data && (
        <SectionCard title="Results">
          {results.data.hits.length === 0 ? <Empty text={`No tasks match "${q}".`} /> : results.data.hits.map(h => (
            <div key={h.qualifiedSlug}>
              <TaskRow task={h} />
              {h.snippet && <p className="px-10 pb-1.5 text-xs text-muted"><Mark text={h.snippet} q={q} /></p>}
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  );
}

function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase()
          ? <mark key={i} className="rounded bg-warn/30 px-0.5">{p}</mark>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}
