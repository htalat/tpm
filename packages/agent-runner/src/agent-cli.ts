import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Agent CLI registry (ported from tpm). Each entry knows its binary, the env
 * var that overrides it, and the non-interactive flag set. Adding a CLI is
 * one entry. The engine never sees any of this: to it, an agent run is just
 * a step with capability "agent-cli".
 */
export interface AgentCli {
  name: string;
  bin: string;
  envVar?: string;
  buildArgs: (prompt: string, cwd: string, model?: string) => string[];
}

export const AGENT_CLIS: Record<string, AgentCli> = {
  claude: {
    name: 'claude',
    bin: 'claude',
    envVar: 'CLAUDE_BIN',
    // Prompt is the value of -p (not trailing): --disallowed-tools is variadic.
    buildArgs: (prompt, cwd, model) => [
      '-p',
      prompt,
      '--add-dir',
      cwd,
      '--output-format',
      'stream-json',
      '--verbose',
      '--disallowed-tools',
      'AskUserQuestion',
      ...(model ? ['--model', model] : []),
    ],
  },
  copilot: {
    name: 'copilot',
    bin: 'copilot',
    envVar: 'COPILOT_BIN',
    buildArgs: (prompt, cwd, model) => [
      '-p',
      prompt,
      '--add-dir',
      cwd,
      '--output-format',
      'json',
      '--allow-all-tools',
      '--no-ask-user',
      '--autopilot',
      ...(model ? ['--model', model] : []),
    ],
  },
};

export function resolveAgentCli(name: string, registry: Record<string, AgentCli> = AGENT_CLIS): AgentCli {
  const entry = registry[name];
  if (!entry) throw new Error(`unknown agent CLI "${name}" (known: ${Object.keys(registry).join(', ')})`);
  const override = entry.envVar ? process.env[entry.envVar] : undefined;
  return override ? { ...entry, bin: override } : entry;
}

export interface AgentProcessResult {
  exitCode: number | null;
  signal: string | null;
  /** Last ~64 KiB of combined output (for rate-limit detection and errors). */
  tail: string;
  spawnError?: string;
}

const TAIL_BYTES = 64 * 1024;

/**
 * Run an agent CLI to completion. Output goes to `logFile`. When `signal`
 * aborts (cancellation, lease loss, timeout), the whole process group gets
 * SIGTERM, then SIGKILL after `killGraceMs`, and the abort reason is thrown.
 */
export function runAgentProcess(opts: {
  bin: string;
  args: string[];
  cwd: string;
  logFile: string;
  signal: AbortSignal;
  env?: Record<string, string | undefined>;
  killGraceMs?: number;
}): Promise<AgentProcessResult> {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: 'a' });
  let tail = '';
  const keep = (chunk: Buffer) => {
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
  };
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(opts.signal.reason);
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group: kill the agent and everything it spawned
    });
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), opts.killGraceMs ?? 10_000);
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let settled = false;
    let spawnError: string | undefined;
    child.on('error', (e) => {
      spawnError = e.message;
      if (child.pid === undefined && !settled) {
        // Never started (ENOENT, EACCES): there will be no meaningful exit.
        settled = true;
        opts.signal.removeEventListener('abort', onAbort);
        log.end();
        resolve({ exitCode: null, signal: null, tail, spawnError });
      }
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      log.end();
      if (opts.signal.aborted) return reject(opts.signal.reason);
      resolve({ exitCode: code, signal: sig, tail, spawnError });
    });
  });
}
