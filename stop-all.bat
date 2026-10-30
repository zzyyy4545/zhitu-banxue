@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   知途伴学 · 停止服务与隧道
echo ============================================

if not exist data mkdir data
echo stop > data\app.stop
echo stop > data\tunnel.stop

echo 已写入停止标记，守护进程将退出...
timeout /t 2 /nobreak >nul

if exist data\app.pid (
  set /p APPPID=<data\app.pid
  taskkill /PID %APPPID% /F >nul 2>&1
)
if exist data\tunnel.pid (
  set /p TUNPID=<data\tunnel.pid
  taskkill /PID %TUNPID% /F >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)

del /q data\app.stop data\tunnel.stop 2>nul
del /q data\public-url.txt 2>nul

echo.
echo 已停止。
pause
