@echo off
rem ClaudeDeck launcher. Double-click to start.
rem
rem This file is kept ASCII-only on purpose. cmd.exe parses a batch file with the
rem console codepage that is active at parse time, so Japanese text placed here
rem would break on a shift-jis console. Japanese messages are printed by node,
rem after chcp has switched the console to UTF-8.

setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on PATH.
  echo ClaudeDeck needs Node.js 18 or newer.
  echo Claude Code users normally have it already - check with: node -v
  echo.
  pause
  exit /b 1
)

node server.mjs %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo ClaudeDeck exited with code %EXITCODE%.
  pause
)

exit /b %EXITCODE%
