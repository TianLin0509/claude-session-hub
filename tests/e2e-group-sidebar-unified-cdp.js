'use strict';
// Real isolated Electron, seeded history and a controlled native model fixture.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-group-sidebar-'));
const data = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
const out = path.resolve('artifacts/20261021-group-sidebar-codex1/gui-' + Date.now());
for (const dir of [data, out, workspace]) fs.mkdirSync(dir, { recursive: true });
const now = Date.now();
const member = (id, kind, meetingId, extra = {}) => ({ hubId: id, kind, meetingId,
  title: kind + ' 1', cwd: root, status: 'dormant', lastMessageTime: now,
  currentModel: { id: kind === 'claude' ? 'claude-opus-4-6' : 'gpt-6-astra', displayName: kind === 'claude' ? 'Opus 4.6' : 'GPT-6 Astra' }, ...extra });
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true,
  sessions: [member('old-claude', 'claude', 'old-group'), member('old-codex', 'codex', 'old-group'),
    member('manual', 'codex', 'legacy-group', { title: '我的审稿员', userRenamed: true })],
  meetings: [{ id: 'old-group', title: 'SuperRAN与AirView算法核对', groupChat: true, scene: 'general',
    status: 'dormant', subSessions: ['old-claude', 'old-codex'], lastMessageTime: now, createdAt: now },
  { id: 'legacy-group', title: '历史群聊', groupChat: false, scene: 'general', status: 'dormant',
    subSessions: ['manual'], lastMessageTime: now, createdAt: now }], immersiveByMeeting: {} }));
const json = JSON.stringify;
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function main() {
  let hub, c;
  const evidence = { root, out, checks: [], passed: false };
  const wait = async (expr, label) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) {
    if (await c.eval(expr)) return; await _waitMs(100);
  } throw new Error('Timeout: ' + label); };
  const invoke = (channel, value) => c.eval(`ipcRenderer.invoke(${json(channel)},${json(value)})`);
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${json(selector)});if(!e)throw new Error('Missing '+${json(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
    assert(p.w > 0 && p.h > 0, selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    await _waitMs(500);
  };
  const shot = async name => {
    for (const height of [901, 900]) { await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false }); await _waitMs(100); }
    const result = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  const layout = async id => c.eval(`(()=>{const g=document.querySelector('[data-sidebar-group="${id}"]');return {
    members:g?.querySelectorAll('.sidebar-group-children .child').length,
    visible:[...g?.querySelectorAll('.sidebar-group-children .child')||[]].every(e=>e.getBoundingClientRect().height>0),
    extra:g?.querySelectorAll('.sl-unread-members,.sl-group-actions,.expand-arrow,.session-mini-jumps').length,
    logos:g?.querySelectorAll('.sl-group-logos .ai-logo').length,
    parentHeight:g?.querySelector('.meeting').getBoundingClientRect().height
  }})()`);
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'group-sidebar-unified', extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      AI_HUB_WORKSPACE_ROOT: root, DEEPSEEK_API_KEY: '',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(`document.querySelector('[data-session-id="old-codex"]')`, 'restored sidebar');
    assert.equal(await c.eval(`document.querySelector('[data-session-id="old-claude"] .sl-title').textContent`), 'Opus 4.6 · SuperRAN与AirView算法核对');
    assert.equal(await c.eval(`document.querySelector('[data-session-id="old-codex"] .sl-title').textContent`), 'GPT-6 Astra · SuperRAN与AirView算法核对');
    assert.equal(await c.eval(`sessions.get('old-claude').title`), 'claude 1');
    assert.equal(fs.existsSync(path.join(data, 'sessions', 'old-claude.json')), false, 'displaying unopened history must not write its metadata');
    assert.equal(await c.eval(`sessions.get('manual').title`), '我的审稿员');
    for (const id of ['old-group', 'legacy-group']) {
      const state = await layout(id);
      assert.equal(state.members, id === 'old-group' ? 2 : 1);
      assert.equal(state.visible, true); assert.equal(state.extra, 0); assert(state.parentHeight < 40);
    }
    await shot('01-restored-unified');
    evidence.checks.push('Restored and legacy groups share one parent/member layout; dormant labels carry model prefixes without rewriting unopened history; manual name preserved');
    await click('#btn-session-details');
    assert.equal((await layout('old-group')).visible, true);
    assert.equal((await layout('old-group')).extra, 0);
    assert.equal(await c.eval(`document.querySelectorAll('[data-sidebar-group="old-group"] .child.has-details').length`), 2);
    await click('#btn-session-details');
    assert.equal(await c.eval(`document.querySelectorAll('[data-sidebar-group="old-group"] .child.has-details').length`), 0);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 700 });
    assert.equal((await layout('old-group')).visible, true);
    evidence.checks.push('Details toggle and moving pointer away keep the same group/member structure');
    // Backend title changes exercise the same shared sync used by automatic naming.
    await invoke('update-meeting-sync', { meetingId: 'old-group', fields: { title: '算法核对更新' } });
    await wait(`sessions.get('old-codex').title==='GPT-6 Astra · 算法核对更新'`, 'dormant group rename');
    const diskMember = JSON.parse(fs.readFileSync(path.join(data, 'sessions', 'old-codex.json'), 'utf8'));
    assert.equal(diskMember.title, 'GPT-6 Astra · 算法核对更新');
    evidence.checks.push('Group title change updates dormant member metadata on disk');
    const model = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' };
    const standalone = await invoke('create-session', { kind: 'codex', opts: { ...model, cwd: workspace, title: '对照会话', userRenamed: true } });
    const group = await invoke('create-meeting', { workspace, scene: 'general', slots: [model, model] });
    const [a, b] = group.subSessions;
    await wait(`${json(group.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.threadId)`, 'native group members');
    await click(`[data-session-id="${standalone.id}"]`);
    const turn = await invoke('groupchat:turn', { meetingId: group.id, userInput: 'fixture:normal', turnTimeoutMs: 20000 });
    assert.equal(turn.status, 'completed');
    await wait(`meetingUnread.getMeetingUnreadMemberIds(meetings[${json(group.id)}],sessions).size===2`, 'real dispatcher unread');
    await wait(`meetings[${json(group.id)}].autoTitleGenerated===true && ${json(group.subSessions)}.every(id=>sessions.get(id).title.endsWith(' · '+meetings[${json(group.id)}].title))`, 'automatic group/member titles');
    const unreadLayout = await layout(group.id);
    assert.equal(unreadLayout.visible, true); assert.equal(unreadLayout.extra, 0); assert(unreadLayout.parentHeight < 40);
    await shot('02-unread-unified');
    evidence.checks.push('Real native fixture group turn automatically names group and both members; unread group retains the same compact layout');
    await click(`[data-meeting-id="${group.id}"] .sl-title`);
    await wait(`activeMeetingId===${json(group.id)} && meetingUnread.getMeetingUnreadMemberIds(meetings[${json(group.id)}],sessions).size===0`, 'whole group read');
    assert(await c.eval(`${json(group.subSessions)}.every(id=>!sessions.get(id).unreadCount && !sessions.get(id).replyReady)`));
    const mainSessions = await invoke('get-sessions');
    assert(mainSessions.filter(s => [a, b].includes(s.id)).every(s => !s.unreadCount && !s.replyReady));
    await shot('03-open-clears-all');
    evidence.checks.push('Physical group click clears group and all member completed unread in renderer and main process');
    await invoke('rename-session', { sessionId: a, title: '保留我的名字', userRenamed: true });
    await invoke('update-meeting-sync', { meetingId: group.id, fields: { title: '新任务标题' } });
    await wait(`sessions.get(${json(b)}).title.endsWith(' · 新任务标题')`, 'live group rename');
    assert.equal(await c.eval(`sessions.get(${json(a)}).title`), '保留我的名字');
    // New completions after opening remain unread until the next explicit visit.
    const second = await invoke('groupchat:turn', { meetingId: group.id, userInput: 'fixture:normal followup', turnTimeoutMs: 20000 });
    assert.equal(second.status, 'completed');
    await wait(`meetingUnread.getMeetingUnreadMemberIds(meetings[${json(group.id)}],sessions).size===2`, 'new unread after visit');
    await click(`[data-meeting-id="${group.id}"] .sl-title`);
    await wait(`meetingUnread.getMeetingUnreadMemberIds(meetings[${json(group.id)}],sessions).size===0`, 'second visit read');
    evidence.checks.push('Manual member title survives group rename; later replies become unread and the next group click clears them');
    await c.eval('schedulePersist()'); await _waitMs(1200);
    await c.close(); c = null; await gracefulQuit(hub); hub = null;
    const persisted = JSON.parse(fs.readFileSync(path.join(data, 'sessions', b + '.json'), 'utf8'));
    assert(persisted.title.endsWith(' · 新任务标题')); assert.equal(persisted.unreadCount, 0);
    evidence.checks.push('Clean shutdown persists member auto title and read state');
    evidence.passed = true;
  } finally {
    if (c) { if (!evidence.passed) { try { await shot('failure'); evidence.debug = await c.eval(`({groups:Object.values(meetings).map(m=>({id:m.id,title:m.title,subSessions:m.subSessions})),sessions:[...sessions.values()].map(s=>({id:s.id,title:s.title,status:s.status}))})`); } catch {} } await c.close(); }
    if (hub) { evidence.hubLog = hub.log().slice(-35); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
