@echo off
setlocal
cd /d "%~dp0"
echo Kikoto Helper
echo.
echo 1. English - download English helper
echo 2. Simplified Chinese - download Chinese helper
echo.
choice /c 12 /n /m "Select language (the selected file must be downloaded): "
if errorlevel 2 goto chinese
set "LANG=en"
set "FILE=kikoto-helper.en.ps1"
goto download
:chinese
set "LANG=zh-Hans"
set "FILE=kikoto-helper.zh-Hans.ps1"
:download
if exist "%FILE%" goto run
echo Downloading %FILE%...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command $u=('https://'+'raw.githubusercontent.com/yexca/kikoto/main/kikoto-helper/'+$env:FILE); Invoke-WebRequest -Uri $u -OutFile $env:FILE -UseBasicParsing
if errorlevel 1 (
  echo Download failed. Check your network connection and try again.
  pause
  exit /b 1
):run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%FILE%" -Language %LANG%
if errorlevel 1 pause
endlocal
