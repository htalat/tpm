import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Load the nearest .env (walking up from cwd) without overriding real environment variables. */
export function loadEnv(): void {
  let dir = resolve(process.cwd());
  for (;;) {
    const f = join(dir, '.env');
    if (existsSync(f)) {
      process.loadEnvFile(f);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
