@echo off
rem SHDW Unstake launcher for Windows.
rem Installs dependencies on the first run, then starts the app.
cd /d "%~dp0"
title SHDW Unstake

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "node_modules\@solana\web3.js\package.json" goto run
echo First run: installing components, this takes 1-2 minutes...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto npmfail

:run
node src\server.mjs
echo.
pause
exit /b

:nonode
echo Node.js is not installed.
echo The download page will open now. Install the LTS version with default settings,
echo then run start.bat again.
start "" https://nodejs.org/
pause
exit /b

:npmfail
echo Could not install components. Check your internet connection and run start.bat again.
pause
exit /b
