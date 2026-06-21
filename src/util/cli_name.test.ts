import { test } from "node:test";
import assert from "node:assert/strict";
import { brandCliFor } from "./cli_name.ts";

test("brandCliFor: no-op when the name is already tpm (non-Windows)", () => {
  const s = "No projects yet. Run: tpm new project <slug>";
  assert.equal(brandCliFor("tpm", s), s);
});

test("brandCliFor: rewrites command tokens to the platform name", () => {
  assert.equal(brandCliFor("tpmgr", "Run: tpm init [<dir>]"), "Run: tpmgr init [<dir>]");
  assert.equal(brandCliFor("tpmgr", "Try `tpm ls`."), "Try `tpmgr ls`.");
  assert.equal(brandCliFor("tpmgr", "$(tpm session <task>)"), "$(tpmgr session <task>)");
  assert.equal(brandCliFor("tpmgr", "tpm block requires a reason"), "tpmgr block requires a reason");
});

test("brandCliFor: leaves path segments containing 'tpm' intact", () => {
  // The repo (and the data dir) are literally named tpm — must not be mangled.
  assert.equal(brandCliFor("tpmgr", "tpm root does not exist: C:\\Users\\H\\tpm\\src"),
    "tpmgr root does not exist: C:\\Users\\H\\tpm\\src");
  assert.equal(brandCliFor("tpmgr", "loaded ~/tpm/config"), "loaded ~/tpm/config");
});

test("brandCliFor: leaves the data dir, env vars, and job prefixes intact", () => {
  assert.equal(brandCliFor("tpmgr", "writes ~/.tpm/config.json"), "writes ~/.tpm/config.json");
  assert.equal(brandCliFor("tpmgr", "honors TPM_BIN override"), "honors TPM_BIN override");
  assert.equal(brandCliFor("tpmgr", "all tpm-managed jobs"), "all tpm-managed jobs");
});

test("brandCliFor: leaves the version banner intact (digit, not a subcommand)", () => {
  assert.equal(brandCliFor("tpmgr", "tpm 0.11.0 — task & project manager"),
    "tpm 0.11.0 — task & project manager");
});
