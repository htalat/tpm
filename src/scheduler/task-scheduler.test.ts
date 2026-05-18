import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateArgs,
  buildDeleteArgs,
  buildQueryArgs,
  intervalMinutes,
  parseListOutput,
  taskName,
  trCommand,
  windowsScheduler,
  type ExecResult,
  type WinEnv,
} from "./task-scheduler.ts";
import { getScheduler } from "./types.ts";

const JOB = {
  name: "poll",
  args: ["C:\\Users\\me\\tpm\\bin\\tpm.cmd", "poll"],
  intervalSeconds: 60,
};

test("taskName: prefixes job name with tpm-", () => {
  assert.equal(taskName("poll"), "tpm-poll");
});

test("intervalMinutes: rounds to nearest minute, clamps to >=1", () => {
  assert.equal(intervalMinutes(30),   1);  // sub-minute clamps up
  assert.equal(intervalMinutes(60),   1);
  assert.equal(intervalMinutes(90),   2);  // rounds to nearest
  assert.equal(intervalMinutes(120),  2);
  assert.equal(intervalMinutes(900),  15);
  assert.equal(intervalMinutes(3600), 60);
});

test("trCommand: bare path-safe args pass through unquoted", () => {
  assert.equal(
    trCommand(["C:\\tpm\\bin\\tpm.cmd", "poll"]),
    "C:\\tpm\\bin\\tpm.cmd poll",
  );
});

test("trCommand: args with spaces get wrapped in double quotes", () => {
  assert.equal(
    trCommand(["C:\\tpm\\bin\\tpm.cmd", "log", "needs space"]),
    'C:\\tpm\\bin\\tpm.cmd log "needs space"',
  );
});

test("trCommand: embedded double-quotes are doubled (cmd.exe convention)", () => {
  assert.equal(
    trCommand(["tpm", 'has "quote"']),
    'tpm "has ""quote"""',
  );
});

test("buildCreateArgs: produces the expected schtasks invocation", () => {
  const args = buildCreateArgs(JOB, "DESKTOP-X\\me");
  assert.deepEqual(args, [
    "/Create",
    "/TN", "tpm-poll",
    "/SC", "MINUTE",
    "/MO", "1",
    "/TR", "C:\\Users\\me\\tpm\\bin\\tpm.cmd poll",
    "/RU", "DESKTOP-X\\me",
    "/IT",
    "/F",
  ]);
});

test("buildCreateArgs: 15-minute cadence renders /MO 15", () => {
  const args = buildCreateArgs(
    { name: "poll", args: ["tpm", "poll"], intervalSeconds: 900 },
    "me",
  );
  const moIdx = args.indexOf("/MO");
  assert.equal(args[moIdx + 1], "15");
});

test("buildDeleteArgs: /Delete /TN <prefixed> /F", () => {
  assert.deepEqual(buildDeleteArgs("orchestrate"), [
    "/Delete", "/TN", "tpm-orchestrate", "/F",
  ]);
});

test("buildQueryArgs: with name → single-task lookup", () => {
  assert.deepEqual(buildQueryArgs("poll"), ["/Query", "/TN", "tpm-poll"]);
});

test("buildQueryArgs: without name → CSV listing for parsing", () => {
  assert.deepEqual(buildQueryArgs(), ["/Query", "/FO", "CSV", "/NH"]);
});

test("parseListOutput: filters tpm- prefix and strips folder path", () => {
  const csv = [
    `"\\tpm-poll","12/31/2026 12:00:00 AM","Ready"`,
    `"\\tpm-orchestrate","12/31/2026 12:00:00 AM","Ready"`,
    `"\\Microsoft\\Windows\\UpdateOrchestrator\\Reboot","N/A","Ready"`,
    `"\\OneDrive Standalone Update Task","N/A","Ready"`,
  ].join("\r\n");
  assert.deepEqual(parseListOutput(csv), ["orchestrate", "poll"]);
});

test("parseListOutput: handles a nested tpm- entry (rare but possible)", () => {
  const csv = [
    `"\\Some\\Folder\\tpm-nested","N/A","Ready"`,
  ].join("\n");
  assert.deepEqual(parseListOutput(csv), ["nested"]);
});

test("parseListOutput: dedupes repeated entries", () => {
  const csv = [
    `"\\tpm-poll","N/A","Ready"`,
    `"\\tpm-poll","N/A","Running"`,
  ].join("\n");
  assert.deepEqual(parseListOutput(csv), ["poll"]);
});

test("getScheduler: returns the Windows adapter for win32", () => {
  // Just verify it doesn't throw — the adapter's exec is unbound here, so
  // we can't drive it without a fake env, but the wiring is what matters.
  assert.doesNotThrow(() => getScheduler("win32"));
});

// Higher-level orchestration tests — drive the public Scheduler surface
// with a fake env so we cover install/uninstall/status/list paths without
// shelling out to a real schtasks.exe.

interface ExecCall { cmd: string; args: string[] }

function makeFakeEnv(opts: {
  installedTasks?: string[];      // task names without the tpm- prefix
  queryListOutput?: string;       // override /Query /FO CSV output
  failOn?: (call: ExecCall) => Partial<ExecResult> | null;
} = {}): { env: WinEnv; calls: ExecCall[]; installed: Set<string> } {
  const installed = new Set<string>(opts.installedTasks ?? []);
  const calls: ExecCall[] = [];

  const exec = (cmd: string, args: string[]): ExecResult => {
    calls.push({ cmd, args });
    const override = opts.failOn?.({ cmd, args });
    if (override) {
      return { status: override.status ?? 1, stdout: override.stdout ?? "", stderr: override.stderr ?? "" };
    }
    if (cmd !== "schtasks") return { status: 0, stdout: "", stderr: "" };
    const verb = args[0];
    if (verb === "/Create") {
      const tnIdx = args.indexOf("/TN");
      const full = args[tnIdx + 1];
      installed.add(full.replace(/^tpm-/, ""));
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (verb === "/Delete") {
      const tnIdx = args.indexOf("/TN");
      const full = args[tnIdx + 1];
      const bare = full.replace(/^tpm-/, "");
      if (!installed.has(bare)) {
        return { status: 1, stdout: "", stderr: `ERROR: The system cannot find the file specified.` };
      }
      installed.delete(bare);
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    }
    if (verb === "/Query") {
      const tnIdx = args.indexOf("/TN");
      if (tnIdx >= 0) {
        const bare = args[tnIdx + 1].replace(/^tpm-/, "");
        return installed.has(bare)
          ? { status: 0, stdout: `"\\tpm-${bare}","N/A","Ready"`, stderr: "" }
          : { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
      }
      if (opts.queryListOutput !== undefined) {
        return { status: 0, stdout: opts.queryListOutput, stderr: "" };
      }
      const lines = Array.from(installed).map(n => `"\\tpm-${n}","N/A","Ready"`);
      return { status: 0, stdout: lines.join("\r\n"), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const env: WinEnv = { exec, currentUser: "DESKTOP-X\\tester" };
  return { env, calls, installed };
}

test("install: shells out to schtasks /Create with current user as /RU", () => {
  const { env, calls, installed } = makeFakeEnv();
  const s = windowsScheduler(env);
  s.install(JOB);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "schtasks");
  assert.equal(calls[0].args[0], "/Create");
  // Asserts the current-user flag flows through from env.
  const ruIdx = calls[0].args.indexOf("/RU");
  assert.equal(calls[0].args[ruIdx + 1], "DESKTOP-X\\tester");
  assert.ok(installed.has("poll"));
});

test("install: throws with schtasks stderr when /Create fails", () => {
  const { env } = makeFakeEnv({
    failOn: c => c.args[0] === "/Create"
      ? { status: 1, stderr: "ERROR: Access is denied." }
      : null,
  });
  const s = windowsScheduler(env);
  assert.throws(() => s.install(JOB), /Access is denied/);
});

test("status + list: reflect what install just wrote", () => {
  const { env } = makeFakeEnv();
  const s = windowsScheduler(env);
  s.install({ name: "poll", args: ["tpm", "poll"], intervalSeconds: 60 });
  s.install({ name: "orchestrate", args: ["tpm", "orchestrate"], intervalSeconds: 900 });

  assert.equal(s.status("poll"), "installed");
  assert.equal(s.status("missing-job"), "missing");
  assert.deepEqual(s.list(), ["orchestrate", "poll"]);
});

test("uninstall: removes the task and is idempotent for absent jobs", () => {
  const { env, installed } = makeFakeEnv({ installedTasks: ["poll"] });
  const s = windowsScheduler(env);
  s.uninstall("poll");
  assert.equal(installed.size, 0);

  // Second uninstall of the same name: schtasks reports "cannot find"; the
  // adapter swallows it so re-running stays safe.
  assert.doesNotThrow(() => s.uninstall("poll"));
});

test("uninstall: surfaces real errors (not 'cannot find')", () => {
  const { env } = makeFakeEnv({
    failOn: c => c.args[0] === "/Delete"
      ? { status: 1, stderr: "ERROR: Access is denied." }
      : null,
  });
  const s = windowsScheduler(env);
  assert.throws(() => s.uninstall("poll"), /Access is denied/);
});

test("list: returns [] when schtasks reports no tasks (instead of throwing)", () => {
  const { env } = makeFakeEnv({
    failOn: c => c.args[0] === "/Query" && !c.args.includes("/TN")
      ? { status: 1, stderr: "INFO: There are no scheduled tasks present in the system." }
      : null,
  });
  const s = windowsScheduler(env);
  assert.deepEqual(s.list(), []);
});

test("list: only surfaces tpm-prefixed tasks even when the library is full", () => {
  const { env } = makeFakeEnv({
    queryListOutput: [
      `"\\tpm-poll","N/A","Ready"`,
      `"\\Microsoft\\Windows\\UpdateOrchestrator\\Reboot","N/A","Ready"`,
      `"\\OneDrive Standalone Update Task","N/A","Ready"`,
      `"\\tpm-orchestrate","N/A","Ready"`,
    ].join("\r\n"),
  });
  const s = windowsScheduler(env);
  assert.deepEqual(s.list(), ["orchestrate", "poll"]);
});

test("install: rejects invalid job name before touching schtasks", () => {
  const { env, calls } = makeFakeEnv();
  const s = windowsScheduler(env);
  assert.throws(() => s.install({ name: "../bad", args: ["tpm"], intervalSeconds: 60 }));
  assert.equal(calls.length, 0);
});

test("install: rejects non-positive intervals", () => {
  const { env } = makeFakeEnv();
  const s = windowsScheduler(env);
  assert.throws(() => s.install({ name: "poll", args: ["tpm"], intervalSeconds: 0 }));
  assert.throws(() => s.install({ name: "poll", args: ["tpm"], intervalSeconds: -1 }));
});

test("install: rejects empty arg list", () => {
  const { env } = makeFakeEnv();
  const s = windowsScheduler(env);
  assert.throws(() => s.install({ name: "poll", args: [], intervalSeconds: 60 }), /command is empty/);
});
