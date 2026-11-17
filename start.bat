@echo off
title RecallAI Launcher
cd /d "%~dp0"
echo ========================================================
echo   Starting RecallAI (Ollama + Backend + Frontend)
echo ========================================================
echo.
echo [1/2] Ensuring Ollama service is running...
start "" /B ollama serve >nul 2>&1
timeout /t 2 >nul

echo [2/2] Launching RecallAI Web (http://localhost:3000) and API (http://localhost:4000)...
echo.
npm run dev
pause
