'use strict';
// Inspect only public tool outputs, never reasoning records. A host read receipt
// alone does not prove the native model received the complete snapshot.
function frozenSnapshotOutputs(records, requestToken) {
  const found = [];
  function visit(value) {
    if (typeof value === 'string') {
      try { visit(JSON.parse(value)); } catch { /* framing text or truncated JSON */ }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'frozen-snapshot' && value.snapshotReceipt?.requestToken === requestToken) {
      found.push(value); return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  for (const row of records) {
    if (row.type !== 'response_item') continue;
    if (!['custom_tool_call_output', 'function_call_output'].includes(row.payload?.type)) continue;
    visit(row.payload.output);
  }
  return found;
}
module.exports = { frozenSnapshotOutputs };
