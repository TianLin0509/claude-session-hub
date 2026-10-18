'use strict';
// 2026-10-18 田哥公司真机反馈 v2.1.11：DS 号的会话被标成 GLM、输入框下方只写「CodeAgent 当前模型」。
// 这里核对：建会话时的「预计模型」显示名（号池 / 个人 / 恢复三种）、内部 currentModel.id 仍为空；
// Hub 启动加载休眠会话不再拿模型清单第一项顶；唤醒合并保留本地显示名；侧栏图标在当前模型为空时看上一轮实际模型。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const models = require('../core/codeagent-models');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731';
const login = (dir, accountId) => { fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'x', accountId, expiresAt: Date.now() + 72 * 3600000 } })); };

test('_createSession 的显示名：号池号用同步配置定下的模型，个人账号用纠正后的默认模型，恢复的会话用上一轮实际模型；内部模型仍为空', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-expected-'));
  const dataDir = path.join(root, 'data'), personal = path.join(root, 'personal-cac');
  const env = { CLAUDE_HUB_DATA_DIR: dataDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_COMMAND: 'codeagent', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const dir of [dataDir, env.CLAUDE_HUB_HOME_DIR, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, env);
  require('../core/hub-config').clearConfigCache();
  // 个人账号写的是分档名 GLM-5.2-WX；号池里一个只有 DS 的号
  login(personal, 'w00111111');
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX' }));
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: [GLM], defaultModel: GLM });
  const id = pool.addAccount(dataDir, { note: '同事' });
  login(pool.accountDir(dataDir, id), 'w00222222');
  probe.writeProbed(path.join(pool.accountDir(dataDir, id), probe.MODELS_FILE), { models: [DS], defaultModel: DS });
  const pty = require('node-pty');
  t.mock.method(pty, 'spawn', () => ({ pid: 434343, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, write() {}, resize() {}, kill() {} }));
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  t.after(() => {
    manager.dispose();
    manager.openOwners?.close();
    require('../core/hub-config').clearConfigCache();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe test cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });

  const poolSession = manager.getSession(manager.createSession('codeagent', { cwd, codeagentAccount: 'pool' }).id);
  assert.equal(poolSession.codeagentPoolAccount, id);
  assert.deepEqual(poolSession.currentModel, { id: '', displayName: DS }, '号池号：显示 DS，内部模型为空');

  const personalSession = manager.getSession(manager.createSession('codeagent', { cwd }).id);
  assert.deepEqual(personalSession.currentModel, { id: '', displayName: 'GLM-5.2 Auto' }, '个人账号：分档名 GLM-5.2-WX 归到 GLM-5.2-WX-Auto');
  assert.match(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8'), /"GLM-5\.2-WX"/, '个人账号 settings.json 没被改写');

  const resumed = manager.getSession(manager.createSession('codeagent', { cwd, resumeCCSessionId: 'ce2b2941-1234-4567-89ab-123456789abc', codeagentActualModel: DS }).id);
  assert.deepEqual(resumed.currentModel, { id: '', displayName: DS }, '恢复：用上一轮实际模型，不是个人账号的默认');
  assert.equal(resumed.codeagentActualModel, DS, '上一轮实际模型随会话保留');
  assert.equal(manager._toPublic ? manager._toPublic(manager.sessions.get(resumed.id).info).codeagentActualModel : DS, DS);

  // 通道在个人账号新开会话：记下分配时间（和号池号一起轮转）；恢复不记
  assert.equal(pool.personalLastAssignedAt(dataDir), 0);
  manager.createSession('codeagent', { cwd, purpose: 'company-bridge', autonomous: true });
  const stamped = pool.personalLastAssignedAt(dataDir);
  assert.ok(stamped > 0, '通道新开个人账号会话记下分配时间');
  manager.createSession('codeagent', { cwd, purpose: 'company-bridge', resumeCCSessionId: 'de2b2941-1234-4567-89ab-123456789abc' });
  assert.equal(pool.personalLastAssignedAt(dataDir), stamped, '恢复不算新分配');

  // 什么都不知道时才写占位
  fs.rmSync(pool.personalModelsFile(dataDir));
  fs.writeFileSync(path.join(personal, 'settings.json'), '{}');
  const unknown = manager.getSession(manager.createSession('codeagent', { cwd }).id);
  assert.deepEqual(unknown.currentModel, { id: '', displayName: models.PLACEHOLDER_LABEL });
});

test('休眠兜底：CodeAgent 不拿模型清单第一项顶，用上一轮实际模型，没有就占位；和实际模型不是一家的旧值以实际为准', () => {
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: null, codeagentActualModel: DS }), { id: '', displayName: DS });
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: null }), { id: '', displayName: models.PLACEHOLDER_LABEL });
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: { id: '', displayName: DS } }), { id: '', displayName: DS }, '建会话时的预计模型保留');
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: { id: DS, displayName: DS }, codeagentActualModel: DS }), { id: DS, displayName: DS });
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: { id: GLM, displayName: 'GLM-5.2 Auto' }, codeagentActualModel: DS }), { id: DS, displayName: DS }, '旧版顶上的 GLM 与实际 DS 冲突：以实际为准');
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: { id: GLM, displayName: 'GLM-5.2 Auto' }, codeagentActualModel: DS, codeagentModelPick: true }), { id: GLM, displayName: 'GLM-5.2 Auto' }, '用户明确选的保留');
  assert.deepEqual(models.dormantDisplayModel({ kind: 'codeagent', currentModel: { id: GLM, displayName: 'GLM-5.2 Auto' }, codeagentActualModel: 'GLM-5.2-WX' }), { id: GLM, displayName: 'GLM-5.2 Auto' }, '同一家（Auto 分流）保留');
  // renderer 加载休眠会话：CodeAgent 走 dormantDisplayModel，别的 AI 照旧用清单第一项兜底
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const block = source.slice(source.indexOf('2026-05-05 dormant 加载 fallback'), source.indexOf('sessions.set(meta.hubId, {'));
  assert.match(block, /isCodeAgentSession\(meta\)\)\s*\{[\s\S]*dormantDisplayModel/);
  assert.match(block, /\} else if \(!resolvedModel \|\| !resolvedModel\.id\) \{\s*const opts = modelOptionsFor/);
  const entry = source.slice(source.indexOf('sessions.set(meta.hubId, {'), source.indexOf('nativeSessionBootstrap.finish();'));
  assert.match(entry, /codeagentActualModel: meta\.codeagentActualModel/, '休眠会话带上一轮实际模型（侧栏图标、恢复用）');
  const persist = source.slice(source.indexOf('function persistWorkscene'), source.indexOf('function persistWorkscene') + 6000);
  assert.match(persist, /codeagentActualModel: s\.codeagentActualModel/, '持久化带上一轮实际模型');
  assert.match(persist, /codeagentLaunchModel: s\.codeagentLaunchModel/);
});

test('唤醒合并：主进程给的显示名为空或是占位时保留本地已有的；侧栏图标在当前模型为空时看上一轮实际模型', () => {
  assert.equal(models.isPlaceholderModel({ id: '', displayName: models.PLACEHOLDER_LABEL }), true);
  assert.equal(models.isPlaceholderModel({ id: '', displayName: '' }), true);
  assert.equal(models.isPlaceholderModel(null), true);
  assert.equal(models.isPlaceholderModel({ id: '', displayName: DS }), false);
  assert.equal(models.isPlaceholderModel({ id: GLM }), false);
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const wake = source.slice(source.indexOf("ipcRenderer.on('session-created'"), source.indexOf("ipcRenderer.on('session-created'") + 2500);
  assert.match(wake, /isPlaceholderModel\(session\.currentModel\) && !codeAgentModels\.isPlaceholderModel\(existing\.currentModel\)/);
  assert.match(wake, /\.\.\.\(keepModel \? \{ currentModel: existing\.currentModel \} : \{\}\)/);
  assert.equal(models.iconModelId({ kind: 'codeagent', currentModel: { id: '' }, codeagentActualModel: DS }), DS);
  assert.equal(models.iconModelId({ kind: 'codeagent', currentModel: { id: GLM }, codeagentActualModel: DS }), GLM);
  assert.equal(models.iconModelId({ kind: 'claude', currentModel: { id: '' }, codeagentActualModel: DS }), '');
  const list = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'), 'utf8');
  assert.equal((list.match(/iconModelId\(/g) || []).length, 3, '侧栏三处图标都按 iconModelId');
});

test('持久化：上一轮实际模型、通道实际启动模型进会话文件和合并字段，主进程的值优先', () => {
  const { RESUME_META_FIELDS } = require('../main/ipc/persistence-handlers');
  for (const f of ['codeagentActualModel', 'codeagentRequestedModel', 'codeagentLaunchModel']) assert.ok(RESUME_META_FIELDS.includes(f), f);
  const store = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-store.js'), 'utf8');
  assert.match(store, /codeagentLaunchModel: typeof data\.codeagentLaunchModel === 'string'/);
  const resume = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'resume-session-handlers.js'), 'utf8');
  assert.match(resume, /codeagentActualModel: meta\.codeagentActualModel/);
});
