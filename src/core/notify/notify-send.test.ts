import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNotifySendArgs,
  fireNotifySendNotification,
  type NotifySendSpawnResult,
} from "./notify-send.ts";

test("buildNotifySendArgs: app name, -- guard, then title and body as argv", () => {
  assert.deepEqual(
    buildNotifySendArgs("tpm", "001-t: finish"),
    ["-a", "tpm", "--", "tpm", "001-t: finish"],
  );
});

test("buildNotifySendArgs: a title starting with - is shielded by the -- guard", () => {
  const args = buildNotifySendArgs("-x dangerous", "body");
  // Everything after `--` is positional, so a leading-dash title can't be
  // mistaken for an option.
  assert.equal(args[2], "--");
  assert.equal(args[3], "-x dangerous");
});

test("fireNotifySendNotification: invokes notify-send with the built argv", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (cmd: string, args: string[]): NotifySendSpawnResult => {
    calls.push({ cmd, args });
    return { status: 0 };
  };
  fireNotifySendNotification("tpm", "001-t: finish", { spawn, log: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "notify-send");
  assert.deepEqual(calls[0].args, buildNotifySendArgs("tpm", "001-t: finish"));
});

test("fireNotifySendNotification: logs a WARN line when notify-send exits non-zero", () => {
  const warnings: string[] = [];
  fireNotifySendNotification("tpm", "hi", {
    spawn: () => ({ status: 1 }),
    log: m => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exited 1/);
});

test("fireNotifySendNotification: logs a WARN line when spawn errors (notify-send missing)", () => {
  const warnings: string[] = [];
  fireNotifySendNotification("tpm", "hi", {
    spawn: () => ({ status: null, error: new Error("ENOENT") }),
    log: m => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ENOENT/);
});

test("fireNotifySendNotification: WARN swallows an unexpected throw from spawn", () => {
  const warnings: string[] = [];
  assert.doesNotThrow(() =>
    fireNotifySendNotification("tpm", "hi", {
      spawn: () => { throw new Error("boom"); },
      log: m => warnings.push(m),
    }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /boom/);
});

test("fireNotifySendNotification: status 0 produces no WARN noise", () => {
  const warnings: string[] = [];
  fireNotifySendNotification("tpm", "hi", {
    spawn: () => ({ status: 0 }),
    log: m => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
});
