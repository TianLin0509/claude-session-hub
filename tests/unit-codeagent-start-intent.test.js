'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-intent-'));
const previous = process.env.CLAUDE_HUB_DATA_DIR;
process.env.CLAUDE_HUB_DATA_DIR = path.join(root, 'hub');
test.after(() => {
  if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
  else process.env.CLAUDE_HUB_DATA_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const { SessionManager, _private: { buildCodeAgentPtyLaunch, shouldPickCodeAgentModel } } = require('../core/session-manager');
const { buildSessionResumeMeta } = require('../core/session-capabilities');
const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
const config = { command: 'codeagent', configDir: path.join(root, 'cac'), stateFile: '.cac.json' };

test('模型名只是元数据，只有本次明确选型才能触发菜单', () => {
  for (const opts of [{ model: 'GLM-5.2-WX-Auto', codeagentModelPick: false },
    { model: 'MiniMax-M2.7' }, {},
    { model: 'MiniMax-M2.7', purpose: 'company-bridge', codeagentModelPick: true }]) {
    const launch = buildCodeAgentPtyLaunch('inherit-test', 'codeagent', opts, root, {}, config);
    assert.doesNotMatch(launch.cmd, /--model/);
    assert.equal(launch.model, null);
    assert.equal(shouldPickCodeAgentModel(opts), false);
  }
  for (const opts of [{ model: 'MiniMax-M2.7', codeagentModelPick: true }]) {
    assert.equal(shouldPickCodeAgentModel(opts), true);
    assert.match(buildCodeAgentPtyLaunch('explicit-test', 'codeagent', opts, root, {}, config).cmd, /--model MiniMax-M2\.7/);
  }
});

test('公开会话与恢复元数据保留 false/true，旧记录无意图证据按沿用处理', () => {
  for (const intent of [false, true, undefined]) {
    const session = { id: 'intent-meta', kind: 'codeagent', currentModel: { id: 'MiniMax-M2.7' },
      ...(intent === undefined ? {} : { codeagentModelPick: intent }) };
    const publicSession = SessionManager.prototype._toPublic.call({}, session);
    assert.equal(publicSession.codeagentModelPick, intent);
    const restored = buildSessionResumeMeta(publicSession);
    assert.equal(restored.codeagentModelPick, intent === true);
  }
});

test('模型意图通过真实磁盘序列化，休眠记录缺字段时保留且可明确改回沿用', () => {
  const store = require('../core/session-store');
  const { mergeResumeMetaFields } = require('../main/ipc/persistence-handlers');
  for (const intent of [false, true]) {
    const id = `intent-disk-${String(intent)}`;
    const session = { id, kind: 'codeagent', currentModel: { id: 'MiniMax-M2.7' }, codeagentModelPick: intent };
    const meta = buildSessionResumeMeta(SessionManager.prototype._toPublic.call({}, session));
    store.saveSessionFile(id, meta);
    const disk = store.loadSessionFile(id, { strict: true });
    assert.equal(disk.codeagentModelPick, intent);
    const oldRenderer = mergeResumeMetaFields([{ hubId: id, kind: 'codeagent' }], [disk])[0];
    assert.equal(oldRenderer.codeagentModelPick, intent);
    const explicitInherit = mergeResumeMetaFields([{ hubId: id, codeagentModelPick: false }], [disk])[0];
    assert.equal(explicitInherit.codeagentModelPick, false);
  }
});

function resumeHandler() {
  return createResumeSessionHandler({ fs, os, path,
    getHookPort: () => 0, getHubDataDir: () => path.join(root, 'hub'),
    isClaudeFamily: require('../core/ai-kinds').isClaudeFamily, isCodexBaseKind: () => false,
    meetingManager: { getMeeting: () => null }, slotIds: [], scenes: {},
    findTranscriptByCCSessionId: () => null,
    sessionManager: { createSession: (kind, opts) => ({ id: opts.id, kind, opts }), getSession: () => null },
    registerSessionForTap() {}, sendToRenderer() {}, logger: { warn() {}, log() {} },
  });
}

test('普通恢复不重复消费旧会话的选型意图，包括保存过 true 的旧版本记录', async () => {
  const resume = resumeHandler();
  for (const intent of [undefined, false, true]) {
    const result = await resume({ hubId: `intent-resume-${String(intent)}`, kind: 'codeagent', cwd: root,
      currentModel: { id: 'MiniMax-M2.7' }, ...(intent === undefined ? {} : { codeagentModelPick: intent }) });
    assert.equal(result.opts.model, 'MiniMax-M2.7');
    assert.equal(result.opts.codeagentModelPick, false);
  }
});

test('分支继承原生会话和模型信息，不重新操作模型菜单', () => {
  const { planSessionFork } = require('../core/session-fork-plan');
  for (const intent of [undefined, false, true]) {
    const source = { id: 'parent', kind: 'codeagent', cwd: root,
      ccSessionId: '12345678-1234-1234-1234-123456789abc', currentModel: { id: 'MiniMax-M2.7' },
      ...(intent === undefined ? {} : { codeagentModelPick: intent }) };
    const plan = planSessionFork({ source });
    assert.equal(plan.ok, true);
    assert.equal(plan.kind, 'codeagent');
    assert.equal(plan.opts.forkCCSessionId, source.ccSessionId);
    assert.equal(plan.opts.model, 'MiniMax-M2.7');
    assert.equal(shouldPickCodeAgentModel(plan.opts), false);
    assert.doesNotMatch(buildCodeAgentPtyLaunch('fork-test', plan.kind, plan.opts, root, {}, config).cmd, /--model/);
    const explicit = planSessionFork({ source, overrides: { model: 'GLM-5.2-WX-Auto', codeagentModelPick: true } });
    assert.equal(shouldPickCodeAgentModel(explicit.opts), true);
  }
});

test('原地重拉不会把已经选过的模型再次当作新请求', () => {
  const writes = [], events = [];
  const info = { id: 'relaunch-intent', kind: 'codeagent', cwd: root,
    currentModel: { id: 'MiniMax-M2.7' }, codeagentModelPick: true };
  const session = { info, pty: { write: text => writes.push(text), options: { env: {} } } };
  const manager = { sessions: new Map([[info.id, session]]), hubRulesSystemPrompt: () => null,
    emit: (...args) => events.push(args) };
  assert.equal(SessionManager.prototype.relaunchCli.call(manager, info.id), true);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /--model/);
  assert.equal(events.some(([name]) => name === 'codeagent-model-pick'), false);
});

test('原地重拉：用户明确选中过、且当前仍是那个模型时，重拉后再选一次（2026-10-16）', () => {
  const run = extra => {
    const writes = [], events = [];
    const info = { id: 'relaunch-user-model', kind: 'codeagent', cwd: root, currentModel: { id: 'MiniMax-M2.7' }, ...extra };
    const session = { info, pty: { write: text => writes.push(text), options: { env: {} } } };
    const manager = { sessions: new Map([[info.id, session]]), hubRulesSystemPrompt: () => null, emit: (...args) => events.push(args) };
    assert.equal(SessionManager.prototype.relaunchCli.call(manager, info.id), true);
    assert.doesNotMatch(writes[0], /--model/);
    return events.filter(([name]) => name === 'codeagent-model-pick').map(([, payload]) => payload);
  };
  assert.deepEqual(run({ codeagentUserModel: 'MiniMax-M2.7' }), [{ sessionId: 'relaunch-user-model', modelId: 'MiniMax-M2.7', reason: 'relaunch' }]);
  // 之后用户在 CLI 里自己换了模型（记录里观察到的不再是选中的那个）：不替他改回去。
  assert.deepEqual(run({ codeagentUserModel: 'GLM-5.2-WX-Auto' }), []);
  // 替家里办事的会话一律用默认模型。
  assert.deepEqual(run({ codeagentUserModel: 'MiniMax-M2.7', purpose: 'company-bridge' }), []);
});

test('恢复时明确覆盖模型仍算选模型，显式选择沿用也可覆盖旧意图', async () => {
  const resume = resumeHandler();
  const base = { kind: 'codeagent', cwd: root, currentModel: { id: 'GLM-5.2-WX-Auto' }, codeagentModelPick: false };
  const selected = await resume({ ...base, hubId: 'intent-override-select', launchOverrides: { model: 'MiniMax-M2.7' } });
  assert.equal(selected.opts.model, 'MiniMax-M2.7');
  assert.equal(selected.opts.codeagentModelPick, true);
  const inherited = await resume({ ...base, hubId: 'intent-override-inherit', codeagentModelPick: true,
    launchOverrides: { model: 'MiniMax-M2.7', codeagentModelPick: false } });
  assert.equal(inherited.opts.codeagentModelPick, false);
  const effortOnly = await resume({ ...base, hubId: 'intent-override-effort', codeagentModelPick: true,
    launchOverrides: { effort: 'low' } });
  assert.equal(effortOnly.opts.effort, 'low');
  assert.equal(effortOnly.opts.codeagentModelPick, false);
});

test('磁盘旧覆盖不能冒充本轮请求，本轮覆盖仍优先于磁盘', async () => {
  const store = require('../core/session-store');
  const hubId = 'intent-saved-override';
  store.saveSessionFile(hubId, { hubId, kind: 'codeagent', cwd: root,
    currentModel: { id: 'MiniMax-M2.7' }, codeagentModelPick: true,
    launchOverrides: { model: 'GLM-5.2-WX-Auto', codeagentModelPick: true } });
  const resume = resumeHandler();
  const plain = await resume({ hubId });
  assert.equal(plain.opts.model, 'MiniMax-M2.7');
  assert.equal(plain.opts.codeagentModelPick, false);
  const explicit = await resume({ hubId, launchOverrides: { model: 'GLM-5.2-WX-Auto' } });
  assert.equal(explicit.opts.model, 'GLM-5.2-WX-Auto');
  assert.equal(explicit.opts.codeagentModelPick, true);
});

test('选模型成功后记下用户明确选中的模型，供原地重拉使用', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
  // 2026-10-22：「选中的模型」是 picked（目标模型不在权限清单里时会被换成清单里的那个），不是最初请求的 modelId
  assert.match(src, /let picked = modelId;/);
  assert.match(src, /codeagentModelPick: false,\s*\n\s*\/\/[^\n]*\n\s*codeagentUserModel: picked \}\)/);
});
