@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set OUT=诊断结果.txt
echo === 两个号的会话 / 地址 对比 === > "%OUT%"
echo. >> "%OUT%"

echo [1] 两个 session.json 里的 sessionId 是不是同一份 >> "%OUT%"
node -e "const fs=require('fs');const a={};for(const n of ['1','2']){try{const d=JSON.parse(fs.readFileSync('数据/账号'+n+'/baw/session.json','utf8'));const s=d.sessionId||'';a[n]=s;console.log('  账号'+n+': '+(s?'有 sessionId，头 '+s.slice(0,12)+' 尾 '+s.slice(-8):'文件里没有 sessionId'));}catch(e){a[n]='';console.log('  账号'+n+': 读不到 ('+e.message+')');}}console.log('');if(a['1']&&a['2']){console.log('  >>> 两个号用的是不是同一个会话: '+(a['1']===a['2']?'是 —— 这就是问题':'不是 —— 会话确实是分开的'));}else{console.log('  >>> 有账号还没有会话（没登录成功）');}" >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [2] 直接问币安：账号1 的会话对应哪个钱包 >> "%OUT%"
set BINANCE_BAW_DIR=%CD%\数据\账号1\baw
set AIWB_HOME=%CD%\数据\账号1\aiwb
call baw wallet status --json >> "%OUT%" 2>&1
call baw wallet address --json >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [3] 直接问币安：账号2 的会话对应哪个钱包 >> "%OUT%"
set BINANCE_BAW_DIR=%CD%\数据\账号2\baw
set AIWB_HOME=%CD%\数据\账号2\aiwb
call baw wallet status --json >> "%OUT%" 2>&1
call baw wallet address --json >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [4] 两边的 BNB 余额 >> "%OUT%"
set BINANCE_BAW_DIR=%CD%\数据\账号1\baw
set AIWB_HOME=%CD%\数据\账号1\aiwb
echo   -- 账号1 -- >> "%OUT%"
call baw wallet balance --symbol BNB --json >> "%OUT%" 2>&1
set BINANCE_BAW_DIR=%CD%\数据\账号2\baw
set AIWB_HOME=%CD%\数据\账号2\aiwb
echo   -- 账号2 -- >> "%OUT%"
call baw wallet balance --symbol BNB --json >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [5] 我用的环境变量长什么样（确认路径对不对） >> "%OUT%"
echo   BINANCE_BAW_DIR=%BINANCE_BAW_DIR% >> "%OUT%"
echo   AIWB_HOME=%AIWB_HOME% >> "%OUT%"

echo.
echo.
echo  诊断完成，结果在 诊断结果.txt
echo  把这个文件发给我，一次就能定死是会话串了还是两个手机同一个账号。
echo.
notepad "%OUT%"
