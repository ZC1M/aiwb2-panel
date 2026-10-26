// 验证：两个账号能真正并发，且账/文件互不污染；同一个账号内部仍然排队。
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'acct-test-'));
process.env.AIWB2_DATA = base;
process.env.AIWB_HOME = join(base, 'GLOBAL-SHOULD-NOT-BE-USED');

const { withAcct } = await import('../lib/ui/server.mjs');
const { home } = await import('../lib/store.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

// 1) 两个账号并发：各自拿到的记账目录必须是自己那个，耗时也必须是并行
const t0 = Date.now();
const r = await Promise.all([
  withAcct('1', async () => { await sleep(250); return { n: '1', h: home() }; }),
  withAcct('2', async () => { await sleep(250); return { n: '2', h: home() }; }),
]);
const el = Date.now() - t0;
ok(r[0].h.includes('账号1'), '账号1 并发中记账目录仍是自己的: ' + r[0].h);
ok(r[1].h.includes('账号2'), '账号2 并发中记账目录仍是自己的: ' + r[1].h);
ok(el < 460, `两个账号真并行（耗时 ${el}ms；串行会 ≥500ms）`);
ok(process.env.AIWB_HOME === join(base, 'GLOBAL-SHOULD-NOT-BE-USED'), '全局 env 全程没被改（旧实现会互相覆盖）');

// 2) 同一个账号连点两次：必须排队，不能抢 nonce
const t1 = Date.now();
await Promise.all([
  withAcct('1', async () => { await sleep(150); }),
  withAcct('1', async () => { await sleep(150); }),
]);
const el2 = Date.now() - t1;
ok(el2 >= 280, `同账号两次排队（${el2}ms；并行会 ≈150ms）`);

// 3) 嵌套调用不会等自己等到死
const t2 = Date.now();
const v = await withAcct('1', () => withAcct('1', async () => 'ok'));
ok(v === 'ok' && Date.now() - t2 < 500, `嵌套 withAcct 不死锁（${Date.now() - t2}ms）`);

// 4) 真的写文件：各写各的目录，互不污染
await Promise.all(['1', '2'].map(n => withAcct(n, async () => {
  await sleep(80);
  mkdirSync(home(), { recursive: true });
  appendFileSync(join(home(), 'x.txt'), 'acct' + n + '\n');
})));
const a = readFileSync(join(base, '账号1', 'aiwb', 'x.txt'), 'utf8').trim();
const b = readFileSync(join(base, '账号2', 'aiwb', 'x.txt'), 'utf8').trim();
ok(a === 'acct1', '账号1 的文件里只有账号1 的账: ' + a);
ok(b === 'acct2', '账号2 的文件里只有账号2 的账: ' + b);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
