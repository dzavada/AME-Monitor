@echo off
REM ============================================================================
REM  Install the AME Monitor agent on a WINDOWS machine running Adobe Media Encoder.
REM  Double-click this file (no admin needed). Then restart AME.
REM ============================================================================
setlocal enabledelayedexpansion

set "SRC=%~dp0..\agent"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.amemonitor.agent"

if not exist "%SRC%\CSXS\manifest.xml" (
  echo ERROR: can't find the agent folder next to this script.
  echo Run install-agent.bat from inside the install\ folder.
  pause & exit /b 1
)

echo Allowing unsigned CEP extensions ^(PlayerDebugMode^)...
for %%v in (9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo Installing panel to:
echo   %DEST%
if not exist "%DEST%" mkdir "%DEST%"
xcopy /E /I /H /Y "%SRC%\*" "%DEST%\" >nul

echo.
echo Done on %COMPUTERNAME%.
echo   1. Quit and reopen Adobe Media Encoder.
echo   2. Open  Window ^> Extensions ^> AME Monitor  (only needed once).
echo   3. The panel shows:  Serving on  http://<this-pc-ip>:8642
echo   4. If Windows Firewall prompts, click Allow access.
echo.
echo (Your IP addresses:)
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   %%a
echo.
pause
endlocal
