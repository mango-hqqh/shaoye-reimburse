@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "release\1.1.1\win-unpacked\少爷今天报销了吗.exe" (
  start "" "release\1.1.1\win-unpacked\少爷今天报销了吗.exe"
  exit /b 0
)
echo 未找到桌面程序，请先运行 npm install 和 npm run package。
pause
