'use strict';
// 公司版群聊与自用版拉齐（2026-10-14 同事反馈「加入群聊」不行、没有编排员）。
// CodeAgent 是 Claude 家族，下面这些功能的底层都已支持，只是被写死的类型名单挡在外面。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}

test('加入群聊 / 以会话新建群聊 / 分支群聊：CodeAgent 与 DeepSeek on Claude Code 可分支进群', () => {
  const { GROUP_FORKABLE_KINDS } = require('../main/ipc/groupchat-fork-handlers');
  for (const kind of ['codeagent', 'deepseek-claude', 'claude', 'codex']) assert.ok(GROUP_FORKABLE_KINDS.has(kind), kind);
  const { planSessionFork } = require('../core/session-fork-plan');
  const plan = planSessionFork({ source: { id: 'h1', kind: 'codeagent', cwd: 'D:/w', ccSessionId: '0b0c5b8e-1d3e-4c39-9d7b-2f1a5c6d7e8f', effort: 'high' } });
  assert.strictEqual(plan.ok, true, plan.message);
  assert.strictEqual(plan.kind, 'codeagent', '分支仍是 CodeAgent，不会变成 Claude');
  assert.strictEqual(plan.opts.forkCCSessionId, '0b0c5b8e-1d3e-4c39-9d7b-2f1a5c6d7e8f');
});

test('编排员：建群弹窗允许成员 1 选 CodeAgent', () => {
  const modal = fs.readFileSync(path.join(root, 'renderer', 'meeting-create-modal.js'), 'utf8');
  assert.match(modal, /const ORCHESTRATOR_KINDS = \['claude', 'codex', 'codeagent'\];/);
  assert.match(modal, /mcm-orch-row" id="mcm-orch-row"\$\{ORCHESTRATOR_KINDS\.some\(require\('\.\.\/core\/distribution'\)\.kindAllowed\)/,
    '公司版只允许 CodeAgent 时，编排员开关因此显示出来');
});

test('编排员工具在安装版能启动：导出包带工具脚本，用 Hub 自己的程序当 Node 跑', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'community', 'manifest.json'), 'utf8'));
  assert.ok(manifest.include.includes('scripts/orchestrator-mcp.js'), '社区/公司版导出包含编排员工具脚本');
  const service = fs.readFileSync(path.join(root, 'main', 'orchestration', 'service.js'), 'utf8');
  assert.match(service, /nodeExecutable = process\.versions\.electron \? process\.execPath : 'node'/);
  assert.match(service, /env: \{ \.\.\.runAsNode, HUB_ORCH_ENDPOINT_FILE/);
  const tool = fs.readFileSync(path.join(root, 'scripts', 'orchestrator-mcp.js'), 'utf8');
  const deps = [...tool.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.ok(deps.every(d => d.startsWith('node:')), `工具脚本只用 Node 内置模块，单独带上即可运行（${deps.join(', ')}）`);
});

test('建群时保留 CodeAgent 成员的思考强度（只认它有的 low/medium/high/max）', () => {
  const { sanitizeMeetingSlot } = require('../main/ipc/meeting-create-handlers');
  assert.strictEqual(sanitizeMeetingSlot({ kind: 'codeagent', model: 'MiniMax-M2.7', effort: 'high' }, 0).effort, 'high');
  assert.strictEqual(sanitizeMeetingSlot({ kind: 'codeagent', effort: 'max' }, 0).effort, 'max');
  assert.strictEqual(sanitizeMeetingSlot({ kind: 'codeagent', effort: 'xhigh' }, 0).effort, undefined, 'CodeAgent 没有 xhigh');
});

test('群聊输入框的思考强度标签：CodeAgent 显示所选档，没选不冒充 max', () => {
  const { sessionEffortLabel } = require('../core/session-status-summary');
  assert.strictEqual(sessionEffortLabel({ kind: 'codeagent', effort: 'high' }), 'high');
  assert.strictEqual(sessionEffortLabel({ kind: 'codeagent' }), '');
  assert.strictEqual(sessionEffortLabel({ kind: 'claude' }), 'max', 'Claude 照旧');
});

test('Hub 重启后续作：Claude 家族（含 CodeAgent）的 PTY 会话放行', () => {
  const handlers = fs.readFileSync(path.join(root, 'main', 'ipc', 'hub-restart-handlers.js'), 'utf8');
  assert.match(handlers, /base === 'codex' \|\| require\('\.\.\/\.\.\/core\/ai-kinds'\)\.isClaudeFamily\(base\)/);
  const { isClaudeFamily } = require('../core/ai-kinds');
  for (const kind of ['codeagent', 'deepseek-claude', 'claude']) assert.ok(isClaudeFamily(kind), kind);
});

if (failed) { console.error(`unit-codeagent-group-parity: ${failed} failed`); process.exit(1); }
console.log('unit-codeagent-group-parity: all passed');
