'use strict';
// Native-format fixture, real isolated background UI; no provider/cloud calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-history-'));
const data = path.join(root, 'data'), cwd = path.join(root, 'work');
const out = path.resolve('artifacts/20261022-antigravity-history-codex-' + Date.now());
for (const dir of [data, cwd, out]) fs.mkdirSync(dir, { recursive: true });
const fixtures = [12, 2].map((rounds, n) => {
  const nativeId = randomUUID(), hubId = 'agy-history-' + n;
  const file = path.join(root, '.gemini', 'antigravity-cli', 'brain', nativeId, '.system_generated', 'logs', 'transcript_full.jsonl');
  const rows = [];
  function add(type, content, extra = {}) {
    rows.push({ step_index: rows.length, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
      type, status: 'DONE', created_at: new Date(1700000000000 + rows.length * 1000).toISOString(), content, ...extra });
  }
  for (let r = 0; r < rounds; r++) {
    add('USER_INPUT', `<USER_REQUEST>QUESTION_${n}_${r}</USER_REQUEST>`);
    for (let step = 0; step < 45; step++) {
      add('PLANNER_RESPONSE', step % 10 === 0 ? `PROGRESS_${n}_${r}_${step}` : '',
        { tool_calls: [{ name: 'read_file', args: { path: `fixture-${r}-${step}.txt` } }], thinking: step === 0 ? 'Reasoning fixture' : '' });
      add('GENERIC', `Created At: fixture\nCompleted At: fixture\nTOOL_OUTPUT_ONLY_${n}_${r}_${step}`);
    }
    add('PLANNER_RESPONSE', `ANSWER_${n}_${r}\n\n` + '完整回答段落，保留 Markdown 和本轮结论。\n\n'.repeat(100));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(j).join('\n') + '\n');
  return { hubId, title: 'Antigravity history fixture ' + n, kind: 'gemini', cwd,
    geminiProjectHash: 'antigravity', geminiChatId: nativeId, transcriptPath: file,
    savedAt: Date.now(), schemaVersion: 1, rounds };
});
fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, cleanShutdown: true, meetings: [], sessions: fixtures }));
(async () => {
  let hub, cdp; const result = { fixture: '12 rounds, 92 native steps per round; isolated UI; no cloud calls', passed: false, out };
  try {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port }); cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    async function until(expr) {
      const end = Date.now() + 45000;
      while (!await cdp.eval(expr)) { if (Date.now() > end) throw Error('Timed out: ' + expr); await sleep(100); }
    }
    async function select(id) {
      await until(`!!document.querySelector('.session-item[data-session-id="${id}"]')`);
      await sleep(550);
      await cdp.eval(`document.querySelector('.session-item[data-session-id="${id}"]').click()`);
      await until(`activeSessionId===${j(id)}`);
      await cdp.eval(`applyViewMode('card')`);
      await until(`cardHistoryViews.ready(sessions.get(${j(id)})) && document.querySelectorAll('#msg-overlay>.turn-card').length>0`);
    }
    const count = () => cdp.eval(`document.querySelectorAll('#msg-overlay>.turn-card').length`);
    const ids = () => cdp.eval(`[...document.querySelectorAll('#msg-overlay>.turn-card')].map(e=>e.dataset.turnId)`);
    await select(fixtures[0].hubId);
    assert.equal(await count(), 8, 'initial page contains eight complete cards');
    assert.equal(await cdp.eval(`[...document.querySelectorAll('#msg-overlay .turn-body')].some(e=>e.textContent.includes('TOOL_OUTPUT_ONLY'))`), false);
    assert(await cdp.eval(`!!document.querySelector('#msg-overlay details.chat-process')`), 'process available');
    assert.equal(await cdp.eval(`document.querySelector('#msg-overlay details.chat-process').open`), false);
    await cdp.eval(`document.querySelector('#msg-overlay details.chat-process>summary').click()`);
    assert.equal(await cdp.eval(`document.querySelector('#msg-overlay details.chat-process').open`), true);
    await until(`!!document.querySelector('#msg-overlay .turn-body.folded, #msg-overlay .conversation-long-message:not([open])')`);
    const initial = await ids();
    await cdp.eval(`document.querySelector('#msg-overlay>.card-history-more').click()`);
    await until(`!cardHistoryPager.get(${j(fixtures[0].hubId)}).busy && document.querySelectorAll('#msg-overlay>.turn-card').length===24`);
    const all = await ids(); assert.equal(new Set(all).size, 24, 'no duplicate last-answer cards');
    assert(initial.every(id => all.includes(id)), 'pagination preserves existing identities');
    assert(await cdp.eval(`document.querySelector('#msg-overlay').textContent.includes('QUESTION_0_0')`));
    assert(await cdp.eval(`document.querySelector('#msg-overlay').textContent.includes('ANSWER_0_11')`));
    assert.equal(await cdp.eval(`!!document.querySelector('#msg-overlay>.card-history-more')`), false);
    await cdp.eval(`loadSessionHistoryToOverlay(activeSessionId,{incremental:true})`);
    assert.deepEqual(await ids(), all, 'refresh preserves identities and order');
    await select(fixtures[1].hubId); assert.equal(await count(), 4);
    await select(fixtures[0].hubId); assert.deepEqual(await ids(), all, 'session switching preserves loaded history');
    assert.equal(await cdp.eval(`!!document.querySelector('#msg-overlay>.card-history-more')`), false,
      'returning to a fully loaded session must not resurrect an older-history button');
    // Tail updates still append new replies without discarding the loaded past.
    const nextStep = fixtures[0].rounds * 92;
    fs.appendFileSync(fixtures[0].transcriptPath, [
      { step_index: nextStep, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: new Date().toISOString(), content: '<USER_REQUEST>NEW_QUESTION</USER_REQUEST>' },
      { step_index: nextStep + 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: new Date().toISOString(), content: 'NEW_ANSWER' },
    ].map(j).join('\n') + '\n');
    await cdp.eval(`loadSessionHistoryToOverlay(activeSessionId,{incremental:true})`);
    const updated = await ids(); assert.equal(updated.length, 26);
    assert.deepEqual(updated.slice(0, 24), all, 'live tail preserves every loaded historical card');
    assert.equal(new Set(updated).size, 26);
    assert(await cdp.eval(`document.querySelector('#msg-overlay').textContent.includes('NEW_ANSWER')`));
    fs.writeFileSync(path.join(out, '20261022-antigravity-history-codex.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    Object.assign(result, { passed: true, initialCards: initial.length, completeCards: all.length, uniqueCards: new Set(all).size, afterTailUpdate: updated.length });
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    if (hub) fs.writeFileSync(path.join(out, '20261022-antigravity-history-codex.log'), hub.log().join('\n'));
    if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261022-antigravity-history-codex.json'), j(result)); console.log(j(result));
  }
})();
