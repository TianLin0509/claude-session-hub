'use strict';
// 真实 Claude Haiku 群聊（PTY）：首轮群规则带成员名单、成员增加后老成员收到一行变更、
// 新成员走首轮（群规则 + 漏掉的上下文）。隔离数据目录 / home / Claude 配置，清空 DeepSeek key。
//   node tests/e2e-groupchat-context-live.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gc-context-live-'));
const DATA = path.join(ROOT, 'data');
const ART = path.resolve(__dirname, '..', 'artifacts', 'groupchat-context-live');
fs.mkdirSync(ART, { recursive: true });
const HAIKU = { kind: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'low', fastMode: false, mcpProfile: 'lean' };
const secrets = [];
const delay = ms => new Promise(r => setTimeout(r, ms));

function profiles() {
  const env = { CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), AI_HUB_WORKSPACE_ROOT: ROOT, DEEPSEEK_API_KEY: '' };
  const dest = path.join(ROOT, 'claude');
  fs.mkdirSync(dest, { recursive: true });
  env.CLAUDE_CONFIG_DIR = dest;
  for (const name of ['.credentials.json', 'settings.json']) {
    const original = path.join(os.homedir(), '.claude', name);
    if (fs.existsSync(original)) { fs.copyFileSync(original, path.join(dest, name)); secrets.push(path.join(dest, name)); }
  }
  const state = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(state)) { fs.copyFileSync(state, path.join(dest, '.claude.json')); secrets.push(path.join(dest, '.claude.json')); }
  const settings = path.join(dest, 'settings.json');
  if (fs.existsSync(settings)) {
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    delete s.hooks; delete s.enabledPlugins; delete s.statusLine;
    fs.writeFileSync(settings, JSON.stringify(s), 'utf8');
  }
  // 隔离 Hub 不向任何 Claude 配置目录部署 hook（main.js: isIsolatedHub → claudeDirs=[]），
  // 没有 Stop hook 就等不到结算。这里把仓库的 hook 部署进这份临时配置。
  const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration.js');
  const deployed = ensureClaudeHookIntegration({ claudeDir: dest, sourceScriptsDir: path.resolve(__dirname, '..', 'scripts'), logger: { log() {}, warn() {} } });
  if (deployed.errors.length) throw new Error('hook deploy failed: ' + deployed.errors.join('; '));
  return env;
}
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  let hub, cdp, id;
  const e = { realModel: 'claude-haiku-4-5', runtime: 'pty', root: ROOT, passed: false };
  const invoke = (ch, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
  const wait = async (label, pred, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const r = await pred(); if (r) return r; await delay(700); }
    throw Error('Timeout: ' + label);
  };
  const stateFile = () => path.join(DATA, 'arena-prompts', `${id}-groupchat.json`);
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } };
  const send = async text => {
    const point = await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const waitTurn = n => wait(`turn ${n} settled`, () => {
    const s = readState();
    const turn = s && (s.turns || []).find(t => t.n === n);
    return turn && s.currentMode === 'idle' ? { s, turn } : null;
  }, 240000);
  const promptOf = (s, n, sid) => {
    const m = (s.messages || []).find(x => x.role === 'assistant' && Number(x.turnNum) === n && x.sid === sid);
    return m ? { prompt: m.sourcePrompt || '', reply: m.content || '', status: m.status } : null;
  };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: profiles() });
    cdp = await connectFirstPage(hub);
    e.pid = hub.pid;
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom'));
    const workspace = path.join(ROOT, 'workspace');
    fs.mkdirSync(workspace);
    const m = await invoke('create-meeting', {
      mode: 'group', scene: 'general', groupChat: true, title: '群聊上下文 E2E', workspace,
      slots: [{ index: 0, memberId: 'm1', ...HAIKU }, { index: 1, memberId: 'm2', ...HAIKU }],
    });
    id = m.id;
    assert.equal(m.subSessions.length, 2);
    const [s1, s2] = m.subSessions;
    e.sessions = m.subSessions;
    const fresh = (await invoke('get-meetings')).find(x => x.id === id);
    await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`);
    await wait('composer', () => cdp.eval("!!document.querySelector('#mr-input-box')"));

    await send('只用一句话回答：除你之外，群里还有哪位成员？直接说出它的名字，不要调用任何工具。');
    const t1 = await waitTurn(1);
    e.turn1 = { status: t1.turn.byStatus, s1: promptOf(t1.s, 1, s1), s2: promptOf(t1.s, 1, s2) };
    for (const sid of [s1, s2]) {
      const p = promptOf(t1.s, 1, sid).prompt;
      assert.match(p, /## 规则/, 'first prompt carries group rules');
      assert.match(p, /## 群成员/, 'first prompt carries roster');
      assert.equal((p.split('## 群成员')[1].split('\n\n')[0].match(/^- /gm) || []).length, 2, 'roster lists both members');
      assert.equal((p.match(/（你）/g) || []).length, 1, 'self marked once');
      assert.doesNotMatch(p.split('## 群成员')[1].split('\n\n')[0], /角色|职责|立场/);
    }
    assert.ok(Number.isInteger(t1.s.lastDeliveredSeq[s1]) && Number.isInteger(t1.s.lastDeliveredSeq[s2]));

    const added = await cdp.eval(`(async()=>{const ipc=require('electron').ipcRenderer;const r=await ipc.invoke('add-meeting-sub',{meetingId:${JSON.stringify(id)},kind:'claude',opts:${JSON.stringify({ model: HAIKU.model, effort: 'low', fastMode: false, mcpProfile: 'lean' })}});if(r&&r.session)sessions.set(r.session.id,r.session);if(r&&r.meeting)window.MeetingRoom.updateMeetingData(${JSON.stringify(id)},r.meeting);return r&&r.meeting?{subs:r.meeting.subSessions,participants:r.meeting.participants}:null;})()`);
    assert.ok(added && added.subs.length === 3, 'third member added');
    const s3 = added.subs[2];
    e.added = added;
    await send('第二轮：同样一句话，现在群里除你之外有哪些成员？不要调用任何工具。');
    const t2 = await waitTurn(2);
    e.turn2 = { status: t2.turn.byStatus, s1: promptOf(t2.s, 2, s1), s3: promptOf(t2.s, 2, s3) };
    const p1 = promptOf(t2.s, 2, s1).prompt;
    assert.match(p1, /^（群成员变更：新加入 /, 'old member sees one-line roster change');
    assert.doesNotMatch(p1, /## 规则/, 'old member does not get rules again');
    const p3 = promptOf(t2.s, 2, s3).prompt;
    assert.match(p3, /## 规则/, 'new member gets rules');
    assert.match(p3, /## 群成员/);
    assert.match(p3, /只用一句话回答/, 'new member sees earlier user question');
    e.passed = true;
  } catch (error) {
    e.error = error.stack;
    e.lastState = id ? readState() : null;
    throw error;
  } finally {
    if (cdp) {
      try { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, 'live.png'), Buffer.from(shot.data, 'base64')); } catch {}
      await cdp.close().catch(() => {});
    }
    if (hub) { e.quit = await gracefulQuit(hub); try { e.logs = hub.log().join('\n').slice(-80000); } catch {} }
    for (const file of secrets) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.writeFileSync(path.join(ART, 'evidence.json'), JSON.stringify(e, null, 2), 'utf8');
    console.log(JSON.stringify({ passed: e.passed, error: e.error, turn1: e.turn1, turn2: e.turn2, root: ROOT }, null, 2));
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
