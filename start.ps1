# RecallAI PowerShell Launcher
$ErrorActionPreference = "SilentlyContinue"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Starting RecallAI (Ollama + Backend + Frontend)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/2] Ensuring Ollama service is running..." -ForegroundColor Yellow
Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[2/2] Launching RecallAI Web (http://localhost:3000) and API (http://localhost:4000)..." -ForegroundColor Green
Write-Host ""
npm run dev
