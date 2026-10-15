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

test('默认沿用不传 --model，也不触发菜单；明确选择与程序性模型参数保持可用', () => {
  for (const opts of [{ model: 'GLM-5.2-WX-Auto', codeagentModelPick: false },
    { model: 'MiniMax-M2.7', purpose: 'company-bridge', codeagentModelPick: true }]) {
    const launch = buildCodeAgentPtyLaunch('inherit-test', 'codeagent', opts, root, {}, config);
    assert.doesNotMatch(launch.cmd, /--model/);
    assert.equal(launch.model, null);
    assert.equal(shouldPickCodeAgentModel(opts), false);
  }
  for (const opts of [{ model: 'MiniMax-M2.7', codeagentModelPick: true }, { model: 'MiniMax-M2.7' }]) {
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

test('普通旧会话恢复不因保存了模型名就操作菜单，明确选择的会话仍保留意图', async () => {
  const resume = resumeHandler();
  for (const intent of [undefined, false, true]) {
    const result = await resume({ hubId: `intent-resume-${String(intent)}`, kind: 'codeagent', cwd: root,
      currentModel: { id: 'MiniMax-M2.7' }, ...(intent === undefined ? {} : { codeagentModelPick: intent }) });
    assert.equal(result.opts.model, 'MiniMax-M2.7');
    assert.equal(result.opts.codeagentModelPick, intent === true);
  }
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
});
