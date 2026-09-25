@echo off
REM 9Router V3 — one-command local startup (Windows).
REM Usage: start.bat
REM Requires Node.js 20+ (https://nodejs.org). For a public URL, run
REM cloudflared separately: cloudflared tunnel --url http://localhost:5177
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo ERROR: node not found. Install Node.js 20+. & exit /b 1)
where npm >nul 2>nul || (echo ERROR: npm not found. & exit /b 1)

if not exist "node_modules\.bin\tsx.cmd" (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || (echo ERROR: npm install failed. & exit /b 1)
)

if not exist "backend\.env" (
  if not exist "backend\.env.example" (echo ERROR: backend\.env.example missing. & exit /b 1)
  echo Creating backend\.env from example (edit it to change INITIAL_PASSWORD^)...
  copy /y "backend\.env.example" "backend\.env" >nul
)

echo Starting 9Router V3 (backend :3001 + dashboard :5177)...
echo Press Ctrl+C to stop.
call npm run dev
