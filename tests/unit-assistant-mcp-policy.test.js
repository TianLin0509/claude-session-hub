'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolApprovalEntries, toolPolicyEntries } = require('../core/codex-mcp-tool-policy');
const { buildCodexEphemeralMcpArgs, buildNativeCodexOptions } = require('../core/session-manager')._private;
test('scoped MCP tool approval survives PTY and native launch without broad defaults', () => {
  const entry = { name: 'hub_assistant', command: 'node', args: ['assistant-mcp.js'], toolApprovalModes: { create_session: 'approve', list_sessions: 'approve' }, toolOutputTokenLimits: { list_sessions: 50000 } };
  const pty = buildCodexEphemeralMcpArgs([entry]);
  assert(pty.includes("mcp_servers.hub_assistant.tools.create_session.approval_mode='approve'"));
  assert(!pty.includes('default_tools_approval_mode'));
  assert(pty.includes('mcp_servers.hub_assistant.tools.list_sessions.output_token_limit=50000'));
  assert.deepEqual(toolPolicyEntries(entry).find(([name])=>name==='list_sessions')[1], { approval_mode: 'approve', output_token_limit: 50000 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-policy-'));
  const info = { kind: 'codex', cwd: home, currentModel: { id: 'gpt-6-astra' }, effort: 'high', mcpProfile: 'lean', codexSpeedTier: 'inherit' };
  const options = buildNativeCodexOptions(info, { codexMcpEntries: [entry], sandbox: 'read-only' }, { CODEX_HOME: home });
  assert(options.processArgs.includes('mcp_servers.hub_assistant.tools.create_session.approval_mode="approve"'));
  assert(options.processArgs.includes('mcp_servers.hub_assistant.tools.list_sessions.output_token_limit=50000'));
  assert.equal(options.threadParams.sandbox, 'read-only');
  assert.equal(options.threadParams.approvalPolicy, 'never');
  const none = buildNativeCodexOptions({ ...info, mcpProfile: 'none' }, { codexMcpEntries: [entry] }, { CODEX_HOME: home });
  assert(!none.processArgs.some(x => x.includes('approval_mode')));
});
test('tool approval rejects malformed names and values', () => {
  assert.deepEqual(toolApprovalEntries({}), []);
  for (const toolApprovalModes of [{ 'create_session.enabled': 'approve' }, { create_session: 'anything' }, [], 'approve']) {
    assert.throws(() => toolApprovalEntries({ toolApprovalModes }), /审批配置无效/);
  }
  for (const toolOutputTokenLimits of [{ 'history_context.extra': 50000 }, { history_context: 0 }, { history_context: 1.5 }, { history_context: '50000' }, []]) {
    assert.throws(() => toolPolicyEntries({ toolOutputTokenLimits }), /输出预算无效/);
  }
});
