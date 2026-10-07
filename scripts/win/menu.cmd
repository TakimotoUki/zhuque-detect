@echo off
rem ===================================================================
rem  Zhuque AI-rate detector - Service manager (open the menu)
rem
rem  This file is intentionally ASCII-only so that it renders correctly
rem  under any Windows console code page. All Chinese UI text lives in
rem  start.ps1, which is written as UTF-8 with BOM.
rem
rem  Uses goto instead of nested "if (...)" blocks: inside a
rem  parenthesised block %ERRORLEVEL% would be expanded at parse time.
rem ===================================================================
chcp 65001 >nul 2>nul
setlocal

set "PS=powershell"
where pwsh >nul 2>nul
if not errorlevel 1 set "PS=pwsh"

where %PS% >nul 2>nul
if errorlevel 1 goto :no_ps

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done

echo.
echo   [exit code %RC%]
pause

:done
rem No "endlocal" here: exit /b discards the local scope anyway, and
rem calling endlocal first would wipe RC before %RC% is expanded below.
exit /b %RC%

:no_ps
echo.
echo   [ERROR] Neither "pwsh" nor "powershell" was found on this system.
echo   This package needs Windows PowerShell 5.1 or newer, which ships
echo   with Windows 10 and Windows 11 by default.
echo.
pause
exit /b 127
