@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo RepoReady — laptop setup
echo.

where node >nul 2>&1
if errorlevel 1 call :install_node
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  echo Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js %NODE_MAJOR% is too old. Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

echo Installing app dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

call :ensure_ollama

set OLLAMA_BASE_URL=http://127.0.0.1:11434
set OLLAMA_MODEL=qwen3:4b
set OLLAMA_TIMEOUT_MS=45000

echo.
echo Starting RepoReady at http://127.0.0.1:8080
echo Leave this window open. Close it to stop the app.
echo.
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://127.0.0.1:8080"
call npm run dev
echo.
echo The app stopped.
pause
exit /b 0

:install_node
echo Node.js was not found. Trying Windows package install...
where winget >nul 2>&1
if errorlevel 1 exit /b 1
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
exit /b 0

:ensure_ollama
where ollama >nul 2>&1
if errorlevel 1 (
  if exist "%LocalAppData%\Programs\Ollama\ollama.exe" set "PATH=%LocalAppData%\Programs\Ollama;%PATH%"
)
where ollama >nul 2>&1
if errorlevel 1 (
  echo Ollama was not found. Trying Windows package install...
  where winget >nul 2>&1
  if not errorlevel 1 winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
  if exist "%LocalAppData%\Programs\Ollama\ollama.exe" set "PATH=%LocalAppData%\Programs\Ollama;%PATH%"
)
where ollama >nul 2>&1
if errorlevel 1 (
  echo Ollama is not installed. The app will open, but model answers stay offline.
  echo Install it from https://ollama.com/download and run this file again.
  exit /b 0
)
curl.exe -fsS http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 start "Ollama" /min cmd /c "ollama serve"
echo Downloading qwen3:4b. The first download can take several minutes.
ollama pull qwen3:4b
if errorlevel 1 echo The model download failed. The app will still open without model answers.
exit /b 0
