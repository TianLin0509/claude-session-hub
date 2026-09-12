'use strict';
const { ClaudeNativeSession } = require('../core/claude-native-session');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const session = new ClaudeNativeSession({ id: 'quiet-check', executable: process.execPath,
    commandArgs: [path.resolve(__dirname, 'fixtures/claude-stream.js'), '--fixture=hold'] });
  try {
    await session.submit('quiet for 61 seconds', { clientSubmissionId: 'quiet' });
    const began = Date.now();
    await new Promise(resolve => setTimeout(resolve, 61000));
    if (session.records.get('quiet').status !== 'accepted' || session.runtime.state !== 'starting') {
      throw new Error('Silent turn falsely settled');
    }
    const result = new Promise(resolve => session.on('lifecycle', event => {
      if (event.type === 'agent-turn-complete') resolve(event);
    }));
    await session.interrupt();
    if ((await result).status !== 'interrupted') throw new Error('Interruption not confirmed');
    const output = path.resolve(__dirname, '../artifacts/native-agent', 'quiet-' + Date.now() + '.json');
    fs.writeFileSync(output, JSON.stringify({ pass: true, elapsedMs: Date.now() - began,
      source: 'controlled-pipe', state: session.runtime.state }, null, 2), 'utf8');
    console.log(output);
  } finally { await session.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
