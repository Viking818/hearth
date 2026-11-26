@echo off
rem Double-click to start Hearth on Windows. Keep this window open while you use Hearth; close it to stop.
title Hearth
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Hearth needs Node.js 20 or newer.
  echo Opening nodejs.org: install the LTS version, then start Hearth again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

node server\index.mjs --open
if errorlevel 1 pause
