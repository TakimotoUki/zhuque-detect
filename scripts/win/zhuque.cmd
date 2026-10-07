@echo off
rem ===================================================================
rem  zhuque - command line entry
rem
rem  Usage from cmd / PowerShell inside this folder:
rem    zhuque.cmd detect "text to check"
rem    zhuque.cmd detect -f draft.md --json
rem    zhuque.cmd doctor
rem    zhuque.cmd history
rem    zhuque.cmd keys list
rem    zhuque.cmd serve --open
rem
rem  Note: written with goto instead of nested "if (...)" blocks on
rem  purpose. Inside a parenthesised block %ERRORLEVEL% is expanded when
rem  the block is parsed, not when the command runs, which would swallow
rem  the real exit code.
rem ===================================================================
setlocal
set "ZQ_ROOT=%~dp0"
if not exist "%ZQ_ROOT%src\cli.mjs" set "ZQ_ROOT=%~dp0..\..\"

if "%ZHUQUE_NODE%"=="" goto :find_node
if not exist "%ZHUQUE_NODE%" goto :find_node
"%ZHUQUE_NODE%" "%ZQ_ROOT%src\cli.mjs" %*
exit /b %ERRORLEVEL%

:find_node
where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%ZQ_ROOT%src\cli.mjs" %*
exit /b %ERRORLEVEL%

:no_node
echo.
echo   [ERROR] Node.js not found.
echo.
echo   This tool needs Node.js 22 or newer. Install it with either:
echo     1^) Download from https://nodejs.org/  ^(pick the LTS build^)
echo     2^) winget install OpenJS.NodeJS.LTS
echo.
echo   Then reopen your terminal and try again.
echo   If node is installed but still not found, set ZHUQUE_NODE to the
echo   full path of node.exe, e.g.
echo     set ZHUQUE_NODE=C:\Program Files\nodejs\node.exe
echo.
exit /b 127
