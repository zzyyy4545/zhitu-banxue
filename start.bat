@echo off
chcp 65001 >nul
title 知途伴学 · 服务运行中（请勿关闭此窗口）
cd /d "%~dp0"

set NODE=C:\Users\mist\.workbuddy\binaries\node\versions\22.22.2\node.exe
if not exist "%NODE%" set NODE=node

echo.
echo   ============================================
echo     知途伴学 · 基于 AI 智能体的伴随式导学系统
echo   ============================================
echo.
echo   服务地址： http://localhost:3000
echo   局域网：   http://192.168.228.156:3000
echo.
echo   保持本窗口开启，关闭即停止服务。
echo   按 Ctrl+C 可停止。
echo.
echo ============================================
echo.

"%NODE%" server\index.js

echo.
echo   服务已停止。
pause
