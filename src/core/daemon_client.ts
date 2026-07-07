import { readConfig, serveBaseUrl } from "./config.ts";
import { findRoot } from "./root.ts";
import type { CommandResult } from "./commands.ts";

// Single-writer step 2: when a serve/up daemon is running, the CLI forwards
// its mutation verbs to POST /api/cli instead of writing task files from a
// second process. Falls back to local execution when no daemon answers (or
// an older daemon lacks the endpoint), so plain `tpm` keeps working with
// nothing running.
//
// TPM_NO_DAEMON=1 forces local execution — used by tests and as the escape
// hatch if the daemon misbehaves.

export async function tryDaemon(argv: string[], baseOverride?: string): Promise<CommandResult | null> {
  if (process.env.TPM_NO_DAEMON) return null;
  let base: string;
  let root: string;
  try {
    base = baseOverride ?? serveBaseUrl(readConfig());
    // The daemon executes against ITS root. Sending ours lets it refuse when
    // two trees share the default port (throwaway trees, tests) — a 409 means
    // "not your tree", and local execution is the correct writer.
    root = findRoot();
  } catch {
    return null; // unreadable config / no tree — local execution surfaces it
  }
  try {
    const res = await fetch(`${base}/api/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, root, actor: process.env.TPM_AGENT_ID || "cli" }),
      // Loopback: connection refusal is instant; the timeout only guards a
      // wedged daemon. Generous enough for a tree walk, short enough that a
      // hung process doesn't stall every CLI call.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null; // older daemon without /api/cli → run locally
    const body = (await res.json()) as Partial<CommandResult>;
    if (typeof body.ok !== "boolean") return null;
    return { ok: body.ok, stdout: body.stdout ?? "", stderr: body.stderr ?? "" };
  } catch {
    return null; // no daemon listening (or it died mid-request) → run locally
  }
}
