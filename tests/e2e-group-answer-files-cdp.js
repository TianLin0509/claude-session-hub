'use strict';
// Real isolated Electron + real dispatcher + gated Claude stream-json fixture.
// The fixture only receives prompts and ends turns when the test releases them;
// the test writes answer files the way an agent would. Not a real-model E2E.
// Covers: cards show only answer files, "还没交" otherwise, rescue after the
// CLI turn ended, updates while the Hub was down, and file answers feeding the
// next turn's context.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-answers-')), DATA = path.join(ROOT, 'data'), GATES = path.join(ROOT, 'gates');
const ART = path.resolve(__dirname, '..', 'artifacts', 'group-answer-files');
fs.mkdirSync(ART, { recursive: true }); fs.mkdirSync(GATES, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const received = () => { const p = path.join(GATES, 'received.jsonl'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
const release = (m, chat) => fs.writeFileSync(path.join(GATES, m.uuid + '.json'), JSON.stringify({ result: chat }));
const answerPath = m => { const hit = /写入 (.+?回答\.md)（/.exec(m.text); assert(hit, 'prompt names the answer file'); return hit[1]; };
const memberOf = m => /[\\/](m\d)[\\/]回答\.md/.exec(answerPath(m))[1];

async function run() {
  let hub, cdp, id;
  const checks = [], ok = (name, value) => { assert(value, name); checks.push(name); console.log('PASS ' + name); };
  const wait = async (label, pred, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = await pred(); if (r) return r; await sleep(150); } throw new Error('Timeout: ' + label); };
  const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(r.data, 'base64')); };
  const send = async text => {
    const p = await cdp.eval(`(()=>{const e=document.querySelector('#mr-input-box');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const card = (turn, member, sid) => cdp.eval(`(()=>{const e=document.querySelector('article[data-gc-msg-id="a${turn}-${member}"]')||document.querySelector('article[data-gc-msg-id="pending-${sid}"]');
    return e?{text:e.querySelector('.mr-gc-bubble').innerText,state:e.dataset.answerState,sync:!!e.querySelector('[data-gc-sync-answer]')}:null;})()`);
  const launch = async () => {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label: 'group-answers', extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), AI_HUB_WORKSPACE_ROOT: ROOT,
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.resolve(__dirname, 'fixtures/claude-stream.js'),
      CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'gated', CLAUDE_HUB_FIXTURE_GATE_DIR: GATES } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom'));
  };
  const open = async () => { const fresh = (await invoke('get-meetings')).find(x => x.id === id); await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`); return fresh; };
  try {
    const workspace = path.join(ROOT, 'workspace'); fs.mkdirSync(workspace);
    await launch();
    const m = await invoke('create-meeting', { mode: 'group', scene: 'general', groupChat: true, title: '回答文件验收', workspace,
      slots: [0, 1, 2].map(i => ({ index: i, memberId: 'm' + (i + 1), kind: 'claude', model: 'claude-haiku-4-5-20251001', mcpProfile: 'lean' })) });
    id = m.id;
    const meeting = await open();
    const sids = meeting.subSessions;
    await wait('composer', () => cdp.eval("!!document.querySelector('#mr-input-box')"));
    await send('三位各自给一个结论。');
    await wait('three prompts', () => received().length === 3, 90000);
    const first = received(), by = Object.fromEntries(first.map(r => [memberOf(r), r]));
    ok('每位成员的提示词都写明了自己的回答文件', ['m1', 'm2', 'm3'].every(k => by[k] && answerPath(by[k]).includes(`turn-1`)));
    // m1: writes the file and ends its turn with a different chat reply.
    fs.writeFileSync(answerPath(by.m1), '## m1 的结论\n文件里写的内容', 'utf8'); release(by.m1, '聊天里说的另一套话');
    // m2: ends its turn without writing a file. m3: still working, no file yet.
    release(by.m2, 'm2 只在聊天里回答了');
    await wait('m1 card from file', async () => (await card(1, 'm1', sids[0]))?.text.includes('文件里写的内容'));
    await wait('m2 turn settled', async () => { const s = await invoke('groupchat:get-state', { meetingId: id }); return s.messages.some(x => x.sid === sids[1] && x.role === 'assistant'); });
    await sleep(800);
    const c1 = await card(1, 'm1', sids[0]), c2 = await card(1, 'm2', sids[1]), c3 = await card(1, 'm3', sids[2]);
    ok('卡片显示文件内容，而不是聊天回复', c1.text.includes('文件里写的内容') && !c1.text.includes('另一套话'));
    ok('答完但没写文件：显示「还没交」', c2 && c2.text.includes('还没交') && !c2.text.includes('只在聊天里'));
    ok('还在干活且没文件：同样只显示「还没交」', c3 && c3.text.includes('还没交') && !/思考中|正在发言/.test(c3.text));
    ok('卡片上没有「同步」按钮', !c1.sync && !c2.sync && !c3.sync);
    ok('群聊 AI 头像使用原创女生且原图加载成功', await cdp.eval(`[...document.querySelectorAll('article[data-gc-msg-id] .mr-gc-avatar img')].filter(e=>e.src.includes('ai-avatars')).every(e=>e.naturalWidth>0) && !!document.querySelector('.mr-gc-avatar img[src="assets/ai-avatars/v1/claude.png"]')`));
    ok('群聊用户头像使用 Hub 橙色图标', await cdp.eval(`document.querySelector('.mr-gc-avatar-user img')?.getAttribute('src')==='../claude-wx.ico' && document.querySelector('.mr-gc-avatar-user img').naturalWidth>0`));
    await shot('01-files-and-missing');
    // Resend: a real click on m2's visible 重新发送; it reaches m2 only, same turn and answer file.
    const beforeResend = received().length;
    const btn = await cdp.eval(`(()=>{const b=document.querySelector('article[data-gc-msg-id="a1-m2"] [data-gc-resend-member]');if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,text:b.innerText};})()`);
    ok('还没交的卡片上直接有「重新发送」', btn && btn.text.includes('重新发送'));
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await wait('resend reaches m2', () => received().length > beforeResend, 30000);
    await sleep(800);
    const resent = received().slice(beforeResend);
    ok('重新发送只发给这位成员，沿用第 1 轮同一个回答文件', resent.length === 1 && memberOf(resent[0]) === 'm2' && answerPath(resent[0]) === answerPath(by.m2));
    release(resent[0], 'm2 重新收到后仍只在聊天里回答');
    // Rescue: the user asks m2 in its own session; it writes the file afterwards.
    fs.writeFileSync(answerPath(by.m2), 'm2 补交的结论', 'utf8');
    await wait('m2 rescued card', async () => (await card(1, 'm2', sids[1]))?.text.includes('m2 补交的结论'));
    ok('CLI 已结束后补写文件，卡片自动更新', true);
    fs.writeFileSync(answerPath(by.m2), '', 'utf8');
    await wait('cleared answer disappears', async () => (await card(1, 'm2', sids[1]))?.text.includes('还没交'));
    ok('清空回答文件后卡片不保留旧答案', true);
    fs.writeFileSync(answerPath(by.m2), 'm2 补交的结论', 'utf8');
    await wait('answer restored', async () => (await card(1, 'm2', sids[1]))?.text.includes('m2 补交的结论'));
    fs.writeFileSync(answerPath(by.m3), 'm3 的结论', 'utf8');
    await wait('m3 card while running', async () => (await card(1, 'm3', sids[2]))?.text.includes('m3 的结论'));
    ok('仍在运行时写好文件，卡片即时显示', true);
    release(by.m3, 'm3 聊天收尾');
    await shot('02-rescued');
    // Next turn: other members see file answers as group context.
    await wait('composer again', () => cdp.eval("!!document.querySelector('#mr-input-box')"));
    const secondBase = received().length;
    await send('互相看看对方的结论。');
    await wait('second prompts', () => received().length >= secondBase + 3, 90000);
    const second = received().slice(secondBase), toM1 = second.find(r => memberOf(r) === 'm1');
    ok('下一轮上下文来自文件：m1 看到 m2 补交的结论', toM1 && toM1.text.includes('m2 补交的结论') && !toM1.text.includes('只在聊天里'));
    ok('第二轮使用新的回答文件', answerPath(toM1).includes('turn-2'));
    second.forEach(r => release(r, 'done'));
    // Hub down: m1 corrects its answer; reopening the room picks it up.
    await cdp.close(); cdp = null; await gracefulQuit(hub); hub = null;
    fs.writeFileSync(answerPath(by.m1), '## m1 的结论\n重启期间更正的内容', 'utf8');
    await launch(); await open();
    await wait('corrected after restart', async () => (await card(1, 'm1', sids[0]))?.text.includes('重启期间更正的内容'));
    ok('Hub 关闭期间更新的文件，重开群聊后显示', true);
    fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify({ checks, provider: 'gated claude stream-json fixture', dispatcher: 'real', realModel: false }, null, 2));
    console.log('ARTIFACTS ' + ART);
  } catch (error) {
    if (cdp) { try { await shot('failure'); } catch {} }
    throw error;
  } finally { if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
}
run().catch(error => { console.error(error); console.error('ARTIFACT_ROOT ' + ROOT); process.exitCode = 1; });
