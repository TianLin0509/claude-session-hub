'use strict';
// B1（2026-07-29 道雪）单测：全新 Claude 会话的**第 1 轮**就要拿到 transcript blocks。
//
// 回归的 bug：JsonlTail 只在 notifyStop（Stop hook）里创建，而 Stop hook 只在本轮
//   结束时才响 → 首轮全程 _streamingBuf 结构性恒空 → 群聊卡片恒「💭 思考中…」。
//
// 锁定不变量：
//   1. registerSession 只给 cwd（全新会话、transcript 尚不存在）→ 发现期轮询到新
//      jsonl 后自动建 tail，首轮 blocks 直接可读，**完全不调 notifyStop**
//   2. transcript 延迟创建（注册时目录/文件都不存在）不放弃，文件出现后补上
//   3. 注册前就存在的 jsonl 不会被误认（那是别的会话的）
//   4. 同 cwd 同时冒出 2 个新 jsonl（两位 Claude 成员）→ 歧义不猜；
//      UserPromptSubmit hook 给出权威路径后各自绑对
//   5. notifyPrompt / notifyStop / 发现期 三条通道重复到达 → 只有一个 tail，
//      blocks 不翻倍
//   6. registerSession 带 ccSessionId（resume）→ 立刻精确定位并建 tail，
//      且 startAtEnd 生效：历史行不回放进 _streamingBuf
//   7. unregisterSession → tail 关闭，后续 append 不再进 buffer；发现期 timer 停掉
//   8. 不回归：Stop hook → turn-complete emit 链路照常

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeTap } = require('../core/transcript-tap.js');
const { projectSlug } = require('../core/claude-transcript-locator.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n    ${e && e.stack ? e.stack : e}`); }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await wait(40);
  }
}

// 伪造一个 ~/.claude 家目录：<home>/.claude/projects/<slug(cwd)>/<ccSid>.jsonl
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-cwd-'));
  return { home, work };
}
function bucketDir(home, cwd) {
  return path.join(home, '.claude', 'projects', projectSlug(cwd));
}
function assistantLine(blocks, stopReason = null) {
  return JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', stop_reason: stopReason, content: blocks },
  }) + '\n';
}
const THINK = { type: 'thinking', thinking: '先看看目录里有什么' };
const TOOL = { type: 'tool_use', name: 'Write', input: { file_path: 'hello.txt' } };
const TEXT = { type: 'text', text: '已经写好了 hello.txt。' };

function newTap(home) {
  return new ClaudeTap({ homeDir: home, discoveryPollMs: 60 });
}
function cleanup(dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

async function main() {
  console.log('Running ClaudeTap first-turn tail (B1) tests...');

  // -------------------------------------------------------------------------
  await test('1+2 全新会话：注册时 transcript 还不存在，创建后首轮 blocks 就能拿到（不调 notifyStop）', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    const sid = 'hub-b1-fresh';
    try {
      // 注册瞬间：bucket 目录本身都还不存在（全新 cwd 的常态）
      assert.ok(!fs.existsSync(bucketDir(home, work)), 'precondition: bucket 不存在');
      tap.registerSession(sid, { kind: 'claude', cwd: work });
      assert.strictEqual(tap.getStreamingText(sid), null, '还没有 transcript → 无 blocks');

      // CLI 过一会儿才创建 transcript 并开始写第一轮
      await wait(200);
      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'cc-fresh-0001.jsonl');
      fs.writeFileSync(tp, JSON.stringify({ type: 'user', cwd: work, message: { role: 'user' } }) + '\n');
      await wait(150);
      fs.appendFileSync(tp, assistantLine([THINK]));
      fs.appendFileSync(tp, assistantLine([TOOL], 'tool_use'));
      fs.appendFileSync(tp, assistantLine([TEXT], 'end_turn'));

      const blocks = await waitUntil(() => tap.getStreamingText(sid), 5000, 'first-turn blocks');
      assert.ok(Array.isArray(blocks), 'blocks 是数组');
      assert.strictEqual(blocks.length, 3, `期望 3 个 block，实际 ${blocks.length}`);
      assert.deepStrictEqual(blocks.map(b => b.type), ['thinking', 'tool_use', 'text']);
      assert.strictEqual(blocks[1].name, 'Write');

      const snap = tap.getDebugSnapshot().sessions[0];
      assert.strictEqual(snap.tailSource, 'cwd_discovery', 'tail 由发现期建立，不是 Stop hook');
      assert.strictEqual(snap.transcriptPath, tp);
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  // -------------------------------------------------------------------------
  await test('3 注册前就存在的 jsonl 不会被误绑（那是别的会话的）', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    const sid = 'hub-b1-preexisting';
    try {
      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const stale = path.join(dir, 'cc-old-9999.jsonl');
      fs.writeFileSync(stale, JSON.stringify({ type: 'user', cwd: work }) + '\n');

      tap.registerSession(sid, { kind: 'claude', cwd: work });
      // 老文件继续被别人写 —— 不该被本会话吸进来
      await wait(300);
      fs.appendFileSync(stale, assistantLine([{ type: 'text', text: '别的会话的回答' }], 'end_turn'));
      await wait(300);
      assert.strictEqual(tap.getStreamingText(sid), null, '老文件的内容不得进入本会话 buffer');
      assert.strictEqual(tap.getDebugSnapshot().sessions[0].hasTail, false);

      // 本会话自己的新文件出现 → 立刻绑上
      const mine = path.join(dir, 'cc-new-0001.jsonl');
      fs.writeFileSync(mine, assistantLine([TEXT], 'end_turn'));
      const blocks = await waitUntil(() => tap.getStreamingText(sid), 5000, 'own transcript blocks');
      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(tap.getDebugSnapshot().sessions[0].transcriptPath, mine);
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  // -------------------------------------------------------------------------
  await test('4 同 cwd 两位 Claude 成员：歧义期不猜，prompt hook 给权威路径后各绑各的', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    try {
      tap.registerSession('hub-a', { kind: 'claude', cwd: work });
      tap.registerSession('hub-b', { kind: 'claude', cwd: work });

      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const pa = path.join(dir, 'cc-aaa.jsonl');
      const pb = path.join(dir, 'cc-bbb.jsonl');
      fs.writeFileSync(pa, JSON.stringify({ type: 'user', cwd: work }) + '\n');
      fs.writeFileSync(pb, JSON.stringify({ type: 'user', cwd: work }) + '\n');
      await wait(400);

      let snaps = tap.getDebugSnapshot().sessions;
      assert.ok(snaps.every(s => !s.hasTail), '两个候选 → 谁都不绑（宁可晚绑，不能绑错）');

      // UserPromptSubmit hook 带来权威路径
      await tap.notifyPrompt('hub-a', pa, 'cc-aaa');
      await tap.notifyPrompt('hub-b', pb, 'cc-bbb');
      fs.appendFileSync(pa, assistantLine([{ type: 'text', text: 'A 的回答' }], 'end_turn'));
      fs.appendFileSync(pb, assistantLine([{ type: 'text', text: 'B 的回答' }], 'end_turn'));

      const ba = await waitUntil(() => tap.getStreamingText('hub-a'), 5000, 'A blocks');
      const bb = await waitUntil(() => tap.getStreamingText('hub-b'), 5000, 'B blocks');
      assert.strictEqual(ba.length, 1);
      assert.strictEqual(ba[0].text, 'A 的回答');
      assert.strictEqual(bb.length, 1);
      assert.strictEqual(bb[0].text, 'B 的回答');
      snaps = tap.getDebugSnapshot().sessions;
      assert.ok(snaps.every(s => s.tailSource === 'prompt_hook'));
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  // -------------------------------------------------------------------------
  await test('5 三条通道重复到达 → 只建一个 tail，blocks 不翻倍', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    const sid = 'hub-b1-once';
    try {
      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'cc-once.jsonl');

      tap.registerSession(sid, { kind: 'claude', cwd: work });
      fs.writeFileSync(tp, '');   // 注册之后 CLI 才创建 → 发现期认得出是本会话的
      await waitUntil(() => tap.getDebugSnapshot().sessions[0].hasTail, 3000, 'discovery tail');
      const firstTail = tap._bound.get(sid)._tail;

      // 同一路径反复喂：prompt hook ×2、stop hook ×2、再 register 一次
      await tap.notifyPrompt(sid, tp, 'cc-once');
      await tap.notifyPrompt(sid, tp, 'cc-once');
      tap.registerSession(sid, { kind: 'claude', cwd: work, transcriptPath: tp });
      await tap.notifyStop(sid, tp);
      await tap.notifyStop(sid, tp);
      assert.strictEqual(tap._bound.get(sid)._tail, firstTail, 'tail 实例没有被换掉');

      fs.appendFileSync(tp, assistantLine([{ type: 'text', text: '只应出现一次' }], 'end_turn'));
      await wait(600);
      const blocks = tap.getStreamingText(sid) || [];
      assert.strictEqual(blocks.length, 1, `重复建 tail 会导致 blocks 翻倍，实际 ${blocks.length}`);
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  // -------------------------------------------------------------------------
  await test('6 resume（已知 ccSessionId）→ 注册即建 tail，且不回放历史行', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    const sid = 'hub-b1-resume';
    try {
      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'cc-resume-1.jsonl');
      fs.writeFileSync(tp,
        assistantLine([{ type: 'text', text: '上一轮的老回答' }], 'end_turn'));

      tap.registerSession(sid, { kind: 'claude', cwd: work, ccSessionId: 'cc-resume-1' });
      await waitUntil(() => tap.getDebugSnapshot().sessions[0].hasTail, 3000, 'resume tail');
      const snap = tap.getDebugSnapshot().sessions[0];
      assert.strictEqual(snap.tailSource, 'register');
      assert.strictEqual(snap.transcriptPath, tp);
      await wait(300);
      assert.strictEqual(tap.getStreamingText(sid), null, '历史行不得回放进 _streamingBuf');

      fs.appendFileSync(tp, assistantLine([{ type: 'text', text: '本轮新回答' }], 'end_turn'));
      const blocks = await waitUntil(() => tap.getStreamingText(sid), 5000, 'resume new blocks');
      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(blocks[0].text, '本轮新回答');
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  // -------------------------------------------------------------------------
  await test('7 unregisterSession → tail 关闭、发现期 timer 停掉，无 fd/interval 泄漏', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    const sid = 'hub-b1-close';
    try {
      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'cc-close.jsonl');
      tap.registerSession(sid, { kind: 'claude', cwd: work });
      fs.writeFileSync(tp, '');
      await waitUntil(() => tap.getDebugSnapshot().sessions[0].hasTail, 3000, 'tail up');
      const tail = tap._bound.get(sid)._tail;

      tap.unregisterSession(sid);
      assert.strictEqual(tail._closed, true, 'JsonlTail.close() 被调用');
      assert.strictEqual(tail._pollTimer, null, '轮询 interval 已清');
      assert.strictEqual(tap._claimedPaths.size, 0, '文件认领已释放');
      assert.strictEqual(tap._discoveryTimer, null, '发现期 timer 已停');

      fs.appendFileSync(tp, assistantLine([{ type: 'text', text: '关闭后写入' }], 'end_turn'));
      await wait(400);
      assert.strictEqual(tap.getStreamingText(sid), null, '关闭后不再累积');

      // 只发现、从未绑上的会话也要能把 timer 收干净
      tap.registerSession('hub-never-bound', { kind: 'claude', cwd: path.join(work, 'nope') });
      assert.ok(tap._discoveryTimer, 'pending 会话 → timer 起来');
      tap.unregisterSession('hub-never-bound');
      assert.strictEqual(tap._discoveryTimer, null, 'pending 清空 → timer 停');
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  // -------------------------------------------------------------------------
  await test('8 不回归：Stop hook 仍然触发 turn-complete（signalSource=stop_hook）', async () => {
    const { home, work } = makeHome();
    const tap = newTap(home);
    const sid = 'hub-b1-stop';
    try {
      const dir = bucketDir(home, work);
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'cc-stop.jsonl');
      fs.writeFileSync(tp, '');
      const events = [];
      tap.on('turn-complete', ev => events.push(ev));

      tap.registerSession(sid, { kind: 'claude', cwd: work });
      await tap.notifyPrompt(sid, tp, 'cc-stop');
      fs.appendFileSync(tp,
        JSON.stringify({ type: 'user', cwd: work, message: { role: 'user', content: '问题' } }) + '\n');
      fs.appendFileSync(tp, assistantLine([TEXT], 'end_turn'));
      await waitUntil(() => tap.getStreamingText(sid), 5000, 'blocks before stop hook');

      await tap.notifyStop(sid, tp);
      const ev = await waitUntil(() => events.find(e => e.signalSource === 'stop_hook'), 3000, 'stop_hook emit');
      assert.strictEqual(ev.hubSessionId, sid);
      assert.ok(ev.text && ev.text.includes('hello.txt'), `emit 文本异常：${ev.text}`);
      assert.strictEqual(ev.modelId, 'claude-opus-5', 'T13 model 仍随 emit 附带');
    } finally { tap.dispose(); cleanup([home, work]); }
  });

  if (failures) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log('All ClaudeTap first-turn tail (B1) tests passed.');
}

main().catch(e => { console.error(e); process.exit(1); });
