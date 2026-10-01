'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { frozenSnapshotOutputs } = require('./helpers/assistant-native-evidence');
const snapshot = { kind: 'frozen-snapshot', packet: { sources: [{ text: '完整正文' }] }, snapshotReceipt: { requestToken: 'round-a' } };
test('extracts complete nested code-mode MCP output and binds the request token', () => {
  const records = [{ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(snapshot) }] }) }] } }];
  assert.deepEqual(frozenSnapshotOutputs(records, 'round-a'), [snapshot]);
  assert.deepEqual(frozenSnapshotOutputs(records, 'round-b'), []);
});
test('rejects truncated outputs and ignores user text or reasoning objects', () => {
  const records = [{ type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify(snapshot).slice(0, -2) } },
    { type: 'response_item', payload: { role: 'user', output: snapshot } },
    { type: 'response_item', payload: { type: 'reasoning', output: snapshot } }];
  assert.deepEqual(frozenSnapshotOutputs(records, 'round-a'), []);
});
