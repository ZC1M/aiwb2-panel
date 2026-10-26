// 双币安钱包 —— 一个交易页，右上角两个钱包，勾哪个就买哪个
// 界面是 aiwb 官方那个交易页的副本（lib/ 目录），加了多账号支持。
// 只监听 127.0.0.1，不上传任何数据，每笔交易由币安签名。
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const HERE = __dirname;                 // .../工具
const ROOT = path.dirname(HERE);        // 包根目录
const DATA = path.join(ROOT, '数据');
const IS_WIN = process.platform === 'win32';
const PORT = Number(process.env.AIWB2_PORT || 8787);

fs.mkdirSync(DATA, { recursive: true });

// 自己写日志：这样启动.bat 可以直接前台跑 node（关窗口就真的停了，不会留后台），
// 又不用 PowerShell 的 Tee 包装（那个会把 Node 的提示渲染成红色报错块）。
const LOGFILE = path.join(ROOT, '启动日志.txt');
try { fs.writeFileSync(LOGFILE, ''); } catch (e) {}
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\r\n'); } catch (e) {}
};
process.env.AIWB2_DATA = DATA;
process.env.NODE_USE_ENV_PROXY = '1';

// ---------------------------------------------------------------
// 账号隔离第一件事：把 keytar 挡掉。
// 币安 CLI 默认把登录凭证存进系统凭据管理器（keytar），Service=baw、
// Account=agentSessionId 是写死的，全局只有一份 —— 登第二个号会把第一个
// 顶掉。挡掉之后它会退回写各自目录下的 session.json，一个号一份，互不影响。
// ---------------------------------------------------------------
let acctDir = { baw: '', aiwb: '' };
function setupAcct(n) {
  const d = path.join(DATA, '账号' + n);
  const baw = path.join(d, 'baw');
  const aiwb = path.join(d, 'aiwb');
  for (const p of [baw, aiwb]) fs.mkdirSync(p, { recursive: true });
  return { baw, aiwb };
}
acctDir = setupAcct('1');
process.env.BINANCE_BAW_DIR = acctDir.baw;
process.env.AIWB_HOME = acctDir.aiwb;

function npmRoot() {
  try {
    return execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
  } catch (e) { return ''; }
}

function keytarCandidates() {
  const root = npmRoot();
  const out = [];
  if (root) {
    out.push(path.join(root, '@binance', 'agentic-wallet', 'node_modules', '@github', 'keytar'));
    out.push(path.join(root, '@github', 'keytar'));
  }
  // Windows 上 npm 的全局目录还可能在别处，兜底几个常见位置
  if (IS_WIN) {
    const appdata = process.env.APPDATA || '';
    const la = process.env.LOCALAPPDATA || '';
    for (const b of [appdata, la]) {
      if (!b) continue;
      out.push(path.join(b, 'npm', 'node_modules', '@binance', 'agentic-wallet', 'node_modules', '@github', 'keytar'));
      out.push(path.join(b, 'npm', 'node_modules', '@github', 'keytar'));
    }
  }
  return out;
}

// 返回 true = 已经挡掉（两个号各存各的）；false = 还挡不住
function disableKeytar() {
  let blocked = true;
  let seen = 0;
  for (const c of keytarCandidates()) {
    if (!fs.existsSync(c)) continue;
    seen++;
    let ok = false;
    // 先试直接删（最彻底），失败再试改名
    try { fs.rmSync(c, { recursive: true, force: true }); ok = !fs.existsSync(c); } catch (e) {}
    if (!ok) {
      try { fs.renameSync(c, c + '.disabled'); ok = !fs.existsSync(c); } catch (e) {}
    }
    if (ok) {
      log('  [隔离] 已挡住 keytar: ' + c);
    } else {
      blocked = false;
      log('  [隔离失败] 删不掉也改不了名: ' + c);
      log('           有其他程序正占用它，把币安相关的窗口全部关掉再启动。');
    }
  }
  // 大小写不敏感的文件系统上可能漏判，最后再扫一遍
  if (blocked && seen === 0) {
    const root = npmRoot();
    if (root) {
      const g = path.join(root, '@github');
      if (fs.existsSync(g)) {
        try {
          for (const d of fs.readdirSync(g)) {
            if (/^keytar/i.test(d)) {
              const t = path.join(g, d);
              try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {}
              if (fs.existsSync(t)) blocked = false;
              else log('  [隔离] 已挡住 keytar: ' + t);
            }
          }
        } catch (e) {}
      }
    }
  }
  process.env.AIWB2_KEYTAR = blocked ? 'blocked' : 'present';
  return blocked;
}

function openBrowser(url) {
  try {
    let c;
    if (IS_WIN) c = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'darwin') c = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else c = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } catch (e) {}
}

(async () => {
  log('双币安钱包 启动中...');
  const ok = disableKeytar();
  if (ok) log('  账号隔离正常：两个号各存各的登录状态');
  else log('  ⚠ 隔离没成功：两个号可能会互相顶掉，看上面那行提示');
  log('  账号1: ' + acctDir.baw);
  const d2 = setupAcct('2');
  log('  账号2: ' + d2.baw);

  const { createRpc, PUBLIC_BSC } = await import('../lib/rpc.mjs');
  const { createWallet, findBaw } = await import('../lib/wallet.mjs');
  const { createEngine } = await import('../lib/engine.mjs');
  const { loadConfig } = await import('../lib/store.mjs');
  const { startUi } = await import('../lib/ui/server.mjs');

  const cfg = loadConfig();
  const rpc = createRpc(cfg.rpc || PUBLIC_BSC);
  const bin = findBaw(cfg);
  if (!bin) {
    log('找不到 baw（币安钱包命令行）。先跑: npm install -g @binance/agentic-wallet');
    process.exit(1);
  }

  // 每个账号一个独立的钱包实例，env 在创建时就固定好。
  // 关键是登录的「验证」那一步也要走这个实例，否则会话会写进同一个目录。
  const wallets = {};
  const engines = {};
  for (const n of ['1', '2']) {
    const d = setupAcct(n);
    const env = Object.assign({}, process.env, {
      BINANCE_BAW_DIR: d.baw,
      AIWB_HOME: d.aiwb,
      NODE_USE_ENV_PROXY: '1',
    });
    wallets[n] = createWallet({ bin, env });
    engines[n] = createEngine({ rpc, wallet: wallets[n], cfg });
  }
  log('  钱包实例已按账号分开: 账号1 → 数据\\账号1, 账号2 → 数据\\账号2');

  const ui = await startUi({ cfg, rpc, wallet: wallets['1'], createEngine, wallets, engines, port: PORT });

  log('  交易页: ' + ui.link);
  log('  右上角两个钱包，勾哪个就买哪个。这个窗口别关。');
  openBrowser(ui.link);
})().catch((e) => {
  log('启动失败: ' + (e && e.message ? e.message : e));
  log('常见原因：端口 8787 被占（先双击 清理.bat 再启动），或者网络不通。');
  setTimeout(() => process.exit(1), 3000);
});
