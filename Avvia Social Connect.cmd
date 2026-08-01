@echo off
title Social Connect
rem Avvia il server locale (se non gia' attivo) e apre l'app nel browser
powershell -NoProfile -Command "try { Invoke-WebRequest 'http://localhost:8090/' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "Social Connect Server" /min powershell -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"
  timeout /t 2 >nul
)
start "" http://localhost:8090/
