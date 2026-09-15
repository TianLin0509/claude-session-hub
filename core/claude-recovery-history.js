'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

// Inspect exact native identity after the old writer has exited. Receipt/history
// evidence is not a completion signal and must never advance a workflow.
async function inspect(session, records) {
  const file = session.historyPath();
  const evidence = new Map(records.map(r => [r.userMessageId, file ? 'not-found' : 'history-missing']));
  if (!file || !records.length) return evidence;
  const expected = new Map(records.filter(r => !r.nativeActivity).map(r => [r.userMessageId, r]));
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const record = expected.get(row.uuid);
      if (!record || row.type !== 'user') continue;
      if ((row.sessionId && row.sessionId !== session.sessionId)
          || (row.session_id && row.session_id !== session.sessionId)
          || !session.echoMatches(row, { ...record, fingerprint: record.promptFingerprint })) throw new Error('原生历史与旧消息身份不一致，未发送');
      evidence.set(row.uuid, 'received');
    }
  } finally { lines.close(); input.destroy(); }
  return evidence;
}
module.exports = { inspect };
