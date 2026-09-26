'use strict';
// 2026-09-26 用户截图：Claude（PTY）卡片里「进展显示在结果的下方」。
// 隔离 Hub + 真实 Claude CLI（CLAUDE_PROXY 指向不可达端口，不调用模型）打开一条合成的
// 长回合记录，核对三种路径下卡片没有重复、顺序与投影一致、结果在本轮所有进展之后：
//   open  打开会话（CLI 恢复时的终端输出会触发实时刷新，与全量加载并发）+ 一次强制刷新
//   page  反复「加载更早对话」直到读完
//   live  逐段追加落盘，每段后触发实时刷新
// 用法：node tests/e2e-claude-pty-card-order-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { claudeLongTurnTranscript } = require('./fixtures/claude-long-turn-transcript');
const { parseClaudeTranscriptToNativeTurns } = require('../core/claude-disk-transcript');
const { displayTurns } = require('../core/conversation-display');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function scenario(mode, root, report) {
  const base = path.join(root, mode), data = path.join(base, 'data'), claudeDir = path.join(base, 'claude'), cwd = path.join(base, 'work');
  const sid = crypto.randomUUID(), slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const tdir = path.join(claudeDir, 'projects', slug);
  for (const d of [data, cwd, tdir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  const file = path.join(tdir, sid + '.jsonl');
  const lines = claudeLongTurnTranscript({ sessionId: sid, cwd }).trim().split('\n');
  const longTurnAt = lines.findIndex(l => l.includes('LONG_TURN_QUESTION'));
  let cursor = mode === 'live' ? longTurnAt + 1 : lines.length;
  fs.writeFileSync(file, lines.slice(0, cursor).join('\n') + '\n');
  const hubId = 'order-' + mode + '-' + Date.now(), now = Date.now();
  fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {}, sessions: [{
    hubId, title: 'card order ' + mode, kind: 'claude', cwd, ccSessionId: sid, transcriptPath: file, currentModel: { id: 'claude-haiku-4-5-20251001' },
    lastMessageTime: now, updatedAt: now, savedAt: now, schemaVersion: 1 }] }));
  const hub = await launchIsolatedHub({ dataDir: data, port: await port(), windowMode: 'hidden', label: 'card-order-' + mode, extraEnv: {
    CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_HUB_HOME_DIR: path.join(base, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_PROXY: 'http://127.0.0.1:9', CLAUDE_HUB_AGENT_RUNTIME: 'pty' } });
  const c = await connectFirstPage(hub);
  const r = report[mode] = { checks: [] };
  const until = async (expr, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(150); } throw Error(`timeout ${what} (${mode})`); };
  const idle = `(()=>{const s=window._cardReloadState?.get(${j(hubId)});return !window._cardFullLoadBySid?.has(${j(hubId)}) && (!s || (!s.inProgress && !s.pendingTimer && !s.queued));})()`;
  const dom = () => c.eval(`[...document.querySelectorAll('#msg-overlay > .turn-card')].map(e=>e.dataset.turnId)`);
  const verify = async (label, { complete = false } = {}) => {
    await sleep(600); await until(idle, 'idle ' + label);
    const ids = await dom();
    const expected = displayTurns(parseClaudeTranscriptToNativeTurns(file, {})).map(t => t.id);
    const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dups.length) throw Error(`${label}: duplicate cards ${j(dups.slice(0, 3))}`);
    const pos = ids.map(id => expected.indexOf(id));
    if (pos.some(p => p < 0)) throw Error(`${label}: card not in projection ${ids[pos.indexOf(-1)]}`);
    const bad = pos.findIndex((p, i) => i > 0 && p < pos[i - 1]);
    if (bad > 0) throw Error(`${label}: order broken at ${bad}: ${ids[bad - 1]} before ${ids[bad]}\n${ids.join('\n')}`);
    if (complete && ids.length !== expected.length) throw Error(`${label}: ${ids.length}/${expected.length} cards`);
    r.checks.push(`${label}: ${ids.length} cards, no duplicates, projection order`);
    return ids;
  };
  try {
    await until(`typeof sessions!=="undefined" && !!document.querySelector('.session-item[data-session-id="${hubId}"]')`, 'row');
    await c.eval(`document.querySelector('.session-item[data-session-id="${hubId}"]').click()`);
    await until(`activeSessionId===${j(hubId)}`, 'active');
    await c.eval(`applyViewMode('card')`);
    await until(`currentView==='card' && document.querySelectorAll('#msg-overlay > .turn-card').length>0`, 'cards');
    // 等 PTY 里的 CLI 起来并产生终端输出（生产里触发并发刷新的就是它）。
    await until(`(sessions.get(${j(hubId)})?.status||'')!=='dormant'`, 'pty started');
    await sleep(3000);
    await verify('opened');
    if (mode === 'open') {
      await c.eval(`requestCardIncrementalRefresh(${j(hubId)},{force:true,reason:'e2e'})`);
      const ids = await verify('after live refresh');
      const text = await c.eval(`[...document.querySelectorAll('#msg-overlay > .turn-card')].map(e=>e.innerText).join('\\n')`);
      if (text.lastIndexOf('PROGRESS_') > text.indexOf('FINAL_RESULT')) throw Error('a progress card is rendered below the final result');
      r.checks.push(`result is below every visible progress card (${ids.length} cards)`);
    }
    if (mode === 'page') {
      for (let k = 0; k < 10; k++) {
        if (!await c.eval(`!!document.querySelector('#msg-overlay > .card-history-more:not([disabled])')`)) break;
        await c.eval(`document.querySelector('#msg-overlay > .card-history-more').click()`);
        await sleep(300); await until(`!document.querySelector('#msg-overlay > .card-history-more[disabled]')`, 'older page');
        await verify('older page ' + (k + 1));
      }
      await verify('all pages', { complete: true });
    }
    if (mode === 'live') {
      while (cursor < lines.length) {
        fs.appendFileSync(file, lines.slice(cursor, cursor + 7).join('\n') + '\n'); cursor += 7;
        await c.eval(`requestCardIncrementalRefresh(${j(hubId)},{force:true,reason:'e2e-live'})`);
        await verify('live @' + cursor);
      }
    }
  } finally {
    if (r.checks.length < 2) try { fs.writeFileSync(path.join(report.out, mode + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch {}
    await c.close().catch(() => {});
    await gracefulQuit(hub, { timeoutMs: 60000 }).catch(e => { r.quit = String(e); });
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-card-order-'));
  const out = path.resolve('artifacts/claude-pty-card-order/' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { root, out, passed: false };
  try {
    for (const mode of ['open', 'page', 'live']) await scenario(mode, root, report);
    report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})();
