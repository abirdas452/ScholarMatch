@echo off
setlocal
cd /d "%~dp0"
title ScholarMatch Launcher
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20+ from https://nodejs.org/ then run this file again.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from template.
  echo.
  echo IMPORTANT: Open .env in Notepad and set ADMIN_EMAIL, ADMIN_PASSWORD,
  echo SESSION_SECRET and OPENAI_API_KEY before using the full features.
  echo Save .env, then double-click START_SCHOLARMATCH.bat again.
  start notepad .env
  pause
  exit /b 0
)
if not exist node_modules (
  echo Installing dependencies. This may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and Node.js version.
    pause
    exit /b 1
  )
)
start "ScholarMatch Chrome" http://localhost:3000
call npm start
pause
