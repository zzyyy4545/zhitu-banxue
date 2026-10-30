@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   知途伴学 · 一键启动（服务 + 公网隧道，自动重连）
echo ============================================
echo.

set NODE=C:\Users\mist\.workbuddy\binaries\node\versions\22.22.2\node.exe
if not exist "%NODE%" set NODE=node

echo [1/2] 启动应用服务守护（端口 3000）...
start "zhitu-app" /min "%NODE%" scripts\app-supervisor.js
timeout /t 3 /nobreak >nul

echo [2/2] 启动公网隧道守护（自动重连）...
start "zhitu-tunnel" /min "%NODE%" scripts\tunnel-supervisor.js
timeout /t 6 /nobreak >nul

echo.
if exist data\public-url.txt (
  set /p URL=<data\public-url.txt
  echo   公网地址：%URL%
  echo   （隧道重连后地址会变，最新地址见 data\public-url.txt）
) else (
  echo   公网地址获取中，请稍后查看 data\public-url.txt
)
echo.
echo   本地访问：http://localhost:3000
echo   测试账号：学生 s001/123456   教师 teacher/123456   管理员 admin/123456
echo.
echo 停止服务：运行 stop-all.bat
echo.
pause
