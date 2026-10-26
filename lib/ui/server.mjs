// `aiwb ui`: a trading page on your own computer. It is the same engine as the commands, behind a small web server that
// only listens on 127.0.0.1 and only answers requests carrying a random key made when it starts (the page gets it in
// the link that opens it). Binance's App does the sign-in (QR code) and every signature; this page never sees a key.
// Market data (price, chart) comes from Binance's public Web3 endpoints; trading goes through `baw` as always.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check } from '../check.mjs';
import { journal, pnl, loadSnipes, saveSnipes, loadConfig, als } from '../store.mjs';
import { addSnipe, run as runSnipes, SELL_WARNING } from '../snipe.mjs';
import { LAUNCHPADS } from '../platforms/index.mjs';
import { fromWei, AGENT_ID } from '../engine.mjs';
import { isAddress } from '../abi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const qrcode = createRequire(import.meta.url)('./qrcode.cjs');
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://bin.bnbstatic.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const json = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const UA = { 'accept-encoding': 'identity', 'user-agent': 'binance-web3/2.0 (Skill)' };
async function getJson(url, ms = 6000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { headers: UA, signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
// Price, market cap, holders and logo from Binance's public token data (null for coins it hasn't indexed yet).
async function market(token) {
  const d = (await getJson(`https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai?chainId=56&contractAddress=${token}`).catch(() => null))?.data;
  const m = (await getJson(`https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info/ai?chainId=56&contractAddress=${token}`).catch(() => null))?.data;
  if (!d && !m) return null;
  const n = x => (x == null || x === '' ? null : Number(x));
  return { price: n(d?.price), marketCap: n(d?.marketCap), holders: n(d?.holders), volume24h: n(d?.volume24h), change24h: n(d?.percentChange24h),
    icon: m?.icon ? `https://bin.bnbstatic.com${m.icon}` : null, links: (m?.links || []).filter(l => /^https:\/\//.test(l?.link || '')).map(l => ({ label: l.label, link: l.link })).slice(0, 6) };
}
const INTERVALS = new Set(['1s', '1min', '5min', '15min', '1h', '4h', '1d']);
async function candles(token, interval) {
  const r = await getJson(`https://dquery.sintral.io/u-kline/v1/k-line/candles?platform=bsc&address=${token}&interval=${interval}&limit=300`).catch(() => null);
  // [open, high, low, close, volume, time ms, trades]
  return (r?.data || []).map(c => ({ o: c[0], h: c[1], l: c[2], c: c[3], v: c[4], t: c[5] }));
}

// ---- 多账号 ----
// 每个账号的钱包实例在建好时就绑定死了自己的 env（BINANCE_BAW_DIR / AIWB_HOME），
// 记账目录也改成跟着任务走（store.mjs 里的 AsyncLocalStorage）。
// 所以两个账号可以真正同时下单：互不踩账、互不串号。
// 只有「同一个账号」还排队，防止它自己跟自己抢 nonce。
const ACCTS = { '1': '账户1', '2': '账户2' };
function acctDirs(n) {
  const base = process.env.AIWB2_DATA;
  if (!base) return null;
  const d = join(base, '账号' + n);
  return { baw: join(d, 'baw'), aiwb: join(d, 'aiwb') };
}
const ACCT_LOCKS = {};

// 币安每个地址同一时间只允许一笔在途交易：你上次没在 App 里点确认，那笔就一直挂着，
// 这时点新的卖出会被拒（already in progress）。这里把挂着的取消掉，好让同一笔重发，
// 你不用去 App 里找入口，也不用干等。
export async function healLock(w, { max = 5, settleMs = 2500 } = {}) {
  const list = await w.pendingTxs().catch(() => []);
  let cleared = 0;
  for (const t of list.slice(0, max)) {
    try { await w.cancel(t.hash); cleared += 1; } catch { /* 取消不动就算了，重发时会报原错 */ }
  }
  if (cleared && settleMs) await new Promise(r => setTimeout(r, settleMs));
  return cleared;
}

// 发一笔；如果币安说"这地址还有一笔在途"，就把旧的取消掉再发一次。用户只管点，不管这些。
export async function sendWithHeal(w, withAcctFn, n, fn) {
  try { return await withAcctFn(n, () => fn(n)); }
  catch (e) {
    if (!e || e.code !== 'TX_LOCKED') throw e;
    let healed = 0;
    try { healed = await withAcctFn(n, () => healLock(w)); } catch { /* 清不动就还是按原样重试 */ }
    try {
      const r = await withAcctFn(n, () => fn(n));
      if (r && typeof r === 'object') r.healed = healed;
      return r;
    } catch (e2) { e2.healed = healed || 1; throw e2; }
  }
}

export function withAcct(n, fn) {
  // 已经在某个账号的上下文里了（嵌套调用）：直接跑，不要再套锁，否则会等自己等到死。
  if (als.getStore()) return Promise.resolve().then(fn);
  const d = acctDirs(n);
  const runIt = () => (d ? als.run({ aiwb: d.aiwb, baw: d.baw }, () => fn()) : fn());
  const prev = ACCT_LOCKS[n] || Promise.resolve();
  const p = prev.then(runIt, runIt);
  ACCT_LOCKS[n] = p.then(() => {}, () => {});
  return p;
}

export async function startUi({ cfg, rpc, wallet, createEngine, wallets, engines, port = 0, log = console.log }) {
  const key = randomBytes(24).toString('hex');
  let stopped = false;
  const clients = new Set();
  const emit = (type, data) => { const msg = `event: ${type}\ndata: ${json(data)}\n\n`; for (const c of clients) c.write(msg); };
  const appWaitSec = cfg.appWaitSec ?? 600;
  // 每个账号一个钱包实例（各自的 env：BINANCE_BAW_DIR / AIWB_HOME），
  // 不再靠临时改 process.env —— 那样异步的登录验证会串到别的账号去。
  const W = wallets || { '1': wallet };
  // 哪个账号正在等你手机上点确认：存在后端，页面刷新/断线重连也还能看到，不会"弹一下就没"。
  const appPending = {};
  const mkEngine = (w, n) => createEngine({ rpc, wallet: w, cfg, onAppWait: label => {
    appPending[n] = { label, waitSec: appWaitSec, at: Date.now(), acct: n };
    emit('app', appPending[n]);
  } });
  const E = Object.assign({}, engines || {});
  // 每个账号都必须用自己那套带"等 App 确认"回调的引擎：binance 要求 App 确认时才会真的发到手机
  for (const k of Object.keys(W)) E[k] = mkEngine(W[k], k);
  const engine = E['1'] || mkEngine(wallet, '1');

  // ---- new coins on the agent-only launchpads (the left column) ----
  const feed = [];
  async function watchLaunches() {
    // Start about 7 minutes back so the list isn't empty when the page opens; catch up in bigger steps.
    let from = (await rpc.blockNumber().catch(() => 0n)) - 900n;
    while (!stopped) {
      const head = await rpc.blockNumber().catch(() => from - 1n);
      let failed = false;
      if (head >= from) {
        const to = head - from > 100n ? from + 100n : head;
        for (const [platform, pad] of Object.entries(LAUNCHPADS)) {
          const logs = await rpc.logs({ fromBlock: from, toBlock: to, address: pad.watch.address, topics: pad.watch.topics }).catch(() => { failed = true; return []; });
          for (const l of logs) {
            const coin = await pad.watch.parse(l, rpc).catch(() => null);
            if (!coin || feed.some(c => c.token === coin.token)) continue;
            // Age from the block number (BNB Chain makes a block about every 0.45 s): saves a request per coin.
            const block = BigInt(l.blockNumber);
            const item = { ...coin, platform, block: Number(block), seen: Date.now() - Number(head > block ? head - block : 0n) * 450 };
            feed.unshift(item); feed.sort((a, b) => b.block - a.block); feed.length = Math.min(feed.length, 80);
            emit('coin', item);
          }
          if (failed) break;
        }
        if (!failed) from = to + 1n;
      }
      await new Promise(r => setTimeout(r, failed ? 4000 : head - from > 5n ? 200 : 1500));
    }
  }

  // ---- snipes run inside this process while the page is open ----
  const snipeLog = [];
  const snipeSay = (...a) => { const line = { at: Date.now(), text: a.join(' ') }; snipeLog.push(line); snipeLog.splice(0, snipeLog.length - 100); emit('snipe', line); };
  let snipesRunning = null;
  try {
    snipesRunning = runSnipes({ engine, rpc, log: snipeSay, keepAlive: true, stopped: () => stopped }).catch(e => { snipeSay(`snipes stopped: ${e.message}`); snipesRunning = null; });
  } catch (e) { snipeSay(e.message); }

  // ---- wallet state, cached briefly ----
  const stateCache = {};
  async function state(acct = '1', fresh = false) {
    const c = stateCache[acct];
    if (!fresh && c && Date.now() - c.at < 15_000) return c.v;
    const v = { acct, name: ACCTS[acct] || acct, signedIn: false, appWaitSec, cfg: { slippagePct: cfg.slippagePct, maxPerTradeBnb: cfg.maxPerTradeBnb ?? null, dailyCapBnb: cfg.dailyCapBnb ?? null } };
    const w = W[acct] || wallet;
    try {
      const st = await w.status();
      v.signedIn = st?.status === 'CONNECTED';
      if (v.signedIn) {
        v.address = await w.address();
        const [bnb, aid, s] = await Promise.all([rpc.balance(v.address).catch(() => null), rpc.read(AGENT_ID, 'balanceOf(address)', [v.address], ['uint256']).catch(() => null), w.settings().catch(() => null)]);
        v.bnb = bnb == null ? null : fromWei(bnb);
        v.agentId = aid == null ? null : aid > 0n;
        if (s) v.settings = { devMode: !!s.devMode?.enabled, devModeUntil: s.devMode?.expiresAt || null, riskyTx: s.abnormalTxnHandling || null, tradeAllTokens: !!s.tradeAllTokens, sessionEnds: s.sessionExpireTime || null };
      }
    } catch (e) { v.error = e.message; }
    stateCache[acct] = { at: Date.now(), v };
    return v;
  }

  const pickAccts = (b) => {
    const req = Array.isArray(b && b.accts) ? b.accts.filter(x => ACCTS[x]) : [];
    if (req.length) return req;
    const signed = Object.keys(ACCTS).filter(n => stateCache[n] && stateCache[n].v && stateCache[n].v.signedIn);
    return signed.length ? signed : ['1'];
  };
  // 勾选的每个账号同时执行（各用各的钱包、各记各的账），谁成功谁失败分开报。
  // 同一个账号内部仍然排队：防止连点两次抢 nonce。
  async function multi(job, list, fn) {
    const results = await Promise.all(list.map(async n => {
      try {
        const r = await sendWithHeal(W[n] || wallet, withAcct, n, fn);
        stateCache[n] = null;
        emit('trade', { job, ok: true, result: r, acct: n, healed: r && r.healed });
        return { acct: n, ok: true, result: r, healed: r && r.healed };
      } catch (e) {
        emit('trade', { job, ok: false, error: e.message, acct: n, healed: e.healed });
        return { acct: n, ok: false, error: e.message, healed: e.healed };
      } finally {
        delete appPending[n]; // 这笔有结果了，等待提示就该消失
      }
    }));
    return { results };
  }

  async function tokenView(ca) {
    const [inspect, mk] = await Promise.all([engine.inspect(ca), market(ca)]);
    const i = inspect.info;
    return {
      token: ca, symbol: inspect.symbol, decimals: inspect.decimals, held: inspect.held == null ? null : fromWei(inspect.held, inspect.decimals, inspect.decimals),
      walletBnb: inspect.walletBnb == null ? null : fromWei(inspect.walletBnb), hasAgentId: inspect.hasAgentId,
      info: i && { platform: i.platform, phase: i.phase, agentOnly: !!i.agentOnly, notTradable: !!i.notTradable, buyTaxPct: i.buyTaxPct ?? null, sellTaxPct: i.sellTaxPct ?? null,
        openingFeePct: i.openingFeePct ?? null, progress: i.progress ?? null, quoteSymbol: i.quoteSymbol ?? null, unit: i.unit || 'coins', name: i.name ?? null, launchedToken: i.launchedToken ?? null, market: i.market ?? null },
      market: mk,
    };
  }

  // What the wallet holds, from the journal, with live balances and value where Binance has a price.
  async function holdings(eng) {
    const e2 = eng || engine;
    const rows = pnl().filter(p => p.heldTokens > 0).slice(-30);
    return Promise.all(rows.map(async p => {
      const [view, mk] = await Promise.all([e2.inspect(p.token).catch(() => null), market(p.token)]);
      const held = view?.held != null ? Number(fromWei(view.held, view.decimals, 8)) : p.heldTokens;
      return { ...p, held, platform: view?.info?.platform || null, phase: view?.info?.phase || null, price: mk?.price ?? null, icon: mk?.icon ?? null,
        valueUsd: mk?.price != null ? held * mk.price : null };
    })).then(list => list.filter(p => p.held > 0)); // sold outside aiwb (e.g. in the Binance App): drop it
  }

  async function trade(job, fn, acct = '1') {
    try {
      const r = await withAcct(acct, fn);
      stateCache[acct] = null; emit('trade', { job, ok: true, result: r, acct });
      return r;
    } catch (e) { emit('trade', { job, ok: false, error: e.message, acct }); throw e; }
  }

  const routes = {
    'GET /api/state': async (q) => {
      const accounts = {};
      for (const n of Object.keys(ACCTS)) accounts[n] = await state(n, q.fresh === '1');
      const primary = Object.values(accounts).find(a => a.signedIn) || accounts['1'];
      return { ...primary, accounts, appPending, keytarBlocked: process.env.AIWB2_KEYTAR === 'blocked' };
    },
    'POST /api/login': async (_, b) => {
      const n = b && ACCTS[b.acct] ? b.acct : '1';
      const w = W[n] || wallet;
      const s = await w.signin();
      if (s?.status === 'ALREADY_CONNECTED') return { connected: true, acct: n };
      if (!s?.urlForWeb || !s?.qrCodeId) throw new Error('Binance did not return a sign-in code. Try again.');
      const qr = qrcode(0, 'M'); qr.addData(s.urlForWeb); qr.make();
      // 验证用这个账号自己的钱包实例，会话才会写进它自己的目录
      w.verify(s.qrCodeId).then(() => { stateCache[n] = null; emit('login', { ok: true, acct: n }); }).catch(e => emit('login', { ok: false, error: e.message, acct: n }));
      return { qrSvg: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }), url: s.urlForWeb, pairingCode: s.pairingCode ?? null, expireAt: s.expireAt ?? null, acct: n };
    },
    'GET /api/token': async (q) => { if (!isAddress(q.ca)) throw new Error('Paste a contract address (0x followed by 40 characters).'); return tokenView(q.ca); },
    'GET /api/check': async (q) => { if (!isAddress(q.ca)) throw new Error('bad address'); return check(engine, q.ca); },
    'GET /api/candles': async (q) => { if (!isAddress(q.ca)) throw new Error('bad address'); return candles(q.ca, INTERVALS.has(q.interval) ? q.interval : '1min'); },
    // A trade can wait minutes for a confirmation in the Binance App, so its result is also pushed as an event (with the
    // page's own job id) in case the browser gives up on the request first.
    'POST /api/buy': async (_, b) => {
      if (!isAddress(b.ca)) throw new Error('bad address');
      const bnbAmt = Number(b.bnb);
      if (!(bnbAmt > 0)) throw new Error('Enter how much BNB to spend.');
      const list = pickAccts(b);
      return multi(b.job, list, (n) => (E[n] || engine).buy(b.ca, String(bnbAmt), { slippagePct: b.slippagePct ? Number(b.slippagePct) : undefined, source: 'ui' }));
    },
    'POST /api/sell': async (_, b) => {
      if (!isAddress(b.ca)) throw new Error('bad address');
      const pct = Number(b.percent);
      if (!(pct > 0 && pct <= 100)) throw new Error('Choose how much to sell (1 to 100%).');
      const list = pickAccts(b);
      return multi(b.job, list, (n) => (E[n] || engine).sell(b.ca, { percent: pct }, { slippagePct: b.slippagePct ? Number(b.slippagePct) : undefined, source: 'ui' }));
    },
    'POST /api/claim': async (_, b) => {
      if (!isAddress(b.ca)) throw new Error('bad address');
      const list = pickAccts(b);
      return multi(b.job, list, (n) => (E[n] || engine).claim(b.ca));
    },
    'GET /api/feed': async () => feed,
    'GET /api/holdings': async () => {
      const out = [];
      for (const n of Object.keys(ACCTS)) {
        try {
          const rows = await withAcct(n, () => holdings(E[n] || engine));
          out.push(...rows.map(r => ({ ...r, acct: n })));
        } catch { /* 这个号没登录或没持仓 */ }
      }
      return out;
    },
    'GET /api/journal': async () => {
      const out = [];
      for (const n of Object.keys(ACCTS)) {
        try {
          const rows = await withAcct(n, () => Promise.resolve(journal().slice(-100).reverse()));
          out.push(...rows.map(r => ({ ...r, acct: n })));
        } catch { /* ignore */ }
      }
      return out;
    },
    'GET /api/snipes': async () => ({ list: loadSnipes(), log: snipeLog, running: !!snipesRunning, warning: SELL_WARNING }),
    'POST /api/snipes': async (_, b) => {
      // Same rules as the command: every number comes from the user, nothing has a default.
      const flags = { bnb: b.bnb, 'daily-cap': b.dailyCap, 'max-tax': b.maxTax, count: b.count, platform: b.platform, name: b.name || undefined, creator: b.creator || undefined };
      for (const k of Object.keys(flags)) if (flags[k] === '' || flags[k] == null) delete flags[k];
      const s = addSnipe(b.kind === 'token' ? 'token' : 'watch', flags, b.kind === 'token' ? [b.ca] : []);
      const all = loadSnipes(); all.push(s); saveSnipes(all);
      return s;
    },
    'POST /api/snipes/stop': async (_, b) => {
      const all = loadSnipes(), s = all.find(x => x.id === b.id);
      if (!s) throw new Error('no such snipe');
      s.active = false; saveSnipes(all); return s;
    },
  };

  const okKey = v => { const a = Buffer.from(String(v || '')), b = Buffer.from(key); return a.length === b.length && timingSafeEqual(a, b); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sec = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    // Only this computer's own browser, by this address: blocks other websites (and DNS rebinding) from reaching it.
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403, sec); return res.end(); }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) { res.writeHead(403, sec); return res.end(); }

    if (req.method === 'GET' && FILES[url.pathname]) {
      const [f, type] = FILES[url.pathname];
      res.writeHead(200, { ...sec, 'content-type': type, 'content-security-policy': CSP });
      return res.end(readFileSync(join(here, f)));
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404, sec); return res.end(); }
    if (!okKey(req.headers['x-aiwb-key'] || url.searchParams.get('k'))) { res.writeHead(401, { ...sec, 'content-type': 'application/json' }); return res.end(json({ error: 'This page link is out of date. Open the link aiwb ui printed.' })); }

    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...sec, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) { res.writeHead(404, { ...sec, 'content-type': 'application/json' }); return res.end(json({ error: 'not found' })); }
    let body = {};
    if (req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415, sec); return res.end(); }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) { res.writeHead(413, sec); return res.end(); } }
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, sec); return res.end(); }
    }
    try {
      const out = await route(Object.fromEntries(url.searchParams), body);
      res.writeHead(200, { ...sec, 'content-type': 'application/json' });
      res.end(json(out));
    } catch (e) {
      res.writeHead(400, { ...sec, 'content-type': 'application/json' });
      res.end(json({ error: e.message, code: e.code || null }));
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const link = `http://127.0.0.1:${server.address().port}/#k=${key}`;
  watchLaunches();
  return { server, link, close: () => { stopped = true; for (const c of clients) c.end(); server.close(); } };
}
