@echo off
setlocal
set "HELPER_VERSION=v0.1.1"
chcp 65001 >nul
cd /d "%~dp0"
echo 1. English (will download if missing)
echo 2. 简体中文 (如果不存在将下载)
echo.
echo Select language / 选择语言
choice /c 12 /n /m "> "
if errorlevel 2 goto chinese
set "LANG=en"
set "FILE=kikoto-helper.en.ps1"
goto download
:chinese
set "LANG=zh"
set "FILE=kikoto-helper.zh-Hans.ps1"
:download
if exist "%FILE%" goto run
echo Downloading %FILE%...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; $u=('https://'+'raw.githubusercontent.com/yexca/kikoto/main/kikoto-helper/'+$env:FILE); Invoke-WebRequest -Uri $u -OutFile $env:FILE -UseBasicParsing
if errorlevel 1 (
  echo Download failed. Check your network connection and try again.
  pause
  exit /b 1
)
:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%FILE%" -Language %LANG% -LauncherVersion %HELPER_VERSION%
if errorlevel 1 pause
endlocal
