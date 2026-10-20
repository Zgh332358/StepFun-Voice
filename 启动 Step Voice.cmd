@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 22.19 or newer first.
  exit /b 1
)
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund || exit /b 1
)
if "%STEP_API_KEY%"=="" if "%STEPFUN_API_KEY%"=="" echo Tip: no STEP_API_KEY detected. You can enter it in the /voice setup flow.
call step -e .\index.ts
