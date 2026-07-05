@echo off
REM Host the dashboard as a web page on this Windows PC.
REM Then browse to  http://<this-pc-ip>:9000/dashboard.html  from any machine.
cd /d "%~dp0..\dashboard"

echo Your IP addresses (use one of these):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   http://%%a:9000/dashboard.html
echo (Ctrl-C to stop)
echo.

where py >nul 2>&1
if %errorlevel%==0 (
  py -m http.server 9000
) else (
  python -m http.server 9000
)
