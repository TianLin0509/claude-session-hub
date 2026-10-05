'use strict';
// Isolated background Electron with synthetic Claude disk entries. Restore
// uses the local CLI with an unreachable proxy, without sending an AI prompt.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-visible-replies-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'), claude = path.join(root, 'claude');
const native = randomUUID(), sid = 'visible-replies-' + Date.now(), now = Date.now();
const dir = path.join(claude, 'projects', path.resolve(work).replace(/[^A-Za-z0-9]/g, '-'));
for (const d of [data, work, dir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
const file = path.join(dir, native + '.jsonl');
const answer = '完整说明：账号、额度和后台流程。\n\n' +
  '这段说明是已经交付的正式答复，后续后台任务继续执行也应该保留在消息正文。工具调用与思考可以放在过程里，正式说明不应该随着新进展变成过程。\n\n'.repeat(18) + '说明结尾：原始回复完整保留。';
const later = '后续结论：后台检查已经通过。';
const explanation = '关键说明：这是工具执行前给用户的正文，不应该收进过程。';
function row(type, id, text, second, extra = {}) {
  return { type, uuid: id, sessionId: native, timestamp: new Date(now - 60000 + second * 1000).toISOString(),
    message: { role: type, content: type === 'assistant' ? [{ type: 'text', text }] : text,
      ...(type === 'assistant' ? { id, model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn' } : {}) }, ...extra };
}
const first = [row('user', 'question', '请解释账号、额度和后台流程', 0),
  row('assistant', 'explanation', explanation, 0.5, { message: { role: 'assistant', id: 'explanation',
    stop_reason: 'tool_use', content: [{ type: 'text', text: explanation }] } }),
  row('assistant', 'initial-answer', answer, 1)];
fs.writeFileSync(file, first.map(JSON.stringify).join('\n') + '\n');
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, meetings: [],
  immersiveByMeeting: {}, sessions: [{ hubId: sid, title: '完整答复与后续后台进度', kind: 'claude', cwd: work,
    ccSessionId: native, transcriptPath: file, currentModel: { id: 'claude-haiku-4-5-20251001' },
    lastMessageTime: now, savedAt: now, schemaVersion: 1 }] }));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ providers: { codex: {
  subscription_profiles: ['default', 'second'].map(id => ({ id, label: id, home: path.join(root, 'codex-' + id) }))
} } }));
const out = path.resolve('artifacts', '20261004-claude-visible-replies-codex1-' + Date.now());
fs.mkdirSync(out, { recursive: true });
(async () => {
  let hub, client;
  const evidence = { boundary: 'Isolated real Electron UI; synthetic disk records; no cloud AI request.', checks: [] };
  try {
    const port = await new Promise(resolve => {
      const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
        const p = server.address().port; server.close(() => resolve(p));
      });
    });
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'background', label: 'claude-visible-replies',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claude, CLAUDE_HUB_AGENT_RUNTIME: 'pty',
        CLAUDE_PROXY: 'http://127.0.0.1:9' } });
    client = await connectFirstPage(hub, t => t.type === 'page' && t.url.includes('index.html'));
    async function until(expression, label) {
      const end = Date.now() + 40000;
      while (!await client.eval(`Boolean(${expression})`)) {
        if (Date.now() > end) throw Error('timeout: ' + label);
        await sleep(100);
      }
    }
    async function click(selector) {
      const point = await client.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased'])
        await client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until(`!!document.querySelector('[data-session-id="${sid}"]')`, 'session row');
    await click(`[data-session-id="${sid}"]`);
    await until(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-message-bubble')?.textContent.includes('完整说明：')`, 'initial answer');
    await client.eval(`window.__replyAnchor=document.querySelector('#msg-overlay>.turn-card.assistant')`);
    const snapshot = () => client.eval(`(()=>{const card=document.querySelector('#msg-overlay>.turn-card.assistant');return {
      count:document.querySelectorAll('#msg-overlay>.turn-card.assistant').length,
      id:card.dataset.turnId,sameNode:card===window.__replyAnchor,
      text:card.querySelector('.chat-message-bubble').textContent,
      process:card.querySelector('.chat-process')?.textContent||'',
      processOpen:card.querySelector('.chat-process')?.open||false};})()`);
    const initial = await snapshot(); assert.equal(initial.count, 1); assert(initial.text.includes('说明结尾：'));
    assert(initial.text.includes(explanation)); assert(!initial.process.includes(explanation));
    assert.equal(await client.eval(`document.querySelectorAll('[data-conversation-filter]').length`), 0);
    evidence.checks.push('foreground explanation preceding a tool stays in the main message; redundant header filter is removed');
    fs.appendFileSync(file, [row('user', 'notification', '<task-notification>finished</task-notification>', 2,
      { origin: { kind: 'task-notification' } }), row('assistant', 'progress', '继续检查工具回执。', 3,
      { message: { role: 'assistant', id: 'progress', stop_reason: 'tool_use', content: [
        { type: 'text', text: '继续检查工具回执。' },
        { type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'check' } }] } })].map(JSON.stringify).join('\n') + '\n');
    await client.eval(`requestCardIncrementalRefresh(${JSON.stringify(sid)},{force:true,reason:'visible-replies-e2e'})`);
    await until(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-process')?.textContent.includes('继续检查工具回执。')`, 'ongoing work');
    const running = await snapshot();
    assert.equal(running.id, initial.id); assert(running.sameNode); assert.equal(running.count, 1);
    assert(running.text.includes('完整说明：')); assert(!running.text.includes('继续检查工具回执。'));
    assert(!running.process.includes('完整说明：')); assert(!running.processOpen);
    evidence.checks.push('resumed background work retains the delivered long answer in the same visible message');
    fs.appendFileSync(file, [row('user', 'tool-result', '', 4, { message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'check', content: 'ok' }] } }),
      row('assistant', 'later-answer', later, 5)].map(JSON.stringify).join('\n') + '\n');
    await client.eval(`requestCardIncrementalRefresh(${JSON.stringify(sid)},{force:true,reason:'visible-replies-e2e'})`);
    await until(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-message-bubble')?.textContent.includes(${JSON.stringify(later)})`, 'later answer');
    const done = await snapshot(); assert.equal(done.id, initial.id); assert(done.sameNode); assert.equal(done.count, 1);
    assert(done.text.includes('完整说明：')); assert(!done.process.includes('后续结论：')); assert(!done.process.includes('完整说明：'));
    evidence.checks.push('a later completed reply appends without demoting either delivered answer into process');
    await click('#msg-overlay>.turn-card.assistant .chat-message-bubble .conversation-long-message>summary');
    assert(await client.eval(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-message-bubble .conversation-long-message').open`));
    assert(await client.eval(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-message-bubble .conversation-full-text').textContent.includes('说明结尾：')`));
    evidence.checks.push('real pointer expands the long main message independently of the process drawer');
    await click('#msg-overlay>.turn-card.assistant .chat-process>summary');
    assert(await client.eval(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-process').open`));
    await click('#msg-overlay>.turn-card.assistant .chat-process>summary');
    await client.send('Page.reload', { ignoreCache: true });
    await until(`!!window.__hubE2E`, 'reload bridge');
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)})`);
    await until(`document.querySelector('#msg-overlay>.turn-card.assistant .chat-message-bubble')?.textContent.includes(${JSON.stringify(later)})`, 'cold history');
    const cold = await snapshot(); assert.equal(cold.id, initial.id); assert.equal(cold.count, 1);
    assert(cold.text.includes('完整说明：')); assert(!cold.process.includes('完整说明：'));
    assert(cold.text.includes(explanation)); assert(!cold.process.includes(explanation));
    evidence.checks.push('cold reload reprojects the disk history with both answers and no duplicate cards');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'visible-replies.png'), Buffer.from(shot.data, 'base64'));
    evidence.ok = true; evidence.version = require('../package.json').version;
    console.log(JSON.stringify({ ok: true, out, checks: evidence.checks }, null, 2));
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    await client?.close(); if (hub) await gracefulQuit(hub);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
