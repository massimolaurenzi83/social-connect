@echo off
title Pubblica Social Connect su GitHub
cd /d "%~dp0"
rem Abilita la finestra di login GitHub (Git Credential Manager)
set GIT_TERMINAL_PROMPT=1
set GCM_INTERACTIVE=auto
echo ============================================
echo   Pubblicazione di Social Connect su GitHub
echo   repository: massimolaurenzi83/social-connect
echo ============================================
echo.
echo Se si apre una finestra di login GitHub, completa l'accesso.
echo.
git push -u origin main
echo.
if errorlevel 1 (
  echo [!] Push non completato. Leggi il messaggio qui sopra.
) else (
  echo [OK] Progetto pubblicato su GitHub.
)
echo.
pause
