// The user-facing CLI command name. On Windows the install is invoked as
// `tpmgr`, not `tpm`: bare `tpm` resolves to the built-in `tpm.msc` (Trusted
// Platform Module console), which shadows any user shim (`.MSC` is in PATHEXT
// and %WINDIR%\system32 leads %PATH%). So help text and hints must show the
// name the user can actually type. See bin/tpmgr.cmd and the README.
export const CLI_NAME: string = process.platform === "win32" ? "tpmgr" : "tpm";

// Rewrite the `tpm` command token in user-facing output to the platform command
// name. Pure function (name passed in) so it's testable on any platform.
//
// The match is deliberately narrow — `tpm` only when immediately followed by a
// space and a lowercase letter, i.e. a subcommand (`tpm init`, `tpm ls`). That
// keeps it from mangling the many non-command uses of the string "tpm":
//   - path segments like C:\Users\H\tpm\src or ~/tpm        (no following space)
//   - the data dir .tpm/ and env vars TPM_BIN               (lookbehind / case)
//   - job-name prefixes like tpm-poll                       (hyphen, not space)
//   - the version banner `tpm 0.11.0`                        (digit, not [a-z])
// Product-name phrases like "tpm tree"/"tpm report" do get rewritten, which is
// acceptable (on Windows the tool genuinely is `tpmgr`).
export function brandCliFor(name: string, text: string): string {
  if (name === "tpm") return text;
  return text.replace(/(?<![.\w-])tpm(?= [a-z])/g, name);
}

// Brand for the current platform.
export function brandCli(text: string): string {
  return brandCliFor(CLI_NAME, text);
}
