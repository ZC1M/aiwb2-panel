@echo off
chcp 65001 >nul
title 清理后台
echo.
echo  正在结束这个工具留下的后台进程...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'aiwb|server\.js|双账号' }; if ($p) { foreach ($x in $p) { Write-Host ('  结束 PID ' + $x.ProcessId); Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue } ; Write-Host ''; Write-Host '  清理完成。' } else { Write-Host '  没有找到残留进程，已经是干净的。' }"
echo.
echo  现在可以删掉整个文件夹了。
echo.
pause
