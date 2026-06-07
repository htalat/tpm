@echo off
rem Windows entry for tpm. Mirrors bin/tpm (the bash shim) without depending
rem on a POSIX shell. Resolves the repo root from this file's location so the
rem .cmd can live anywhere on %PATH% (typically copied or junctioned into
rem %USERPROFILE%\.local\bin or wherever the user keeps user-scoped bins).
rem Requires Node 22.18+ on PATH for native TypeScript execution.
node "%~dp0..\src\core\cli.ts" %*
