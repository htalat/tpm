import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

// Per-host agent registry. Lives next to ~/.tpm/config.json. Never synced via
// git — agents are local-process identities. Missing/empty file means
// "no affinity configured" and `tpm next --claim` behaves exactly as
// 035/001 ships it (no filtering).

export const AGENTS_PATH = join(CONFIG_DIR, "agents.json");

export interface AgentEntry {
  prefer_repos: string[];
  comment?: string;
}

export interface AgentsRegistry {
  agents: Record<string, AgentEntry>;
}

export function readAgentsRegistry(): AgentsRegistry {
  if (!existsSync(AGENTS_PATH)) return { agents: {} };
  const text = readFileSync(AGENTS_PATH, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse ${AGENTS_PATH}: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${AGENTS_PATH} must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const agentsRaw = record.agents;
  const out: Record<string, AgentEntry> = {};
  if (agentsRaw && typeof agentsRaw === "object" && !Array.isArray(agentsRaw)) {
    for (const [id, entryRaw] of Object.entries(agentsRaw as Record<string, unknown>)) {
      out[id] = readAgentEntry(entryRaw, id);
    }
  }
  return { agents: out };
}

export function writeAgentsRegistry(registry: AgentsRegistry): void {
  mkdirSync(dirname(AGENTS_PATH), { recursive: true });
  writeFileSync(AGENTS_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function readAgentEntry(value: unknown, id: string): AgentEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${AGENTS_PATH}: agent "${id}" must be an object`);
  }
  const record = value as Record<string, unknown>;
  let prefer_repos: string[] = [];
  if (record.prefer_repos !== undefined) {
    if (!Array.isArray(record.prefer_repos)) {
      throw new Error(`${AGENTS_PATH}: agent "${id}" prefer_repos must be an array`);
    }
    prefer_repos = (record.prefer_repos as unknown[]).map((v, i) => {
      if (typeof v !== "string") {
        throw new Error(`${AGENTS_PATH}: agent "${id}" prefer_repos[${i}] must be a string`);
      }
      return v;
    });
  }
  const out: AgentEntry = { prefer_repos };
  if (typeof record.comment === "string") out.comment = record.comment;
  return out;
}

// Affinity for an agent. Returns the agent's preferred-repos list, or empty
// when the agent has no entry (or registry is absent). Never throws on a
// missing registry — that's the "no affinity configured" path.
export function affinityFor(agentId: string): string[] {
  try {
    const reg = readAgentsRegistry();
    const entry = reg.agents[agentId];
    return entry ? [...entry.prefer_repos] : [];
  } catch {
    // A malformed registry shouldn't kill `tpm next --claim`. The CLI surface
    // would still run; the user sees the error when they invoke `tpm agents`.
    return [];
  }
}

export function setAgent(agentId: string, repoSlug: string, comment?: string): void {
  if (!agentId.trim()) throw new Error("agent-id is required");
  if (!repoSlug.trim()) throw new Error("--repo <slug> is required");
  const reg = existsSync(AGENTS_PATH) ? readAgentsRegistry() : { agents: {} };
  const existing = reg.agents[agentId] ?? { prefer_repos: [] };
  if (!existing.prefer_repos.includes(repoSlug)) {
    existing.prefer_repos = [...existing.prefer_repos, repoSlug];
  }
  if (comment !== undefined) existing.comment = comment;
  reg.agents[agentId] = existing;
  writeAgentsRegistry(reg);
}

export function removeAgent(agentId: string): boolean {
  if (!existsSync(AGENTS_PATH)) return false;
  const reg = readAgentsRegistry();
  if (!(agentId in reg.agents)) return false;
  delete reg.agents[agentId];
  writeAgentsRegistry(reg);
  return true;
}
