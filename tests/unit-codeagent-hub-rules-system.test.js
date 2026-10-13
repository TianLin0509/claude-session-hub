'use strict';
// 2026-10-13 公司真机（CodeAgent 1.2615.02.01）实测 --append-system-prompt-file 生效：
// 「规则」页的通用规则对 CodeAgent 也在启动时写进系统提示，消息里不再随第一条消息送。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SessionManager } = require('../core/session-manager.js');
const { createHubRulesStore } = require('../core/hub-rules');

function withDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-rules-'));
  const old = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => {
    if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('新建会话时 CodeAgent 和 Claude 一样进「启动时写进系统提示」名单', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const line = source.split(/\r?\n/).find(l => l.includes('const hubRulesSystem = ('));
  assert.ok(line && /isCodeAgentKind\(kind\)/.test(line), line);
});

test('CodeAgent 原地重拉：按当前规则重写系统提示文件，启动命令带 --append-system-prompt-file', t => {
  const dataDir = withDataDir(t);
  const manager = new SessionManager();
  t.after(() => manager.dispose());
  const store = createHubRulesStore({ dataDir, loadPersonal: () => null });
  manager.memoryService = { hubRules: store };
  let command = '';
  manager.sessions.set('ca-1', {
    info: { id: 'ca-1', kind: 'codeagent', cwd: dataDir, currentModel: { id: 'GLM-5.2-WX-Auto' }, effort: 'low', mcpProfile: 'none' },
    pty: { write(value) { command += value; }, kill() {}, options: { env: { ...process.env } } },
    pendingTimers: new Set(),
  });
  assert.equal(manager.relaunchCli('ca-1'), true);
  const info = manager.sessions.get('ca-1').info;
  assert.match(info.hubRulesSystem.label, /通用规则 v\d+/);
  const flag = command.match(/--append-system-prompt-file (?:'([^']+)'|(\S+))/);
  assert.ok(flag, command);
  const file = flag[1] || flag[2];
  assert.ok(store.isSystemPromptFile(file), file);
  assert.match(fs.readFileSync(file, 'utf8'), /^以下是 AI Hub 默认带上的规则/);
  assert.doesNotMatch(command, /--session-id|--settings/, '身份绑定逻辑保持现状');

  store.setEnabled(false);
  command = '';
  assert.equal(manager.relaunchCli('ca-1'), true);
  assert.doesNotMatch(command, /--append-system-prompt-file/, '规则关掉后不带');
  assert.equal(manager.sessions.get('ca-1').info.hubRulesSystem, undefined);
});
