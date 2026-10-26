// 验证"点卖出就自动清掉卡住的那笔再重发"这条链路是真的能用（不联网，用假 baw 回答）。
import assert from 'node:assert/strict';
import { createWallet } from '../lib/wallet.mjs';
import { healLock, sendWithHeal } from '../lib/ui/server.mjs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };
const Tx = { to: '0x1111111111111111111111111111111111111111', value: 0n, data: '0xdeadbeef' };

// baw 假回答：按命令返回不同结果
const fakeBaw = (calls, { locked = true, pending = [{ txHash: '0xold' }] } = {}) => async (args) => {
  calls.push(args.join(' '));
  if (args[0] === 'contract-call' && args[1] === 'preview') {
    return locked
      ? { success: false, error: { name: 'SERVICE_ERROR', message: 'A transaction to the same address on this network is already in progress. Please wait for it to complete before submitting a new one.' } }
      : { success: true, data: { requestId: 'req-1', simulationResult: { simulationCode: '000000000' } } };
  }
  if (args[0] === 'contract-call' && args[1] === 'execute') return { success: true, data: { status: 'BROADCASTED', txHash: '0xnew' } };
  if (args[0] === 'wallet' && args[1] === 'tx-history') return { success: true, data: { transactions: pending } };
  if (args[0] === 'wallet' && args[1] === 'cancel') return { success: true, data: { txHash: '0xcancel', status: 'BROADCASTED' } };
  if (args[0] === 'wallet' && args[1] === 'address') return { success: true, data: [{ address: '0x2222222222222222222222222222222222222222', binanceChainId: 56 }] };
  return { success: true, data: {} };
};

// 1) "already in progress" 必须被认成 TX_LOCKED，而不是甩一串英文
{
  const calls = [];
  const w = createWallet({ bin: 'fake', run: fakeBaw(calls) });
  let code = null;
  try { await w.send(Tx, 'sell'); } catch (e) { code = e.code; }
  ok(code === 'TX_LOCKED', `already in progress → TX_LOCKED（实际 ${code}）`);
}

// 2) pendingTxs 能读出 tx-history 里挂着的那笔
{
  const calls = [];
  const w = createWallet({ bin: 'fake', run: fakeBaw(calls) });
  const list = await w.pendingTxs();
  ok(list.length === 1 && list[0].hash === '0xold', `读到挂起交易 ${JSON.stringify(list.map(t => t.hash))}`);
  ok(calls[0].includes('--type pending'), '查询用的是 --type pending');
}

// 3) healLock 会取消挂起的那笔
{
  const calls = [];
  const w = { pendingTxs: async () => ([{ hash: '0xold1' }, { hash: '0xold2' }]), cancel: async h => { calls.push(h); return { hash: '0x' + h }; } };
  const n = await healLock(w, { settleMs: 0 });
  ok(n === 2 && calls.join(',') === '0xold1,0xold2', `取消了两笔（${JSON.stringify(calls)}）`);
}

// 4) 完整链路：第一次被锁 → 自动取消 → 重发成功
{
  const calls = [];
  const w = { pendingTxs: async () => ([{ hash: '0xold' }]), cancel: async h => { calls.push('cancel:' + h); return { hash: '0xcc' }; } };
  let tries = 0;
  const fn = async () => {
    tries += 1;
    if (tries === 1) throw Object.assign(new Error('Binance still has a pending transaction'), { code: 'TX_LOCKED' });
    return { hash: '0xnew', tokens: '100' };
  };
  const r = await sendWithHeal(w, (n, f) => f(), '1', fn);
  ok(r.hash === '0xnew' && r.healed === 1, `重发成功且标记 healed（${JSON.stringify(r)}）`);
  ok(calls.length === 1, `取消恰好调一次（${calls.length}）`);
  ok(tries === 2, `只重试一次（调用 ${tries} 次）`);
}

// 5) 不是"卡住"的错误：不许重试，原样报
{
  let tries = 0;
  const fn = async () => { tries += 1; throw Object.assign(new Error('not enough BNB'), { code: 'BAW_ERROR' }); };
  let err = null;
  try { await sendWithHeal({}, (n, f) => f(), '1', fn); } catch (e) { err = e; }
  ok(err && /not enough BNB/.test(err.message) && tries === 1, `其它错误不重试（调用 ${tries} 次）`);
}

// 6) 清完还是被锁：报错里带上 healed，前端才能提示"等 30 秒再点"
{
  const w = { pendingTxs: async () => ([{ hash: '0xold' }]), cancel: async () => ({}) };
  const fn = async () => { throw Object.assign(new Error('still in progress'), { code: 'TX_LOCKED' }); };
  let err = null;
  try { await sendWithHeal(w, (n, f) => f(), '1', fn); } catch (e) { err = e; }
  ok(err && err.healed === 1, `重试失败带 healed 标记（${err && err.healed}）`);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
