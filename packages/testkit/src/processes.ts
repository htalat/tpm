import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

/**
 * Starts and SIGKILLs real Node.js processes. SIGKILL is deliberate: no
 * shutdown hooks, no finally blocks, no flushing. That is the crash model.
 */
export class ProcessSupervisor {
  readonly procs = new Map<string, ManagedProcess>();
  private log: WriteStream | null = null;

  constructor(
    private readonly baseEnv: Record<string, string | undefined>,
    logFile?: string,
    private readonly echo = false,
  ) {
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      this.log = createWriteStream(logFile, { flags: 'a' });
    }
  }

  start(name: string, script: string, env: Record<string, string | undefined> = {}): ManagedProcess {
    if (this.procs.has(name)) throw new Error(`${name} already running`);
    const child = spawn(TSX, [join(REPO_ROOT, script)], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...this.baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prefix = (chunk: Buffer) =>
      chunk
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((l) => `[${name}] ${l}\n`)
        .join('');
    const onData = (c: Buffer) => {
      const s = prefix(c);
      this.log?.write(s);
      if (this.echo) process.stdout.write(s);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const p = { name, child, exited };
    this.procs.set(name, p);
    void exited.then(() => {
      if (this.procs.get(name) === p) this.procs.delete(name);
    });
    return p;
  }

  async kill(name: string): Promise<void> {
    const p = this.procs.get(name);
    if (!p) return;
    p.child.kill('SIGKILL');
    await p.exited;
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((n) => this.kill(n)));
  }

  pidOf(name: string): number | undefined {
    return this.procs.get(name)?.child.pid;
  }

  isRunning(name: string): boolean {
    return this.procs.has(name);
  }

  close(): void {
    this.log?.end();
  }
}
