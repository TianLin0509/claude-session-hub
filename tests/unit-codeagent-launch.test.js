'use strict';
// 公司 Code Agent（Claude 形态的 CLI，core/codeagent-config.js）的启动契约。
// 依据 2026-10-08 两轮公司实测：它不认 --session-id 与 --settings，不带 --disable-update 会弹阻塞的升级框。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-launch-'));
  const configDir = path.join(root, '.cac');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const previous = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(root, 'hub');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = { command: 'codeagent', configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir, stateFile: '.cac.json' };
  return { root, configDir, cwd, config };
}

test('codeagent is a Claude-family kind with its own label, models and resume variant', () => {
  const kinds = require('../core/ai-kinds');
  for (const kind of ['codeagent', 'codeagent-resume']) {
    assert.equal(kinds.isClaudeFamily(kind), true, kind);
    assert.equal(kinds.isCodeAgentKind(kind), true, kind);
  }
  assert.equal(kinds.isCodeAgentKind('claude'), false);
  assert.equal(kinds.canonicalAiKind('codeagent-resume'), 'codeagent');
  assert.equal(kinds.getKindLabel('codeagent'), 'CodeAgent');
  const { MODEL_OPTIONS_BY_KIND, DEFAULT_MODEL_BY_KIND } = require('../core/model-options');
  assert.deepEqual(MODEL_OPTIONS_BY_KIND.codeagent.map(m => m.id), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7']);
  assert.equal(DEFAULT_MODEL_BY_KIND.codeagent, 'GLM-5.2-WX-Auto');
});

test('config: defaults, environment overrides and unsafe values', () => {
  const { resolveCodeAgentConfig, commandHead } = require('../core/codeagent-config');
  const home = path.join(os.tmpdir(), 'home-x');
  const base = resolveCodeAgentConfig({ USERPROFILE: home }, {});
  assert.equal(base.command, 'codeagent');
  assert.equal(base.configDirEnv, 'CODEAGENT3_CONFIG_DIR');
  assert.equal(base.configDir, path.join(home, '.cac'));
  assert.equal(resolveCodeAgentConfig({ USERPROFILE: home, CODEAGENT3_CONFIG_DIR: 'D:\\cac' }, {}).configDir, path.resolve('D:\\cac'));
  const custom = resolveCodeAgentConfig({ USERPROFILE: home, AI_HUB_CODEAGENT_COMMAND: 'C:\\tools\\code agent.cmd',
    AI_HUB_CODEAGENT_CONFIG_DIR: 'D:\\test\\.cac' }, {});
  assert.equal(commandHead(custom.command), "& 'C:\\tools\\code agent.cmd'");
  assert.equal(custom.configDir, path.resolve('D:\\test\\.cac'));
  assert.throws(() => resolveCodeAgentConfig({ AI_HUB_CODEAGENT_COMMAND: 'codeagent; rm x' }, {}), /不允许/);
  assert.throws(() => resolveCodeAgentConfig({ AI_HUB_CODEAGENT_CONFIG_ENV: 'BAD-NAME' }, {}), /无效/);
});

test('launch never passes --session-id or --settings and always disables the update dialog', t => {
  const { cwd, config, configDir } = sandbox(t);
  const { buildCodeAgentPtyLaunch } = require('../core/session-manager')._private;
  const env = {};
  const fresh = buildCodeAgentPtyLaunch('hub-1', 'codeagent', { model: 'minimax-m2.7', effort: 'max' }, cwd, env, config);
  assert.equal(fresh.sessionId, null, 'identity is bound from the first hook, not assigned');
  assert.match(fresh.cmd, /^ codeagent --disable-update --skip-safe-check --model MiniMax-M2\.7 --effort max --permission-mode bypassPermissions/);
  assert.doesNotMatch(fresh.cmd, /--session-id|--settings|--continue|--setting-sources/);
  assert.ok(fresh.cmd.endsWith('\r\n'));

  const unknownModel = buildCodeAgentPtyLaunch('hub-1', 'codeagent', { model: 'claude-opus-5', effort: 'xhigh' }, cwd, env, config);
  assert.match(unknownModel.cmd, /--model GLM-5\.2-WX-Auto/, 'unknown models fall back to the CLI default model');
  assert.doesNotMatch(unknownModel.cmd, /--effort/, 'unsupported effort is not passed');

  // An id without any transcript is a fresh start: no --resume that would fail, and no --continue.
  const seat = '11111111-2222-4333-8444-555555555555';
  const noHistory = buildCodeAgentPtyLaunch('hub-2', 'codeagent', { resumeCCSessionId: seat }, cwd, env, config);
  assert.equal(noHistory.sessionId, null);
  assert.doesNotMatch(noHistory.cmd, /--resume|--continue|--session-id/);

  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  fs.mkdirSync(path.join(configDir, 'projects', slug), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects', slug, seat + '.jsonl'), '{}\n');
  const resumed = buildCodeAgentPtyLaunch('hub-2', 'codeagent', { resumeCCSessionId: seat }, cwd, env, config);
  assert.equal(resumed.sessionId, seat, 'resuming a recorded session keeps its identity');
  assert.match(resumed.cmd, new RegExp(`^ codeagent --resume ${seat} --disable-update`));

  const fork = buildCodeAgentPtyLaunch('hub-3', 'codeagent', { forkCCSessionId: seat }, cwd, env, config);
  assert.equal(fork.sessionId, null, 'a fork gets a new identity from the CLI');
  assert.match(fork.cmd, new RegExp(`--resume ${seat} --fork-session --disable-update`));
  assert.doesNotMatch(fork.cmd, /--session-id/);

  const picker = buildCodeAgentPtyLaunch('hub-4', 'codeagent-resume', {}, cwd, env, config);
  assert.match(picker.cmd, /^ codeagent --resume --disable-update/);

  const spaced = buildCodeAgentPtyLaunch('hub-5', 'codeagent', { appendSystemPromptFile: "C:\\a b\\it's.md" }, cwd, env,
    { ...config, command: 'D:\\stand in\\codeagent.cmd' });
  assert.ok(spaced.cmd.startsWith(" & 'D:\\stand in\\codeagent.cmd' "), 'a configured path is invoked with the call operator');
  assert.ok(spaced.cmd.includes("--append-system-prompt-file 'C:\\a b\\it''s.md'"));
});

test('hook deployment for codeagent keeps foreign hooks and leaves status line and permissions alone', t => {
  const { configDir } = sandbox(t);
  fs.mkdirSync(configDir, { recursive: true });
  const foreign = { type: 'command', command: 'python "C:/Users/x/.cac/scripts/codeagent-hub-hook.py" stop', timeout: 5 };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' }, hooks: { Stop: [{ matcher: '', hooks: [foreign] }] },
  }));
  const { ensureManagedSettings } = require('../core/claude-hook-integration');
  const { HOOK_EVENTS } = require('../core/codeagent-config');
  const result = ensureManagedSettings(configDir, { logger: {}, events: HOOK_EVENTS, manageStatusLine: false, managePermissionMode: false });
  assert.deepEqual(result.errors, []);
  const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort(), 'only events verified on the CLI are registered');
  assert.ok(settings.hooks.Stop.some(group => group.hooks.includes(foreign) || group.hooks.some(h => h.command === foreign.command)),
    'the other tool\'s Stop hook is kept');
  assert.ok(settings.hooks.Stop.some(group => group.hooks.some(h => /session-hub-hook/.test(h.command))), 'Hub Stop hook added');
  assert.equal(settings.statusLine, undefined);
  assert.equal(settings.permissionMode, undefined);
  assert.equal(ensureManagedSettings(configDir, { logger: {}, events: HOOK_EVENTS, manageStatusLine: false, managePermissionMode: false }).changed, false,
    'idempotent');
});

test('project trust for codeagent writes .cac.json only when the CLI has initialized it', t => {
  const { configDir, cwd } = sandbox(t);
  const { ensureClaudeProjectTrusted } = require('../core/claude-project-trust');
  const options = { configDir, stateFileName: '.cac.json', logger: { warn() {}, log() {} } };
  assert.equal(ensureClaudeProjectTrusted(cwd, options).changed, false);
  assert.equal(fs.existsSync(path.join(configDir, '.cac.json')), false, 'never creates the CLI state file');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.cac.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
  assert.equal(ensureClaudeProjectTrusted(cwd, options).changed, true);
  const state = JSON.parse(fs.readFileSync(path.join(configDir, '.cac.json'), 'utf8'));
  assert.equal(state.projects[path.resolve(cwd).replace(/\\/g, '/')].hasTrustDialogAccepted, true);
  assert.equal(state.hasCompletedOnboarding, true);
});

test('screen samples from the real CLI: readiness, dialogs and running state', () => {
  const detector = require('../core/group-chat-cli-ready-detector');
  const { classifyTerminalRuntime } = require('../core/terminal-runtime-state');
  const update = '\n   🚀 版本更新提醒\n   > 确认，升级到最新稳定版\n     取消，退出\n   Select ↑ ↓ | Confirm Enter | 退出 Esc\n';
  const idleLines = [' │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │',
    ' │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                                    @  ✲  ↵  ▷   │'];
  assert.equal(detector.isChoiceDialogVisible('codeagent', update), true);
  assert.equal(detector.isChoiceDialogVisible('codeagent', update + idleLines.join('\n')), false);
  assert.equal(detector.isChoiceDialogVisible('claude', update), false, 'Claude rules are unchanged');
  assert.equal(classifyTerminalRuntime('codeagent', idleLines).state, 'idle');
  assert.equal(classifyTerminalRuntime('codeagent', ['  ⠋ Running…', ' │ > 补充指令（Enter 排队等待发送）...']).state, 'running');
});
