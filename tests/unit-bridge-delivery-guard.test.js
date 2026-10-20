'use strict';
// 回执送进会话的兜底（2026-10-18，家里 v1.6.517 真机 Q-1018-07：回执里的制表符被 Claude 换成空格，发送入口报
// content-mismatch（ok:false，不带 unconfirmed / stuck），家里当成「没发进去」每分钟重投，会话里收到 6 份）。
// core/company-bridge/delivery-guard.js；家里收公司回执（home.js）与公司收家里回复（ask-home.js）共用。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, pair } = require('./helpers/company-bridge-rig');
const guard = require('../core/company-bridge/delivery-guard');

const MIN = 60000;
// 真 Claude Code 复现的回执原样（tests/e2e-bridge-delivery-tabs-real.js）。
const MISMATCH = { ok: false, kind: 'codeagent', sendStatus: 'content-mismatch', mode: 'closed-loop', enterAttempts: 1, acknowledgementSource: 'claude-user-prompt-submit' };
const FAILED = { ok: false, error: 'send-failed' };

// 家里：一条已回执、还没送进会话的线程（第 1 轮）。
function homeThread(r, { id = 'Q-1018-07', rounds = null } = {}) {
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  return r.home.saveThread({ id, sessionId: 'home-s', title: 'PF 对齐', gen: r.home.link.gen(), createdAt: r.clock.now,
    rounds: rounds || [{ round: 1, question: '问', sentAt: r.clock.now, status: 'replied', reply: '第一列\t第二列\n1\t2', replyAt: r.clock.now, delivered: false }] });
}
function sendWith(r, side, replies) {
  const calls = [];
  const deps = side === 'home' ? r.home.deps : r.company.deps;
  deps.sendPrompt = async (id, text) => { calls.push({ id, text }); const x = replies[Math.min(calls.length - 1, replies.length - 1)]; return typeof x === 'function' ? x() : x; };
  return calls;
}

test('发送入口报「只差空白」（content-mismatch）：按已送达处理、标有出入，不再重投', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r);
  const calls = sendWith(r, 'home', [MISMATCH]);
  await r.home.deliver();
  let round = r.home.thread(th.id).rounds[0];
  assert.equal(round.delivered, true); assert.equal(round.deliveryError, null);
  assert.match(round.deliveryNote, /内容已进会话（和原文只差空白字符/);
  for (let i = 0; i < 3; i++) { r.clock.now += 2 * MIN; await r.home.deliver(); }
  assert.equal(calls.length, 1, '只投了一次');
  assert.equal(guard.explicitFailure(MISMATCH), false);
  assert.equal(guard.explicitFailure({ ...MISMATCH, notSent: true }), true, '明确没发的仍算失败');
});

test('明确失败最多重投 3 次，之后停止，标「可能已送达，未能确认」', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r);
  const calls = sendWith(r, 'home', [FAILED]);
  for (let i = 0; i < 6; i++) { await r.home.deliver(); r.clock.now += 61000; }
  assert.equal(calls.length, 3);
  const round = r.home.thread(th.id).rounds[0];
  assert.equal(round.delivered, true); assert.equal(round.deliveryUnconfirmed, true); assert.equal(round.deliveryFailures, 3);
  assert.match(round.deliveryError, /^可能已送达，未能确认（发送入口连续 3 次报没发进去：send-failed）；停止自动重投/);
  assert.equal(r.home.thread(th.id).state, 'replied');
  assert.equal(r.home.openThreads().length, 0, '不再跟进');
  // 「公司联动」列表里显示出来
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-link-home.js'), 'utf8');
  assert.match(html, /r\.deliveryError \? ' · <span class="bad">'/);
});

test('重投前查原生记录：会话里已有这条回执（用户消息里有编号和轮次标记）就直接标已送达，不再发', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r);
  const calls = sendWith(r, 'home', [FAILED]);
  await r.home.deliver(); // 第一次报失败
  assert.equal(calls.length, 1);
  // 实际上内容进去了：原生记录里有一条用户消息带着「【公司回执 Q-1018-07 · 第 1 轮】」
  const file = path.join(r.root, 'claude.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我会等【公司回执 Q-1018-07 · 第 1 轮】到了再说' }] } }),
    ''].join('\n'));
  r.hs.map.get('home-s').transcriptPath = file;
  r.clock.now += 61000; await r.home.deliver();
  assert.equal(calls.length, 2, 'Agent 自己的回答里引用标记不算已送达');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: '【公司回执 Q-1018-07 · 第 1 轮】\n\n第一列  第二列' } }) + '\n');
  r.clock.now += 61000; await r.home.deliver();
  assert.equal(calls.length, 2, '原生记录里有了就不再投');
  const round = r.home.thread(th.id).rounds[0];
  assert.equal(round.delivered, true); assert.match(round.deliveryNote, /原生记录里已有这条回执/); assert.equal(round.deliveryError, null);
  // Codex 的 rollout（"role":"user"）同样认
  const rollout = path.join(r.root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '【公司回执 Q-1/02 · 第 2 轮】x' }] } }) + '\n');
  assert.equal(guard.transcriptHasText({ transcriptPath: rollout }, '【公司回执 Q-1/02 · 第 2 轮'), true);
  assert.equal(guard.transcriptHasText({}, 'x'), null, '没有记录可查不下结论');
});

test('同一线程已从这个会话发出更晚的一轮：更早的轮次直接标已送达', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r, { rounds: [
    { round: 1, question: '问', sentAt: r.clock.now, status: 'replied', reply: '答 1', replyAt: r.clock.now, delivered: false, deliveryError: '没有发进会话', nextTryAt: null },
    { round: 2, question: '追问', sentAt: r.clock.now + 1000, status: 'sent' }] });
  const calls = sendWith(r, 'home', [FAILED]);
  await r.home.deliver();
  assert.equal(calls.length, 0);
  const round = r.home.thread(th.id).rounds[0];
  assert.equal(round.delivered, true); assert.match(round.deliveryNote, /已经就同一编号发出了第 2 轮/);
});

test('公司一端：家里回复送进 CodeAgent 会话同样兜底（只差空白按已送达、明确失败最多 3 次、已发更晚一轮不再投）', async t => {
  const r = rig(t); await pair(r);
  r.cs.map.set('c1', { id: 'c1', kind: 'codeagent', status: 'idle' });
  const save = (id, rounds) => r.company.askHome.saveThread({ id, sessionId: 'c1', title: '求助', gen: r.company.link.gen(), createdAt: r.clock.now, rounds });
  const replied = { round: 1, question: '问', sentAt: r.clock.now, status: 'replied', reply: 'a\tb', replyAt: r.clock.now, delivered: false };
  save('H-1018-01', [replied]);
  let calls = sendWith(r, 'company', [MISMATCH]);
  await r.company.askHome.deliver();
  assert.equal(r.company.askHome.thread('H-1018-01').rounds[0].delivered, true);
  assert.match(r.company.askHome.thread('H-1018-01').rounds[0].deliveryNote, /内容已进会话/);
  assert.equal(calls.length, 1);
  save('H-1018-02', [replied]);
  calls = sendWith(r, 'company', [FAILED]);
  for (let i = 0; i < 6; i++) { await r.company.askHome.deliver(); r.clock.now += 61000; }
  assert.equal(calls.length, 3);
  assert.match(r.company.askHome.thread('H-1018-02').rounds[0].deliveryError, /可能已送达，未能确认/);
  save('H-1018-03', [replied, { round: 2, question: '追问', sentAt: r.clock.now + 1000, status: 'sent' }]);
  calls = sendWith(r, 'company', [FAILED]);
  await r.company.askHome.deliver();
  assert.equal(calls.length, 0);
  assert.equal(r.company.askHome.thread('H-1018-03').rounds[0].delivered, true);
});

// ---- 复审 2026-10-18 ----
test('【阻断】同一轮先投过「没答上」，之后补收 / 重试出真回答：标记按第一行全文核对，真回答照常投进去，上一份的投递状态不带过来', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r, { rounds: [{ round: 1, question: '问', sentAt: r.clock.now, status: 'error', error: '会话停下了，但一直没读到回答', errorAt: r.clock.now,
    delivered: true, deliveredAt: r.clock.now, deliveryFailures: 2, deliveryNote: '旧的', deliveryUnconfirmed: null }] });
  const file = path.join(r.root, 'claude.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: '【公司回执 Q-1018-07 · 第 1 轮 · 没答上】\n\n会话停下了' } }) + '\n');
  r.hs.map.get('home-s').transcriptPath = file;
  // 真回答到了（补收取回）
  await r.home.receive({ type: 'reply', thread: th.id, gen: th.gen, round: 1, text: '真正的回答：PF 权重每 TTI 更新', mid: 'm-real' });
  let round = r.home.thread(th.id).rounds[0];
  assert.equal(round.delivered, false);
  for (const k of ['deliveryFailures', 'deliveryRetries']) assert.equal(round[k], 0, k + ' 清零');
  for (const k of ['deliveryNote', 'deliveryUnconfirmed', 'deliveryError', 'nextTryAt']) assert.equal(round[k], null, k + ' 清掉');
  const calls = sendWith(r, 'home', [{ ok: true }]);
  r.clock.now += 1000; await r.home.deliver();
  assert.equal(calls.length, 1, '真回答投进去了，没被旧的「没答上」挡住');
  assert.match(calls[0].text, /^【公司回执 Q-1018-07 · 第 1 轮(?: · 题：[^】]*)?】\n\n真正的回答/);
  assert.equal(r.home.thread(th.id).rounds[0].delivered, true);
  // 原生记录里有了真回执之后，再核对就认得出
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: calls[0].text } }) + '\n');
  assert.equal(guard.transcriptHasText({ transcriptPath: file }, '【公司回执 Q-1018-07 · 第 1 轮】'), true);
  assert.equal(guard.transcriptHasText({ transcriptPath: file }, '【公司回执 Q-1018-07 · 第 2 轮】'), false);
});

test('明确没发（notSent）不计入 3 次上限，按 1→2→5→10 分钟退避一直重试；就绪后照常投递', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r);
  let ready = false;
  const calls = sendWith(r, 'home', [() => (ready ? { ok: true } : { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready' })]);
  const gaps = [];
  for (let i = 0; i < 6; i++) {
    await r.home.deliver();
    const round = r.home.thread(th.id).rounds[0];
    assert.equal(round.delivered, false); assert.ok(!round.deliveryUnconfirmed);
    gaps.push(round.nextTryAt - r.clock.now);
    r.clock.now = round.nextTryAt;
  }
  assert.deepEqual(gaps, [1, 2, 5, 10, 10, 10].map(m => m * MIN));
  assert.equal(calls.length, 6);
  ready = true; await r.home.deliver();
  assert.equal(r.home.thread(th.id).rounds[0].delivered, true);
});

test('「可能已送达，未能确认」的轮次：补收就在本机重新投一次（手动重投的出口）', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r);
  sendWith(r, 'home', [FAILED]);
  for (let i = 0; i < 3; i++) { await r.home.deliver(); r.clock.now += 61000; }
  assert.equal(r.home.thread(th.id).rounds[0].deliveryUnconfirmed, true);
  const before = r.relay.posts;
  const res = await r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s', arguments: { thread: th.id } });
  assert.equal(res.status, '已重新投递'); assert.equal(r.relay.posts, before, '不用麻烦公司');
  const calls = sendWith(r, 'home', [{ ok: true }]);
  await r.home.deliver();
  assert.equal(calls.length, 1);
  assert.equal(r.home.thread(th.id).rounds[0].delivered, true);
});

test('更晚一轮早于这一轮的回执发出（补收晚到的回答）：照常投递', async t => {
  const r = rig(t); await pair(r);
  const th = homeThread(r, { rounds: [
    { round: 1, question: '问', sentAt: r.clock.now, status: 'replied', reply: '补收取回的回答', replyAt: r.clock.now + 5 * MIN, delivered: false },
    { round: 2, question: '追问', sentAt: r.clock.now + MIN, status: 'sent' }] });
  const calls = sendWith(r, 'home', [{ ok: true }]);
  await r.home.deliver();
  assert.equal(calls.length, 1);
  assert.equal(r.home.thread(th.id).rounds[0].delivered, true);
  assert.ok(!r.home.thread(th.id).rounds[0].deliveryNote);
});

test('原生后端的 content-mismatch 不当作「内容已进会话」', () => {
  assert.equal(guard.contentArrivedWithDiff(MISMATCH), true);
  assert.equal(guard.contentArrivedWithDiff({ ...MISMATCH, source: 'claude-stream-json' }), false);
  assert.equal(guard.contentArrivedWithDiff({ ...MISMATCH, acknowledgementSource: 'claude-stream-json' }), false);
  assert.equal(guard.contentArrivedWithDiff({ ok: false, sendStatus: 'content-mismatch' }), false, '不是 PTY 提交闭环的回执不信');
  assert.equal(guard.explicitFailure({ ...MISMATCH, source: 'claude-stream-json' }), true);
});

test('公司一端：家里回复先投过「没答上」、之后真回复到达，照常投进 CodeAgent 会话', async t => {
  const r = rig(t); await pair(r);
  r.cs.map.set('c1', { id: 'c1', kind: 'codeagent', status: 'idle' });
  const file = path.join(r.root, 'ca.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: '【家里回复 H-1018-05 · 第 1 轮 · 没答上】\n\n家里没答上' } }) + '\n');
  r.cs.map.get('c1').transcriptPath = file;
  const th = r.company.askHome.saveThread({ id: 'H-1018-05', sessionId: 'c1', title: '求助', gen: r.company.link.gen(), createdAt: r.clock.now,
    rounds: [{ round: 1, question: '问', sentAt: r.clock.now, status: 'error', error: '家里没答上', errorAt: r.clock.now, delivered: true, deliveryFailures: 1 }] });
  r.company.askHome.receive({ type: 'home-reply', thread: th.id, gen: th.gen, round: 1, text: '家里的真回复', mid: 'm1', meta: { agent: 'claude' } });
  const round = r.company.askHome.thread(th.id).rounds[0];
  assert.equal(round.delivered, false); assert.equal(round.deliveryFailures, 0);
  const calls = sendWith(r, 'company', [{ ok: true }]);
  await r.company.askHome.deliver();
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^【家里回复 H-1018-05 · 第 1 轮 · Claude】/);
});
