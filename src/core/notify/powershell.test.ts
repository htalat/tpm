import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPowerShellArgs,
  buildPowerShellSnippet,
  escapePsSingleQuoted,
  firePowerShellNotification,
  type PowerShellSpawnResult,
} from "./powershell.ts";

test("escapePsSingleQuoted: leaves a plain string untouched", () => {
  assert.equal(escapePsSingleQuoted("hello world"), "hello world");
});

test("escapePsSingleQuoted: doubles single quotes (PS literal convention)", () => {
  assert.equal(escapePsSingleQuoted("it's"), "it''s");
  assert.equal(escapePsSingleQuoted("''"), "''''");
});

test("escapePsSingleQuoted: does not touch characters that are literal inside single quotes", () => {
  // Backslashes, double quotes, $ and ` are all literal inside PS single-quoted strings.
  const raw = `path C:\\x "y" $var \`x\` (z)`;
  assert.equal(escapePsSingleQuoted(raw), raw);
});

test("buildPowerShellSnippet: embeds title and body with single-quote escaping", () => {
  const snippet = buildPowerShellSnippet("tpm", "task's done");
  assert.ok(snippet.includes(`$t = 'tpm'`), "expected title literal");
  assert.ok(snippet.includes(`$b = 'task''s done'`), "expected body literal with doubled quote");
});

test("buildPowerShellSnippet: prefers BurntToast and falls back to WinRT", () => {
  const snippet = buildPowerShellSnippet("tpm", "hi");
  // BurntToast preferred branch
  assert.ok(snippet.includes("Get-Module -ListAvailable -Name BurntToast"));
  assert.ok(snippet.includes("New-BurntToastNotification -Text @($t, $b)"));
  // WinRT fallback branch
  assert.ok(snippet.includes("Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime"));
  assert.ok(snippet.includes("ToastText02"));
  assert.ok(snippet.includes("CreateTextNode"));
  assert.ok(snippet.includes("CreateToastNotifier('tpm').Show($toast)"));
});

test("buildPowerShellSnippet: with a URL, both branches launch it as a protocol", () => {
  const snippet = buildPowerShellSnippet("tpm", "hi", "http://127.0.0.1:7777/t/p/001-t");
  assert.ok(snippet.includes(`$u = 'http://127.0.0.1:7777/t/p/001-t'`), "expected URL literal");
  // BurntToast branch carries the launch target.
  assert.ok(snippet.includes("New-BurntToastNotification -Text @($t, $b) -Launch $u -ActivationType Protocol"));
  // WinRT fallback stamps launch/activationType on the toast root.
  assert.ok(snippet.includes("$tpl.DocumentElement.SetAttribute('launch', $u)"));
  assert.ok(snippet.includes("$tpl.DocumentElement.SetAttribute('activationType', 'protocol')"));
});

test("buildPowerShellSnippet: a URL with a single quote is escaped into the literal", () => {
  const snippet = buildPowerShellSnippet("tpm", "hi", "http://x/'inject");
  assert.ok(snippet.includes(`$u = 'http://x/''inject'`), "single quote should double");
});

test("buildPowerShellSnippet: without a URL stays byte-for-byte the display-only toast", () => {
  // No $u assignment, no launch wiring — unchanged from the pre-deep-link snippet.
  const snippet = buildPowerShellSnippet("tpm", "hi");
  assert.ok(!snippet.includes("$u ="));
  assert.ok(!snippet.includes("-Launch"));
  assert.ok(!snippet.includes("SetAttribute('launch'"));
  assert.ok(snippet.includes("New-BurntToastNotification -Text @($t, $b)"));
});

test("buildPowerShellArgs: threads the URL into the snippet", () => {
  const url = "http://127.0.0.1:7777/t/p/001-t";
  const args = buildPowerShellArgs("tpm", "hi", url);
  assert.equal(args[3], buildPowerShellSnippet("tpm", "hi", url));
});

test("firePowerShellNotification: passes opts.url into the built argv", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (cmd: string, args: string[]): PowerShellSpawnResult => {
    calls.push({ cmd, args });
    return { status: 0 };
  };
  const url = "http://127.0.0.1:7777/t/p/001-t";
  firePowerShellNotification("tpm", "001-t: finish", { url, spawn, log: () => {} });
  assert.deepEqual(calls[0].args, buildPowerShellArgs("tpm", "001-t: finish", url));
});

test("buildPowerShellSnippet: silences errors so the fallback can't bubble out as exit nonzero", () => {
  const snippet = buildPowerShellSnippet("tpm", "hi");
  assert.ok(snippet.includes("$ErrorActionPreference = 'SilentlyContinue'"));
});

test("buildPowerShellSnippet: stays on one line so any argv layer can't mangle it", () => {
  const snippet = buildPowerShellSnippet("tpm", "hi");
  assert.ok(!snippet.includes("\n"), "snippet should not contain newlines");
});

test("buildPowerShellArgs: produces the expected powershell invocation", () => {
  const args = buildPowerShellArgs("tpm", "001-t: finish");
  assert.equal(args[0], "-NoProfile");
  assert.equal(args[1], "-NonInteractive");
  assert.equal(args[2], "-Command");
  assert.equal(args[3], buildPowerShellSnippet("tpm", "001-t: finish"));
  assert.equal(args.length, 4);
});

test("firePowerShellNotification: invokes powershell with the built argv", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (cmd: string, args: string[]): PowerShellSpawnResult => {
    calls.push({ cmd, args });
    return { status: 0 };
  };
  firePowerShellNotification("tpm", "001-t: finish", { spawn, log: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "powershell");
  assert.deepEqual(calls[0].args, buildPowerShellArgs("tpm", "001-t: finish"));
});

test("firePowerShellNotification: logs a WARN line when powershell exits non-zero", () => {
  const warnings: string[] = [];
  firePowerShellNotification("tpm", "hi", {
    spawn: () => ({ status: 1 }),
    log: m => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exited 1/);
});

test("firePowerShellNotification: logs a WARN line when spawn returns an error (e.g. powershell.exe missing)", () => {
  const warnings: string[] = [];
  firePowerShellNotification("tpm", "hi", {
    spawn: () => ({ status: null, error: new Error("ENOENT") }),
    log: m => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ENOENT/);
});

test("firePowerShellNotification: WARN swallows an unexpected throw from spawn", () => {
  const warnings: string[] = [];
  assert.doesNotThrow(() =>
    firePowerShellNotification("tpm", "hi", {
      spawn: () => { throw new Error("boom"); },
      log: m => warnings.push(m),
    }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /boom/);
});

test("firePowerShellNotification: status 0 produces no WARN noise", () => {
  const warnings: string[] = [];
  firePowerShellNotification("tpm", "hi", {
    spawn: () => ({ status: 0 }),
    log: m => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
});
