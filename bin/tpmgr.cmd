@echo off
rem Windows entry for tpm, named tpmgr to dodge a name collision: bare tpm on
rem Windows resolves to the built-in tpm.msc (Trusted Platform Module console).
rem .MSC is in PATHEXT and %WINDIR%\system32 sits ahead of every user dir on
rem %PATH%, so a tpm.cmd can never win - hence the distinct name. Mirrors
rem bin/tpm (the bash shim) without depending on a POSIX shell. Resolves the
rem repo root from this file location, so it works whenever this repo bin\
rem directory is on %PATH% (the documented Windows setup).
rem Requires Node 22.18+ on PATH for native TypeScript execution.
node "%~dp0..\src\core\cli.ts" %*
