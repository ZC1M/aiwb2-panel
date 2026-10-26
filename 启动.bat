@echo off
chcp 65001 >nul
setlocal
title 双币安钱包
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  这台电脑还没装 Node.js，先装它。
  echo  马上打开官网，下载 LTS 版，一路点下一步。
  echo  装完关掉本窗口，重新双击 启动.bat
  echo.
  start https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

where baw >nul 2>nul
if errorlevel 1 (
  echo.
  echo  第一次运行，正在装币安钱包工具，几十秒，别关窗口...
  call npm install -g @binance/agentic-wallet
)

echo.
echo  [1/2] 先清掉上次留下的进程（不然端口 8787 被占，新的起不来）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js|aiwb' }; if ($p) { foreach ($x in $p) { Write-Host ('      结束 PID ' + $x.ProcessId); Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue } } else { Write-Host '      没有残留' }"
timeout /t 2 >nul

echo.
echo  [2/2] 启动。浏览器会自动弹出，不用了直接关这个窗口就行。
echo.
node "工具\server.js"

echo.
echo  已停止。要确认没残留就双击 清理.bat。
pause
