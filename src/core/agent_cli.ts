import type { Project, Task } from "./tree.ts";

// Agent CLI registry — claude, copilot, etc. Each entry knows how to invoke
// its binary, what NDJSON dialect it emits, and which env var (if any) lets
// an operator override the bin path without touching code. The orchestrator
// picks an entry via `resolveAgentCli` (task > project > config > default)
// and spawns `entry.bin` with `entry.buildArgs(prompt, repoLocal)`.
//
// This is orthogonal to src/agents.ts, which is a registry of agent-id repo
// affinity for `tpm next --claim` (which *runner* claims a task). The
// agent-cli registry answers a different question — which *binary* to invoke
// for the agent's coding session.

export type AgentOutputFormat = "claude-stream-json" | "copilot-json" | "text";

export interface AgentCli {
  name: string;
  bin: string;
  envVar?: string;
  outputFormat: AgentOutputFormat;
  buildArgs: (prompt: string, repoLocal: string) => string[];
}

// Open-ended registry. Adding a new agent CLI = append an entry here. The
// shape is small enough that a class hierarchy would just add ceremony.
export const AGENT_CLIS: Record<string, AgentCli> = {
  claude: {
    name: "claude",
    bin: "claude",
    envVar: "CLAUDE_BIN",
    outputFormat: "claude-stream-json",
    // `--verbose` is required alongside `--output-format stream-json` for
    // claude to emit NDJSON events as they happen; without it the CLI only
    // prints the final message. `--add-dir` is redundant with spawn `cwd`
    // (task 084) but harmless and documents the allowed scope explicitly.
    // `--disallowed-tools AskUserQuestion` is the structural belt to task
    // 085's prompt-side rule: an orchestrator run has no human on the other
    // end, so the question tool is dead weight — deny it at the CLI surface
    // so a prompt regression can't reintroduce the halt.
    // Prompt is anchored as `-p`'s value (not trailing) because
    // `--disallowed-tools` is variadic-greedy in claude's CLI — a trailing
    // positional gets eaten as another tool name and claude exits with
    // "Input must be provided either through stdin or as a prompt argument."
    buildArgs: (prompt, repoLocal) => [
      "-p", prompt,
      "--add-dir", repoLocal,
      "--output-format", "stream-json",
      "--verbose",
      "--disallowed-tools", "AskUserQuestion",
    ],
  },
  copilot: {
    name: "copilot",
    bin: "copilot",
    envVar: "COPILOT_BIN",
    outputFormat: "copilot-json",
    // `--allow-all-tools` + `--no-ask-user` make copilot non-interactive
    // (the analogue of claude's `~/.claude/settings.json` permission grant
    // and task 085's "never ask, always act" prompt rule). `--autopilot`
    // lets copilot loop on its own — without it the CLI exits after one
    // turn, which would make every orchestrator run a one-shot.
    buildArgs: (prompt, repoLocal) => [
      "-p", prompt,
      "--add-dir", repoLocal,
      "--output-format", "json",
      "--allow-all-tools",
      "--no-ask-user",
      "--autopilot",
    ],
  },
};

export const DEFAULT_AGENT_CLI = "claude";

export interface ResolveAgentInput {
  task?: Task;
  project?: Project;
  configAgent?: string;
  // Invocation-time override (the `--agent <name>` flag on `tpm orchestrate`).
  // Wins over frontmatter so an operator can sanity-check a copilot dispatch
  // on a claude-default task without editing files.
  override?: string;
}

// Precedence: explicit override > task frontmatter > project frontmatter >
// global config > registry default. Throws on unknown name so a typo in
// frontmatter fails the dispatch loudly instead of silently falling back
// (and the failure surfaces in the orchestrator log envelope, not deep
// inside a child process).
export function resolveAgentCli(input: ResolveAgentInput): AgentCli {
  const name =
    pickName(input.override) ??
    pickName(input.task?.data.agent) ??
    pickName(input.project?.data.agent) ??
    pickName(input.configAgent) ??
    DEFAULT_AGENT_CLI;
  const entry = AGENT_CLIS[name];
  if (!entry) {
    const known = Object.keys(AGENT_CLIS).join(", ");
    throw new Error(`unknown agent "${name}". Known: ${known}`);
  }
  return applyBinOverride(entry);
}

// Apply env-var bin override (e.g. CLAUDE_BIN=/opt/homebrew/bin/claude).
// Returns a shallow copy so the registry constant stays unmutated.
function applyBinOverride(entry: AgentCli): AgentCli {
  if (!entry.envVar) return entry;
  const overridden = process.env[entry.envVar];
  if (!overridden) return entry;
  return { ...entry, bin: overridden };
}

function pickName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}
