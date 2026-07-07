import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findRoot } from "./root.ts";
import { flatTasks, loadProjects } from "./tree.ts";
import { CONFIG_PATH, readConfig, serveBaseUrl } from "./config.ts";
import { eventsPath } from "./events.ts";
import { listTaskLocks } from "./orchestrate/lock.ts";
import { migrateTree } from "./migrate.ts";
import { API_VERSION } from "../web/api.ts";
import { SPA_DIST } from "../web/serve.ts";

// `tpm doctor` — one read-only pass over the failure modes that otherwise
// surface slowly and confusingly: a daemon older than the checkout (dead UI
// controls), a stale SPA build after a pull (old UI, silently), a bloating
// journal, stale locks, pre-rename statuses. Each check is a small function
// over explicit inputs so tests don't need the real environment.

export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
}

// Rotation fires at JOURNAL_MAX_BYTES (events.ts) on every append; a journal
// past twice that means rotation isn't working (permissions, external writer).
const JOURNAL_WARN_BYTES = 10 * 1024 * 1024;
// A lock heartbeat this old with no sweep is hygiene debt.
const LOCK_STALE_MINUTES = 120;

export function checkConfig(): DoctorCheck {
  try {
    readConfig();
    return { name: "config", level: "ok", detail: CONFIG_PATH };
  } catch (e) {
    return { name: "config", level: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

export function checkTree(root: string): DoctorCheck {
  try {
    const projects = loadProjects(root, { archived: true });
    const tasks = projects.reduce((n, p) => n + flatTasks(p.tasks).length, 0);
    return { name: "tree", level: "ok", detail: `${root} — ${projects.length} projects, ${tasks} tasks` };
  } catch (e) {
    return { name: "tree", level: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

export function checkLegacyStatuses(root: string): DoctorCheck {
  const r = migrateTree(root, { dryRun: true });
  if (r.changes.length === 0) return { name: "statuses", level: "ok", detail: `all ${r.scanned} tasks on the current vocabulary` };
  return { name: "statuses", level: "warn", detail: `${r.changes.length} task(s) still on pre-rename statuses — run: tpm migrate` };
}

export function checkJournal(root: string): DoctorCheck {
  const path = eventsPath(root);
  if (!existsSync(path)) return { name: "journal", level: "ok", detail: "no journal yet" };
  const bytes = statSync(path).size;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  if (bytes > JOURNAL_WARN_BYTES) {
    return { name: "journal", level: "warn", detail: `${path} is ${mb} MB — auto-rotation should have fired at 5 MB; check permissions` };
  }
  return { name: "journal", level: "ok", detail: `${mb} MB` };
}

export function checkLocks(root: string): DoctorCheck {
  const locks = listTaskLocks(root);
  const stale = locks.filter(l => l.ageMinutes > LOCK_STALE_MINUTES);
  if (stale.length > 0) {
    return { name: "locks", level: "warn", detail: `${stale.length} lock(s) older than ${LOCK_STALE_MINUTES}m (${stale.map(l => l.qualifiedSlug).join(", ")}) — run: tpm lock release-stale` };
  }
  return { name: "locks", level: "ok", detail: locks.length === 0 ? "none held" : `${locks.length} held, none stale` };
}

// Newest mtime under a directory tree (skips node_modules/dot dirs). Small
// trees only — web/src and web/dist.
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    const st = statSync(p);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : st.mtimeMs);
  }
  return newest;
}

export function checkSpaBuild(distDir: string = SPA_DIST): DoctorCheck {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) {
    return { name: "spa build", level: "warn", detail: "web/dist missing — run: npm --prefix web install && npm --prefix web run build" };
  }
  const srcDir = join(distDir, "..", "src");
  if (!existsSync(srcDir)) return { name: "spa build", level: "ok", detail: "built (no source checkout to compare)" };
  const srcNewest = newestMtime(srcDir);
  const distNewest = newestMtime(distDir);
  if (srcNewest > distNewest) {
    return { name: "spa build", level: "warn", detail: "web/src is newer than web/dist — rebuild: npm --prefix web run build" };
  }
  return { name: "spa build", level: "ok", detail: "built and current" };
}

export async function checkDaemon(root: string, base?: string): Promise<DoctorCheck> {
  const url = base ?? serveBaseUrl(readConfig());
  let vocab: { apiVersion?: number };
  try {
    const res = await fetch(`${url}/api/vocab`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) throw new Error(`vocab: ${res.status}`);
    vocab = (await res.json()) as { apiVersion?: number };
  } catch {
    return { name: "daemon", level: "ok", detail: `none running at ${url} (CLI executes locally)` };
  }
  if ((vocab.apiVersion ?? 0) < API_VERSION) {
    return { name: "daemon", level: "warn", detail: `running at ${url} but older than this checkout (api v${vocab.apiVersion ?? 0} < v${API_VERSION}) — restart it` };
  }
  // Same wire version — does it serve THIS tree? A root-mismatch daemon means
  // CLI mutations silently run locally (correct, but worth knowing).
  try {
    const res = await fetch(`${url}/api/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv: ["status"], root }),
      signal: AbortSignal.timeout(1_500),
    });
    if (res.status === 409) return { name: "daemon", level: "warn", detail: `running at ${url} but serving a DIFFERENT tree — CLI mutations execute locally` };
    if (res.ok) return { name: "daemon", level: "ok", detail: `running at ${url}, current, single-writer active` };
    return { name: "daemon", level: "warn", detail: `running at ${url} but /api/cli answered ${res.status} — restart it` };
  } catch {
    return { name: "daemon", level: "warn", detail: `running at ${url} but /api/cli unreachable — restart it` };
  }
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [checkConfig()];
  let root: string | null = null;
  try {
    root = findRoot();
  } catch (e) {
    checks.push({ name: "tree", level: "fail", detail: e instanceof Error ? e.message : String(e) });
  }
  if (root) {
    checks.push(checkTree(root));
    checks.push(checkLegacyStatuses(root));
    checks.push(checkJournal(root));
    checks.push(checkLocks(root));
  }
  checks.push(checkSpaBuild());
  if (root) checks.push(await checkDaemon(root));
  return checks;
}

const GLYPH = { ok: "✓", warn: "!", fail: "✗" } as const;

export function formatDoctor(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map(c => c.name.length));
  return checks.map(c => `${GLYPH[c.level]} ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}
