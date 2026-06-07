import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Install (or refresh) the user-scoped skills from this tpm checkout into
// ~/.claude/skills/. On macOS/Linux we symlink each `skills/<name>/` dir so
// edits to SKILL.md flow live; on Windows symlinks need admin or Developer
// Mode, so we fall back to a recursive copy and rely on this command being
// re-run after edits.

export type RefreshAction = "linked" | "copied" | "unchanged";

export interface RefreshEntry {
  name: string;
  source: string;
  target: string;
  action: RefreshAction;
}

export interface RefreshEnv {
  platform: NodeJS.Platform;
  homeDir: string;
  // Absolute path to the `skills/` dir in this tpm checkout. Defaults to
  // `<this file>/../../skills` so it works regardless of where the user
  // cloned the repo.
  sourceRoot: string;
  fs: {
    exists: (path: string) => boolean;
    isDir: (path: string) => boolean;
    isSymlink: (path: string) => boolean;
    readlink: (path: string) => string;
    readdir: (path: string) => string[];
    mkdirp: (path: string) => void;
    symlink: (target: string, path: string) => void;
    unlink: (path: string) => void;
    rmrf: (path: string) => void;
    copyTree: (source: string, target: string) => void;
  };
}

export function defaultSourceRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", "..", "skills");
}

export function targetRoot(homeDir: string): string {
  return join(homeDir, ".claude", "skills");
}

export function defaultRefreshEnv(): RefreshEnv {
  return {
    platform: process.platform,
    homeDir: homedir(),
    sourceRoot: defaultSourceRoot(),
    fs: {
      exists: existsSync,
      isDir: (p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      },
      isSymlink: (p) => {
        try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
      },
      readlink: readlinkSync,
      readdir: (p) => readdirSync(p),
      mkdirp: (p) => mkdirSync(p, { recursive: true }),
      symlink: symlinkSync,
      unlink: (p) => {
        try { unlinkSync(p); } catch { /* best-effort: caller checks existence first */ }
      },
      rmrf: (p) => rmSync(p, { recursive: true, force: true }),
      copyTree: copyDirRecursive,
    },
  };
}

function copyDirRecursive(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const s = join(source, entry.name);
    const t = join(target, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, t);
    else if (entry.isFile()) copyFileSync(s, t);
    // Symlinks/other types in the source are skipped — skills/ holds
    // plain markdown today, so a symlink inside it would be an unusual
    // setup we don't want to silently dereference.
  }
}

export function refreshSkills(env: RefreshEnv = defaultRefreshEnv()): RefreshEntry[] {
  if (!env.fs.exists(env.sourceRoot)) {
    throw new Error(`refresh-skills: source skills dir not found at ${env.sourceRoot}`);
  }
  const target = targetRoot(env.homeDir);
  env.fs.mkdirp(target);

  const entries: RefreshEntry[] = [];
  for (const name of env.fs.readdir(env.sourceRoot).sort()) {
    const source = join(env.sourceRoot, name);
    if (!env.fs.isDir(source)) continue;
    const dest = join(target, name);

    if (env.platform === "win32") {
      // Copy strategy: blow away the existing tree, then recursively copy.
      // We don't try to diff because the SKILL.md is a single file and a full
      // copy is fast.
      if (env.fs.exists(dest) || env.fs.isSymlink(dest)) env.fs.rmrf(dest);
      env.fs.copyTree(source, dest);
      entries.push({ name, source, target: dest, action: "copied" });
      continue;
    }

    // Symlink strategy (macOS/Linux). Idempotent: if the target is already a
    // symlink to the right source, leave it alone. Otherwise replace whatever
    // is there.
    if (env.fs.isSymlink(dest)) {
      let existing = "";
      try { existing = env.fs.readlink(dest); } catch { /* fall through */ }
      if (existing === source) {
        entries.push({ name, source, target: dest, action: "unchanged" });
        continue;
      }
      env.fs.unlink(dest);
    } else if (env.fs.exists(dest)) {
      // Previously installed as a real directory (e.g. a Windows-style copy
      // brought over via dotfile sync). Wipe so the symlink can take over.
      env.fs.rmrf(dest);
    }
    env.fs.symlink(source, dest);
    entries.push({ name, source, target: dest, action: "linked" });
  }
  return entries;
}
