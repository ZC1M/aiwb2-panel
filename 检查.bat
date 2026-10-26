@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set OUT=检查结果.txt
echo === 双币安钱包 检查 === > "%OUT%"
echo. >> "%OUT%"

echo [1] Node 版本 >> "%OUT%"
node -v >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [2] 币安工具 baw >> "%OUT%"
call baw --version >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [3] npm 全局目录 >> "%OUT%"
for /f "delims=" %%i in ('call npm root -g 2^>nul') do set GR=%%i
echo %GR% >> "%OUT%"
echo. >> "%OUT%"

echo [4] keytar 隔离状态 >> "%OUT%"
if exist "%GR%\@binance\agentic-wallet\node_modules\@github\keytar" (
  echo   还在 —— 没挡住，两个号会互相顶掉 >> "%OUT%"
) else (
  echo   已挡住 >> "%OUT%"
)
echo. >> "%OUT%"

echo [5] 两个号的会话文件对比  ^<== 关键 >> "%OUT%"
if exist "数据\账号1\baw\session.json" (
  echo   账号1: 有 session.json >> "%OUT%"
  for %%A in ("数据\账号1\baw\session.json") do echo         大小 %%~zA 字节 >> "%OUT%"
) else (
  echo   账号1: 没有 session.json（没登录过） >> "%OUT%"
)
if exist "数据\账号2\baw\session.json" (
  echo   账号2: 有 session.json >> "%OUT%"
  for %%A in ("数据\账号2\baw\session.json") do echo         大小 %%~zA 字节 >> "%OUT%"
) else (
  echo   账号2: 没有 session.json（没登录过） >> "%OUT%"
)
echo. >> "%OUT%"
echo   -- 两个文件的 MD5（一样 = 会话是同一份）: >> "%OUT%"
if exist "数据\账号1\baw\session.json" certutil -hashfile "数据\账号1\baw\session.json" MD5 2>nul | findstr /v ":" >> "%OUT%"
if exist "数据\账号2\baw\session.json" certutil -hashfile "数据\账号2\baw\session.json" MD5 2>nul | findstr /v ":" >> "%OUT%"
echo. >> "%OUT%"

echo   -- sessionId 指纹（只看头尾，不泄露）: >> "%OUT%"
node -e "const fs=require('fs');for(const n of ['1','2']){const p='数据/账号'+n+'/baw/session.json';try{const d=JSON.parse(fs.readFileSync(p,'utf8'));const s=d.sessionId||'';console.log('      账号'+n+': 有sessionId='+(s?'是':'否')+' 长度='+s.length+' 头='+s.slice(0,12)+' 尾='+s.slice(-8));}catch(e){console.log('      账号'+n+': 读不到 ('+e.message+')');}}" >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo   -- 页面里两个号显示的地址（从服务端读）: >> "%OUT%"
node -e "const http=require('http');const fs=require('fs');let key='';try{const t=fs.readFileSync('启动日志.txt','utf8');const m=t.match(/k=([0-9a-f]+)/);if(m)key=m[1];}catch(e){}if(!key){console.log('      没有启动日志，拿不到口令');process.exit(0);}http.get({host:'127.0.0.1',port:8787,path:'/api/state',headers:{'x-aiwb-key':key}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{const j=JSON.parse(b);const a=j.accounts||{};for(const n of Object.keys(a).sort()){console.log('      账号'+n+': 登录='+(a[n].signedIn?'是':'否')+' 地址='+(a[n].address||'-')+' BNB='+(a[n].bnb==null?'-':a[n].bnb));}console.log('      keytarBlocked='+j.keytarBlocked);}catch(e){console.log('      解析失败: '+b.slice(0,200));}});}).on('error',e=>console.log('      服务没在跑: '+e.message));" >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [6] 端口 8787 >> "%OUT%"
netstat -ano | findstr "LISTENING" | findstr ":8787" >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [7] 启动日志 >> "%OUT%"
if exist 启动日志.txt (type 启动日志.txt >> "%OUT%") else (echo   没有 启动日志.txt >> "%OUT%")

echo.
echo  检查完了。结果在 检查结果.txt，发给我。
echo.
notepad "%OUT%"
