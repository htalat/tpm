import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Global setup: build a throwaway tpm tree + HOME for the webServer. Every
// spec owns its own task fixtures (no cross-spec coupling) — mutations are
// fine here, this tree exists for one run.

export const E2E_DIR = join(tmpdir(), "tpm-e2e");
export const E2E_HOME = join(E2E_DIR, "home");
export const E2E_ROOT = join(E2E_DIR, "tree");

function projectMd(slug: string, name: string): string {
  return `---\nname: ${name}\nslug: ${slug}\nstatus: active\n---\n\n# ${name}\n\n## Goal\ne2e fixture project\n\n## Context\nshared context\n\n## Notes\n`;
}

function taskMd(slug: string, title: string, status: string, type = "pr"): string {
  return `---\ntitle: ${title}\nslug: ${slug}\nproject: demo\nstatus: ${status}\ntype: ${type}\nprs: []\ntags: []\n---\n\n# ${title}\n\n## Context\nfixture context for ${slug}\n\n## Plan\n1. step one\n\n## Log\n- 2026-07-01 00:00 PDT: created\n\n## Outcome\n`;
}

export default function globalSetup(): void {
  rmSync(E2E_DIR, { recursive: true, force: true });
  mkdirSync(join(E2E_ROOT, ".tpm"), { recursive: true });
  mkdirSync(join(E2E_HOME, ".tpm"), { recursive: true });
  writeFileSync(join(E2E_HOME, ".tpm", "config.json"), JSON.stringify({ root: E2E_ROOT }));

  const tasks = join(E2E_ROOT, "demo", "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(E2E_ROOT, "demo", "project.md"), projectMd("demo", "Demo"));

  // Per-spec fixtures — file-form tasks, one concern each.
  writeFileSync(join(tasks, "001-bulk-a.md"), taskMd("bulk-a", "Bulk A", "ready"));
  writeFileSync(join(tasks, "002-bulk-b.md"), taskMd("bulk-b", "Bulk B", "ready"));
  writeFileSync(join(tasks, "003-block-a.md"), taskMd("block-a", "Block A", "open"));
  writeFileSync(join(tasks, "004-block-b.md"), taskMd("block-b", "Block B", "open"));
  writeFileSync(join(tasks, "005-edit-me.md"), taskMd("edit-me", "Edit Me", "open"));
  writeFileSync(join(tasks, "006-close-me.md"), taskMd("close-me", "Close Me", "review"));
  writeFileSync(join(tasks, "007-searchable-widget.md"), taskMd("searchable-widget", "Searchable Widget", "open"));

  // Folder-form in-progress task with a run log (runs page + live tail spec
  // appends to this file mid-test).
  const runsTask = join(tasks, "008-running");
  mkdirSync(join(runsTask, "runs"), { recursive: true });
  writeFileSync(join(runsTask, "task.md"), taskMd("running", "Running Task", "in-progress"));
  writeFileSync(
    join(runsTask, "runs", "20260707T010000Z.log"),
    '{"type":"system","subtype":"init","session_id":"sess-e2e-1"}\n'
    + '{"type":"assistant","message":{"content":[{"type":"text","text":"first transcript line"}]}}\n',
  );
}
