'use strict';
// 2026-10-21 同事公司 Hub 3.0.1：自动选模型 13 次全失败（「模型命令尚未确认，请查看终端；未自动补发回车；尚未确认恢复普通输入框」），
// 问题因此没发出去（send-threw）或 180 秒后才补发。这里核对：
//   1. 菜单认不出、旧版输入框也认不出，但菜单已关 → 自动会话照常发问题；菜单真关不掉才走失败路径，原因写人话；
//   2. 只认真实证据跳过：恢复的会话上一轮已是目标模型 → 不选；配置里写的默认模型不再跳过（2026-10-22：号池号也一律走菜单）；
//   3. 同一账号连续 3 次没选成 → 4 小时内跳过，成功一次清零，重启后仍记得。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const picker = require('../core/codeagent-model-picker');
const autoPick = require('../core/codeagent-auto-pick');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731';
const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hub-autopick-${name}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// 假屏幕：旧版 CodeAgent 的输入框（Hub 的输入框规则认不出；不宣称是公司真机原文）
const OLD_IDLE = [' ╭──────────────────────────────────────────╮', ' │ > 请输入你的问题                          │', ' ╰──────────────────────────────────────────╯', '   GLM-5.2-WX-Auto · 上下文 3%'];
// 打开后认不出的菜单：没有 Select model 标题/底栏、光标靠反色（文字里没有光标符号）
const OLD_MENU = ['  模型', '    GLM-5.2-WX-Auto', '    MiniMax-M2.7', '  ↑↓ 移动  回车 确认  Esc 返回'];

function harness(sid, initial, { escapeCloses = true } = {}) {
  const manager = new EventEmitter();
  const writes = [];
  let lines = initial, seq = 0;
  const paint = next => { lines = next; manager.emit('output', { sessionId: sid, data: '\x1b[2J\x1b[H' + lines.join('\r\n'), seq: ++seq }); };
  manager.getSessionBufferSnapshot = async () => ({ text: lines.join('\r\n'), seq, cols: 120, rows: 30 });
  manager.getSessionBuffer = () => lines.join('\n');
  manager.writeToSession = (_sid, data) => { writes.push(data); if (data === '\x1b' && escapeCloses) setTimeout(() => paint(OLD_IDLE), 10); };
  return { manager, writes, paint };
}

test('判据：旧版画面认不出输入框，但菜单已关、输入行没留「/model」才算能发；菜单痕迹、/model 残留、空白都不算', () => {
  assert.equal(picker.promptInputReady(OLD_IDLE), false, '前提：旧版输入框 Hub 认不出');
  assert.equal(picker.inputUsableAfterPick(OLD_IDLE), true);
  assert.equal(picker.inputUsableAfterPick(OLD_MENU), false, '菜单底栏还在');
  assert.equal(picker.inputUsableAfterPick(['  Select model', '  (unrecognized)']), false);
  assert.equal(picker.inputUsableAfterPick([' │ > /model                │']), false, '输入行还留着 /model');
  assert.equal(picker.inputUsableAfterPick(['', '  ']), false, '空白屏');
});

test('菜单认不出 → Esc 关掉后 inputUsable=true（照常发的依据）；Esc 关不掉 → inputUsable=false', async () => {
  const h = harness('old-menu', OLD_IDLE);
  const result = await picker.pickModel({ manager: h.manager, sid: 'old-menu', kind: 'codeagent', modelId: GLM, screenTimeoutMs: 30, env: {},
    sendToPty: async () => { h.paint(OLD_MENU); return { ok: true, sendStatus: 'stuck', message: '模型命令尚未确认，请查看终端；未自动补发回车' }; } });
  assert.equal(result.ok, false);
  assert.equal(result.inputReady, false);
  assert.equal(result.inputUsable, true);
  assert.match(result.message, /尚未确认恢复普通输入框/, '与同事日志同一句报错');
  assert.equal(h.writes[0], '\x1b');

  const stuck = harness('old-menu-stuck', OLD_IDLE, { escapeCloses: false });
  const bad = await picker.pickModel({ manager: stuck.manager, sid: 'old-menu-stuck', kind: 'codeagent', modelId: GLM, screenTimeoutMs: 30, env: {},
    sendToPty: async () => { stuck.paint(OLD_MENU); return { ok: true, sendStatus: 'stuck', message: '模型命令尚未确认' }; } });
  assert.equal(bad.ok, false);
  assert.equal(bad.inputUsable, false);
});

function sessionIpc(t, session, pickResult) {
  const dataDir = tmp(t, 'data');
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  t.mock.method(picker, 'pickModel', async () => pickResult);
  const manager = new EventEmitter();
  const sent = [];
  manager.getSession = id => (id === session.id ? session : null);
  manager.updateSessionMeta = () => null;
  manager.getAllSessions = () => [session];
  manager.codeagentPoolActiveCounts = () => ({});
  require('../main/ipc/session-handlers').registerSessionIpc({ handle() {}, on() {} }, { sendToRenderer: (e, d) => sent.push([e, d]), sessionManager: manager });
  return { manager, sent, dataDir };
}

test('通道会话：菜单认不出但已关 → 不报 send-threw，照常把问题发出去；pick 日志写明兜底', async t => {
  const cfg = tmp(t, 'cfg');
  const session = { id: 'bridge-old-1', kind: 'codeagent', purpose: 'company-bridge', codeagentConfigDir: cfg };
  const { manager, sent, dataDir } = sessionIpc(t, session, { ok: false, inputReady: false, inputUsable: true,
    message: '模型命令尚未确认，请查看终端；未自动补发回车；尚未确认恢复普通输入框' });
  manager.emit('codeagent-model-pick', { sessionId: session.id, modelId: GLM, reason: 'launch' });
  const result = await picker.waitForPick(session.id);
  assert.equal(result.ok, true, '等选模型的第一条问题不再被退回');
  assert.equal(result.fallback, 'cli-default-model');
  assert.equal(sent.some(([e]) => e === 'session-notice'), false);
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8');
  assert.match(log, /event=pick .*ok=false .*fallback=send-with-cli-model/);
});

test('通道会话：菜单真关不掉 → 仍不发（防把问题打进菜单），原因是人话', async t => {
  const cfg = tmp(t, 'cfg');
  const session = { id: 'bridge-old-2', kind: 'codeagent', purpose: 'company-bridge', codeagentConfigDir: cfg };
  const { manager } = sessionIpc(t, session, { ok: false, inputReady: false, inputUsable: false, message: '模型命令尚未确认；尚未确认恢复普通输入框' });
  manager.emit('codeagent-model-pick', { sessionId: session.id, modelId: GLM, reason: 'launch' });
  await assert.rejects(picker.waitForPick(session.id), error => error.notSent === true && /模型菜单也没能关掉.*没有发出去/.test(error.message));
});

test('用户自己的会话不变：认不出输入框时首条仍退回说明（回归）', async t => {
  const cfg = tmp(t, 'cfg');
  const session = { id: 'user-old-1', kind: 'codeagent', codeagentConfigDir: cfg };
  const { manager } = sessionIpc(t, session, { ok: false, inputReady: false, inputUsable: true, message: '菜单认不出' });
  manager.emit('codeagent-model-pick', { sessionId: session.id, modelId: GLM, reason: 'launch' });
  await assert.rejects(picker.waitForPick(session.id), error => error.notSent === true);
  picker.resetFailure(session.id);
});

test('熔断：同一账号连续 3 次自动选模型失败 → 4 小时内跳过；成功一次清零；到期后重新计数；重启后仍记得（存数据目录）', t => {
  const dataDir = tmp(t, 'breaker');
  const t0 = Date.parse('2026-10-21T08:00:00Z');
  assert.equal(autoPick.record(dataDir, 'acct01', false, { now: t0 }).opened, false);
  assert.equal(autoPick.record(dataDir, 'acct01', false, { now: t0 + 1000 }).opened, false);
  const third = autoPick.record(dataDir, 'acct01', false, { now: t0 + 2000, error: '模型命令尚未确认' });
  assert.equal(third.opened, true);
  assert.equal(third.until, t0 + 2000 + 4 * 3600 * 1000);
  assert.ok(autoPick.openFor(dataDir, 'acct01', { now: t0 + 3600 * 1000 }), '1 小时后仍熔断');
  assert.equal(autoPick.openFor(dataDir, 'personal', { now: t0 + 3600 * 1000 }), null, '别的号不受影响');
  const skip = autoPick.skipReason({ dataDir, account: 'acct01', isPool: true, target: GLM, routeModel: GLM, freshLaunch: true, now: t0 + 3600 * 1000 });
  assert.equal(skip.reason, 'breaker');
  assert.equal(autoPick.snapshot(dataDir, { now: t0 + 3600 * 1000 }).acct01.open, true, '诊断能看到');
  assert.equal(autoPick.openFor(dataDir, 'acct01', { now: t0 + 5 * 3600 * 1000 }), null, '4 小时后到期');
  assert.equal(autoPick.record(dataDir, 'acct01', false, { now: t0 + 5 * 3600 * 1000 }).failures, 1, '到期后从 1 重新计数');
  autoPick.record(dataDir, 'acct01', true, { now: t0 + 5 * 3600 * 1000 + 1 });
  assert.equal(autoPick.snapshot(dataDir).acct01, undefined, '成功一次清零');
  // 两次失败 + 一次成功 + 两次失败：不熔断（要求连续）
  for (const ok of [false, false, true, false, false]) autoPick.record(dataDir, 'p2', ok, { now: t0 });
  assert.equal(autoPick.openFor(dataDir, 'p2', { now: t0 }), null);
});

test('跳过规则：只认真实证据（上一轮实际作答）；配置里写的默认模型不再跳过，恢复已是目标才不选', t => {
  const dataDir = tmp(t, 'skip');
  const base = { dataDir, account: 'acct01', isPool: true, target: DS };
  // 2026-10-22：号池号 fresh launch 一律走菜单——Q-1022-* 真机上 settings.json 写的是 DeepSeek，CLI 照样按 GLM 起来。
  assert.equal(autoPick.skipReason({ ...base, freshLaunch: true }), null, '号池号新开照常选（配置里写的不可信）');
  assert.equal(autoPick.skipReason({ ...base, freshLaunch: true, actualModel: DS }), null, '新开的会话不看 actualModel');
  assert.equal(autoPick.skipReason({ ...base, freshLaunch: false, actualModel: DS }).reason, 'resume-same-model');
  assert.equal(autoPick.skipReason({ ...base, freshLaunch: false, actualModel: GLM }), null, '上一轮不是目标');
  assert.equal(autoPick.skipReason({ ...base, isPool: false, account: 'personal', freshLaunch: true }), null, '个人账号照常选（Q-1020-14）');
  assert.equal(autoPick.skipReason({ ...base, isPool: false, account: 'personal', freshLaunch: false, actualModel: DS }), null);
  assert.equal(autoPick.skipReason({ ...base, target: '' }), null);
});

test('_createSession 接线：号池号新开 → 发选模型事件；恢复已是目标 → 不选；个人账号熔断 → 不选', async t => {
  const pool = require('../core/codeagent-pool');
  const probe = require('../core/codeagent-model-probe');
  const models = require('../core/codeagent-models');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-autopick-create-'));
  const dataDir = path.join(root, 'data'), personal = path.join(root, 'personal-cac');
  const env = { CLAUDE_HUB_DATA_DIR: dataDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_COMMAND: 'codeagent', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const dir of [dataDir, env.CLAUDE_HUB_HOME_DIR, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, env);
  require('../core/hub-config').clearConfigCache();
  const login = (dir, accountId) => { fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId, expiresAt: Date.now() + 72 * 3600000 } })); };
  login(personal, 'w00111111');
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: GLM }));
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  const id = pool.addAccount(dataDir, { note: '同事' });
  login(pool.accountDir(dataDir, id), 'w00222222');
  probe.writeProbed(path.join(pool.accountDir(dataDir, id), probe.MODELS_FILE), { models: [DS], defaultModel: DS });
  fs.writeFileSync(path.join(pool.accountDir(dataDir, id), 'settings.json'), JSON.stringify({ model: DS }));
  const pty = require('node-pty');
  t.mock.method(pty, 'spawn', () => ({ pid: 434344, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, write() {}, resize() {}, kill() {} }));
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  t.after(() => {
    manager.dispose(); manager.openOwners?.close();
    require('../core/hub-config').clearConfigCache();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 上会话管理器的文件句柄晚释放，留给系统临时目录 */ }
  });
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  const picks = [];
  manager.on('codeagent-model-pick', event => picks.push(event));

  const fresh = manager.createSession('codeagent', { cwd, purpose: 'company-bridge', codeagentAccount: 'pool' });
  assert.equal(picks.length, 1, '号池号新开：照常开菜单（配置里写的 DS 不再作为跳过的依据，Q-1022-* 真机按 GLM 起来过）');
  assert.equal(picks[0].modelId, DS, '目标仍是这个号该用的 DS');
  assert.deepEqual(manager.getSession(fresh.id).currentModel, { id: DS, displayName: models.modelLabel(DS) }, '选型标记打开，显示按目标模型');
  const log = () => fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8');
  assert.doesNotMatch(log(), /pick-skipped/, '不再按配置跳过');
  assert.doesNotMatch(log(), /w00222222|同事/, '日志随诊断发回家里，不带号主信息');

  manager.createSession('codeagent', { cwd, purpose: 'company-bridge', codeagentAccount: 'pool', codeagentRouteModel: DS });
  assert.equal(picks.length, 2, '家里指定了模型：照常选');

  manager.createSession('codeagent', { cwd, purpose: 'company-bridge', codeagentPoolAccount: id, codeagentActualModel: DS,
    resumeCCSessionId: 'ae2b2941-1234-4567-89ab-123456789abc' });
  assert.equal(picks.length, 2, '恢复的会话上一轮就是 DS：不选');
  assert.match(log(), /reason=resume-same-model/);

  manager.createSession('codeagent', { cwd, purpose: 'company-bridge' });
  assert.equal(picks.length, 3, '个人账号照常选');
  assert.equal(picks[2].modelId, GLM);

  for (let i = 0; i < 3; i += 1) autoPick.record(dataDir, 'personal', false, { error: '模型命令尚未确认' });
  manager.createSession('codeagent', { cwd, purpose: 'company-bridge' });
  assert.equal(picks.length, 3, '个人账号熔断：不开菜单，直接发问题');
  assert.match(log(), /event=pick-skipped .*account=个人 .*reason=breaker/);
  assert.ok(models.modelLabel(GLM));
});
