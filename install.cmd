@echo off
setlocal EnableExtensions

set "REPO=%ORCHIVOX_REPOSITORY%"
if "%REPO%"=="" set "REPO=MFathan7/orchivox-agent"
set "LAUNCHER_URL=%ORCHIVOX_LAUNCHER_URL%"
if "%LAUNCHER_URL%"=="" set "LAUNCHER_URL=https://github.com/%REPO%/releases/latest/download/launcher.mjs"

where node >nul 2>nul
if errorlevel 1 (
  echo orchivox: Node.js 20 or newer is required. Install Node, then run this script again. https://nodejs.org
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo orchivox: Node.js 20 or newer is required. Found:
  node --version
  exit /b 1
)

where curl.exe >nul 2>nul
if errorlevel 1 (
  echo orchivox: curl.exe is required. Windows 10 1803 and Windows 11 include it.
  exit /b 1
)

set "TMPDIR=%TEMP%\orchivox-install-%RANDOM%%RANDOM%"
mkdir "%TMPDIR%" >nul 2>nul
if errorlevel 1 (
  echo orchivox: could not create a temporary directory.
  exit /b 1
)

curl.exe -fsSL --retry 3 --retry-connrefused "%LAUNCHER_URL%" -o "%TMPDIR%\launcher.mjs"
if errorlevel 1 (
  echo orchivox: could not download the launcher from %LAUNCHER_URL%
  rmdir /s /q "%TMPDIR%" >nul 2>nul
  exit /b 1
)

node "%TMPDIR%\launcher.mjs" install %*
set "CODE=%ERRORLEVEL%"
rmdir /s /q "%TMPDIR%" >nul 2>nul
exit /b %CODE%
