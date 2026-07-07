import { api } from "../api";
import { useData, useRevalidateOnFocus } from "../hooks";
import { Empty, SectionCard } from "../components";

// Read-only view of ~/.tpm/config.json (the snapshot reader is non-throwing:
// it distinguishes missing file / parse error / valid config). Edits go
// through the CLI or the harness worker stepper — same as the SSR page.
export default function ConfigPage() {
  const snap = useData(() => api.config(), []);
  useRevalidateOnFocus(snap.refresh);

  if (snap.error) return <p className="text-sm text-danger">Failed to load: {snap.error}</p>;
  if (!snap.data) return <p className="text-sm text-muted">Loading…</p>;
  const cfg = snap.data.config;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Config</h1>
        <code className="text-xs text-faint">{cfg.path}</code>
        <span className="flex-1" />
        <a href="/config" className="text-xs text-muted hover:underline">classic</a>
      </header>

      {cfg.missing && <Empty text="No config file yet — run `tpm init` to create one." />}
      {cfg.error && (
        <SectionCard title="Parse error">
          <p className="px-3 py-2 text-sm text-danger">{cfg.error}</p>
        </SectionCard>
      )}
      {cfg.parsed && (
        <SectionCard title="Fields">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3 py-2 text-sm">
            {Object.entries(cfg.parsed).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-muted">{k}</dt>
                <dd className="min-w-0 break-all font-mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      )}
      {cfg.raw && (
        <SectionCard title="Raw">
          <pre className="overflow-x-auto px-3 py-2 font-mono text-xs">{cfg.raw}</pre>
        </SectionCard>
      )}
    </div>
  );
}
