@echo off
chcp 65001 >nul
title 待办本子 - 本地预览
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 node。
  echo   请先装 Node.js: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动本地预览服务器...
echo.

node server.cjs

echo.
echo   服务器已停止。
pause
