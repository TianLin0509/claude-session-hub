'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scenes = require('../core/group-chat-scenes.js');
const { buildSystemPromptText } = require('../core/group-chat-orchestrator.js');

const ROOT = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(ROOT, 'core', 'research-mcp-server.js');
const CHUXIN_DIR = path.join(os.homedir(), 'chuxin-research');

const scopeTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chuxin-scope-'));
const codexScoped = scenes.buildResearchMcpEntryForCodex(
  'research-room', 3456, 'token', scopeTemp, { enableChuxin: true },
);
const codexUnscoped = scenes.buildResearchMcpEntryForCodex('native-session', 3456, 'token', scopeTemp);
assert.strictEqual(codexScoped.env.ARENA_CHUXIN_ENABLED, '1');
assert.strictEqual(codexUnscoped.env.ARENA_CHUXIN_ENABLED, undefined);
const claudeConfigPath = scenes.writeResearchMcpConfig(
  scopeTemp, 'research-room', 3456, 'token', 'claude', { enableChuxin: true },
);
const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
assert.strictEqual(claudeConfig.mcpServers['arena-research'].env.ARENA_CHUXIN_ENABLED, '1');
const researchPrompt = buildSystemPromptText('Codex', 'research', { workspace: scopeTemp });
const generalPrompt = buildSystemPromptText('Codex', 'general', { workspace: scopeTemp });
assert.match(researchPrompt, /chuxin_context/);
assert.match(researchPrompt, /禁止自动保存普通对话/);
assert.doesNotMatch(generalPrompt, /chuxin_context|chuxin_portfolio_history|chuxin_inbox_add/);

function callServer(requests, env = {}) {
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    cwd: ROOT,
    input: `${requests.map((value) => JSON.stringify(value)).join('\n')}\n`,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CHUXIN_DIR, ...env },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const disabledTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chuxin-disabled-'));
const disabled = callServer([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chuxin_context', arguments: { topic: '当前持仓' } } },
], { CHUXIN_KNOWLEDGE_ROOT: disabledTemp });
assert.deepStrictEqual(disabled.find((value) => value.id === 2).result.tools, []);
assert.match(disabled.find((value) => value.id === 3).error.message, /stub mode/);
assert.strictEqual(fs.readdirSync(disabledTemp).length, 0, '非投研群聊不得读取或初始化初心知识库');

const nativeTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chuxin-native-'));
const nativeUnscoped = callServer([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
], {
  CHUXIN_KNOWLEDGE_ROOT: nativeTemp,
  ARENA_MEETING_ID: 'non-research-session',
  ARENA_HUB_PORT: '9',
  ARENA_HOOK_TOKEN: 'test-token',
});
assert.deepStrictEqual(
  nativeUnscoped.find((value) => value.id === 2).result.tools
    .filter((tool) => tool.name.startsWith('chuxin_')),
  [],
);
assert.strictEqual(fs.readdirSync(nativeTemp).length, 0, '非投研场景即使挂有 research MCP 也不得加载初心');

const enabledTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chuxin-enabled-'));
const enabled = callServer([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chuxin_context', arguments: { topic: '688008 澜起科技' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chuxin_inbox_add', arguments: { title: '测试胶囊', content: '只写入收件箱，不修改任何正式知识。', source: 'unit test' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'chuxin_portfolio_history', arguments: { symbol: '688008', limit: 5 } } },
], {
  CHUXIN_KNOWLEDGE_ROOT: enabledTemp,
  ARENA_CHUXIN_ENABLED: '1',
  ARENA_MEETING_ID: 'research-meeting-test',
  ARENA_HUB_PORT: '9',
  ARENA_HOOK_TOKEN: 'test-token',
  ARENA_AI_KIND: 'codex',
});
const chuxinTools = enabled.find((value) => value.id === 2).result.tools
  .map((tool) => tool.name).filter((name) => name.startsWith('chuxin_')).sort();
assert.deepStrictEqual(chuxinTools, ['chuxin_context', 'chuxin_inbox_add', 'chuxin_portfolio_history']);
assert.match(enabled.find((value) => value.id === 3).result.content[0].text, /初心个人上下文/);
assert.match(enabled.find((value) => value.id === 4).result.content[0].text, /只写入收件箱|未修改/);
assert.match(enabled.find((value) => value.id === 5).result.content[0].text, /尚无持仓历史快照/);
assert.ok(fs.existsSync(path.join(enabledTemp, '投资手册.md')));
assert.strictEqual(fs.readdirSync(path.join(enabledTemp, '收件箱')).filter((name) => name.endsWith('.md')).length, 1);
assert.strictEqual(fs.readdirSync(path.join(enabledTemp, '个股')).length, 0);

console.log('  OK Chuxin tools are private to explicitly enabled research group MCP');
