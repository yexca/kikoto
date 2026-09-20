@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Kikoto Helper / Kikoto 助手
echo.
echo 1. English / 英语 - download English helper / 下载英语文件
echo 2. Simplified Chinese / 简体中文 - download Chinese helper / 下载中文文件
echo.
choice /c 12 /n /m "Select language / 选择语言 (download required / 需要下载): "
if errorlevel 2 goto chinese
set "LANG=en"
set "FILE=kikoto-helper.en.ps1"
goto download
:chinese
set "LANG=zh"
set "FILE=kikoto-helper.zh-Hans.ps1"
:download
if exist "%FILE%" goto run
echo Downloading %FILE%... / 正在下载 %FILE%...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command $u=('https://'+'raw.githubusercontent.com/yexca/kikoto/main/kikoto-helper/'+$env:FILE); Invoke-WebRequest -Uri $u -OutFile $env:FILE -UseBasicParsing
if errorlevel 1 (
  echo Download failed. Check your network connection and try again. / 下载失败，请检查网络连接后重试。
  pause
  exit /b 1
)
:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%FILE%" -Language %LANG%
if errorlevel 1 pause
endlocal