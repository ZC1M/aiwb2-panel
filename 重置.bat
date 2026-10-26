@echo off
chcp 65001 >nul
title 重置登录状态
cd /d "%~dp0"

echo.
echo  这会删掉两个号已经保存的登录状态，让它们重新扫码。
echo  钱包和里面的钱不受影响，只是要重新扫一次。
echo.
echo  适合：两个号显示成同一个钱包、或者登录过期扫不进去。
echo.
set /p ok=  确认重置? (y/n): 
if /i not "%ok%"=="y" exit /b 0

echo.
echo  先把残留进程清掉...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js|aiwb' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

if exist "数据\账号1\baw\session.json" del /f /q "数据\账号1\baw\session.json" && echo  已清空 账号1 的登录状态
if exist "数据\账号2\baw\session.json" del /f /q "数据\账号2\baw\session.json" && echo  已清空 账号2 的登录状态
if not exist "数据\账号1\baw\session.json" if not exist "数据\账号2\baw\session.json" echo  两个号都清空了

echo.
echo  下一步：双击 启动.bat，然后账户1 用第一台手机扫，账户2 用第二台手机扫。
echo  扫完看两个地址是不是不一样。
echo.
pause
