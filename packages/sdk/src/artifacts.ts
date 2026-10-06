import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where workers put large outputs. The engine stores only references (URIs). */
export interface ArtifactStore {
  /** Store content under a deterministic key; repeated puts of the same key overwrite (idempotent). */
  put(key: string, content: string | Uint8Array): Promise<string>;
}

/** Local filesystem store. Writes are atomic (temp file + rename). */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(key: string, content: string | Uint8Array): Promise<string> {
    const safe = key.replace(/[^A-Za-z0-9._/-]/g, '_').replace(/\.\.+/g, '_');
    const path = resolve(join(this.root, safe));
    if (!path.startsWith(resolve(this.root))) throw new Error('artifact key escapes store root');
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, path);
    return pathToFileURL(path).href;
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, string | Uint8Array>();
  async put(key: string, content: string | Uint8Array): Promise<string> {
    this.items.set(key, content);
    return `memory://${key}`;
  }
}
