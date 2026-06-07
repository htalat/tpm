import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cronLine,
  cronSchedule,
  listCronNames,
  serviceUnitContent,
  stripCronEntry,
  systemdScheduler,
  timerUnitContent,
  unitName,
  type ExecResult,
  type SystemdEnv,
} from "./systemd.ts";
import { getScheduler, validateJobName } from "./types.ts";

const JOB = {
  name: "poll",
  args: ["/usr/local/bin/tpm", "poll"],
  intervalSeconds: 60,
};

test("unitName: prefixes job name with tpm-", () => {
  assert.equal(unitName("poll"), "tpm-poll");
});

test("serviceUnitContent: Type=oneshot + ExecStart with the full command", () => {
  const out = serviceUnitContent(JOB);
  assert.match(out, /\[Service\]/);
  assert.match(out, /Type=oneshot/);
  assert.match(out, /ExecStart=\/usr\/local\/bin\/tpm poll/);
  assert.match(out, /Description=tpm scheduled job: poll/);
});

test("serviceUnitContent: quotes args containing whitespace or special chars", () => {
  const out = serviceUnitContent({
    name: "intake",
    args: ["/usr/local/bin/tpm", "log", "foo/bar", "needs space"],
    intervalSeconds: 300,
  });
  // Bare path-safe args pass through unquoted; "needs space" gets quoted.
  assert.match(out, /ExecStart=\/usr\/local\/bin\/tpm log foo\/bar "needs space"/);
});

test("timerUnitContent: OnUnitActiveSec + Persistent + Install section", () => {
  const out = timerUnitContent(JOB);
  assert.match(out, /OnUnitActiveSec=60/);
  assert.match(out, /OnBootSec=60/);
  assert.match(out, /Persistent=true/);
  assert.match(out, /Unit=tpm-poll\.service/);
  assert.match(out, /\[Install\]\nWantedBy=timers\.target/);
});

test("cronSchedule: minute / hour / day buckets", () => {
  assert.equal(cronSchedule(30),    "*/1 * * * *");   // sub-minute clamps up
  assert.equal(cronSchedule(60),    "*/1 * * * *");
  assert.equal(cronSchedule(120),   "*/2 * * * *");
  assert.equal(cronSchedule(900),   "*/15 * * * *");
  assert.equal(cronSchedule(3600),  "0 */1 * * *");
  assert.equal(cronSchedule(14400), "0 */4 * * *");
  assert.equal(cronSchedule(86400), "0 0 */1 * *");
});

test("cronLine: includes schedule, command, and sentinel", () => {
  const line = cronLine(JOB);
  assert.equal(line, "*/1 * * * * /usr/local/bin/tpm poll # tpm:poll");
});

test("cronLine: single-quotes args with spaces", () => {
  const line = cronLine({
    name: "intake",
    args: ["/usr/local/bin/tpm", "log", "needs space"],
    intervalSeconds: 300,
  });
  assert.match(line, /^\*\/5 \* \* \* \* \/usr\/local\/bin\/tpm log 'needs space' # tpm:intake$/);
});

test("stripCronEntry: removes only the matching sentinel line", () => {
  const before = [
    "# header comment",
    "0 6 * * * /usr/bin/foo",
    "*/5 * * * * /usr/local/bin/tpm poll # tpm:poll",
    "*/10 * * * * /usr/local/bin/tpm orchestrate # tpm:orchestrate",
  ].join("\n");
  const after = stripCronEntry(before, "poll");
  assert.match(after, /# header comment/);
  assert.match(after, /\/usr\/bin\/foo/);
  assert.doesNotMatch(after, /# tpm:poll/);
  assert.match(after, /# tpm:orchestrate/); // unrelated sentinel survives
});

test("stripCronEntry: # tpm:poll doesn't strip # tpm:poll-extra", () => {
  const before = [
    "*/5 * * * * tpm poll # tpm:poll",
    "*/5 * * * * tpm poll-extra # tpm:poll-extra",
  ].join("\n");
  const after = stripCronEntry(before, "poll");
  assert.doesNotMatch(after, /# tpm:poll(?![A-Za-z0-9_\-])/);
  assert.match(after, /# tpm:poll-extra/);
});

test("listCronNames: harvests every sentinel slug", () => {
  const text = [
    "*/5 * * * * tpm poll # tpm:poll",
    "0 6 * * * tpm intake # tpm:intake-prs",
    "no-sentinel-here",
  ].join("\n");
  assert.deepEqual(listCronNames(text).sort(), ["intake-prs", "poll"]);
});

test("validateJobName: accepts safe names, rejects path traversal + spaces", () => {
  validateJobName("poll");
  validateJobName("intake-prs");
  validateJobName("job_42");
  assert.throws(() => validateJobName("../etc/passwd"));
  assert.throws(() => validateJobName("has space"));
  assert.throws(() => validateJobName(""));
  assert.throws(() => validateJobName("-leadingdash"));
});

test("getScheduler: throws a clear message for darwin (no launchd adapter yet)", () => {
  assert.throws(() => getScheduler("darwin"), /launchd/);
});

test("getScheduler: throws for unsupported platforms", () => {
  assert.throws(() => getScheduler("aix" as NodeJS.Platform), /unsupported platform/);
});

// Higher-level orchestration tests — drive the public Scheduler surface
// with a fake env so we cover the install/uninstall/status/list paths
// without touching real systemctl or crontab.

interface ExecCall { cmd: string; args: string[]; input?: string }

function makeFakeEnv(opts: {
  systemdAvailable: boolean;
  initialCrontab?: string;
  initialFiles?: string[];
}): { env: SystemdEnv; calls: ExecCall[]; files: Map<string, string>; cronStore: { value: string } } {
  const files = new Map<string, string>();
  for (const p of opts.initialFiles ?? []) files.set(p, "");
  const cronStore = { value: opts.initialCrontab ?? "" };
  const calls: ExecCall[] = [];

  const exec = (cmd: string, args: string[], execOpts?: { input?: string }): ExecResult => {
    calls.push({ cmd, args, input: execOpts?.input });
    if (cmd === "systemctl" && args[0] === "--user") {
      const sub = args[1];
      if (sub === "show-environment") {
        return opts.systemdAvailable
          ? { status: 0, stdout: "PATH=/usr/bin\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "Failed to connect to bus" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "crontab") {
      if (args[0] === "-l") {
        if (cronStore.value === "") {
          return { status: 1, stdout: "", stderr: "no crontab for user" };
        }
        return { status: 0, stdout: cronStore.value, stderr: "" };
      }
      if (args[0] === "-") {
        cronStore.value = execOpts?.input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const env: SystemdEnv = {
    exec,
    homeDir: "/home/tester",
    fs: {
      writeFile: (p, c) => { files.set(p, c); },
      exists: (p) => files.has(p),
      unlink: (p) => { files.delete(p); },
      readdir: (p) => {
        const prefix = p.endsWith("/") ? p : p + "/";
        const out: string[] = [];
        for (const k of files.keys()) {
          if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
            out.push(k.slice(prefix.length));
          }
        }
        return out;
      },
      mkdirp: () => {},
    },
  };
  return { env, calls, files, cronStore };
}

test("systemd install: writes both unit files, reloads daemon, enables timer", () => {
  const { env, calls, files } = makeFakeEnv({ systemdAvailable: true });
  const s = systemdScheduler(env);
  s.install(JOB);

  assert.ok(files.has("/home/tester/.config/systemd/user/tpm-poll.service"));
  assert.ok(files.has("/home/tester/.config/systemd/user/tpm-poll.timer"));
  assert.match(files.get("/home/tester/.config/systemd/user/tpm-poll.service")!, /ExecStart=/);

  const systemctlCalls = calls.filter(c => c.cmd === "systemctl");
  assert.ok(systemctlCalls.some(c => c.args.join(" ") === "--user daemon-reload"));
  assert.ok(systemctlCalls.some(c => c.args.join(" ") === "--user enable --now tpm-poll.timer"));
});

test("systemd status/list: reads from the user unit directory", () => {
  const { env } = makeFakeEnv({ systemdAvailable: true });
  const s = systemdScheduler(env);
  s.install({ name: "poll", args: ["/usr/local/bin/tpm", "poll"], intervalSeconds: 60 });
  s.install({ name: "orchestrate", args: ["/usr/local/bin/tpm", "orchestrate"], intervalSeconds: 600 });

  assert.equal(s.status("poll"), "installed");
  assert.equal(s.status("missing-job"), "missing");
  assert.deepEqual(s.list(), ["orchestrate", "poll"]);
});

test("systemd uninstall: disables timer + removes both files", () => {
  const { env, files, calls } = makeFakeEnv({ systemdAvailable: true });
  const s = systemdScheduler(env);
  s.install(JOB);
  assert.equal(files.size, 2);
  s.uninstall("poll");

  assert.equal(files.size, 0);
  assert.ok(calls.some(c =>
    c.cmd === "systemctl" && c.args.join(" ") === "--user disable --now tpm-poll.timer"));
});

test("cron fallback: install appends sentinel line when systemd probe fails", () => {
  const { env, cronStore } = makeFakeEnv({
    systemdAvailable: false,
    initialCrontab: "0 6 * * * /usr/bin/foo\n",
  });
  const s = systemdScheduler(env);
  s.install(JOB);

  assert.match(cronStore.value, /\/usr\/bin\/foo/);   // preserves existing
  assert.match(cronStore.value, /# tpm:poll$/m);       // appends sentinel
  assert.equal(s.status("poll"), "installed");
  assert.deepEqual(s.list(), ["poll"]);
});

test("cron fallback: install with no existing crontab seeds it cleanly", () => {
  const { env, cronStore } = makeFakeEnv({ systemdAvailable: false, initialCrontab: "" });
  const s = systemdScheduler(env);
  s.install(JOB);
  assert.equal(cronStore.value, "*/1 * * * * /usr/local/bin/tpm poll # tpm:poll\n");
});

test("cron fallback: uninstall strips the sentinel line and preserves others", () => {
  const before = [
    "0 6 * * * /usr/bin/foo",
    "*/1 * * * * /usr/local/bin/tpm poll # tpm:poll",
    "*/10 * * * * /usr/local/bin/tpm orchestrate # tpm:orchestrate",
  ].join("\n") + "\n";
  const { env, cronStore } = makeFakeEnv({ systemdAvailable: false, initialCrontab: before });
  const s = systemdScheduler(env);
  s.uninstall("poll");

  assert.doesNotMatch(cronStore.value, /# tpm:poll/);
  assert.match(cronStore.value, /# tpm:orchestrate/);
  assert.match(cronStore.value, /\/usr\/bin\/foo/);
});

test("cron fallback: re-installing replaces the prior sentinel line (no dupes)", () => {
  const { env, cronStore } = makeFakeEnv({ systemdAvailable: false });
  const s = systemdScheduler(env);
  s.install({ name: "poll", args: ["/usr/local/bin/tpm", "poll"], intervalSeconds: 60 });
  s.install({ name: "poll", args: ["/usr/local/bin/tpm", "poll"], intervalSeconds: 300 });

  const tpmLines = cronStore.value.split("\n").filter(l => l.includes("# tpm:poll"));
  assert.equal(tpmLines.length, 1);
  assert.match(tpmLines[0], /\*\/5/);
});

test("install: rejects invalid job name before touching exec/fs", () => {
  const { env, calls } = makeFakeEnv({ systemdAvailable: true });
  const s = systemdScheduler(env);
  assert.throws(() => s.install({ name: "../bad", args: ["tpm"], intervalSeconds: 60 }));
  assert.equal(calls.length, 0);
});

test("install: rejects non-positive intervals", () => {
  const { env } = makeFakeEnv({ systemdAvailable: true });
  const s = systemdScheduler(env);
  assert.throws(() => s.install({ name: "poll", args: ["tpm"], intervalSeconds: 0 }));
  assert.throws(() => s.install({ name: "poll", args: ["tpm"], intervalSeconds: -1 }));
});
