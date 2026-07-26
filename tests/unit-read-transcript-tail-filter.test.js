const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTranscriptTail } = require('../core/session-manager.js');

async function main() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'read-tail-filter-'));
  try {
    const claudePath = path.join(dir, 'claude.jsonl');
    fs.writeFileSync(claudePath, [
      JSON.stringify({
        type: 'user',
        message: { content: 'real question' },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: '<task-notification><task-id>b1bwbajl9</task-id><summary>Background command "x" completed (exit code 0)</summary></task-notification>' },
        origin: { kind: 'task-notification' },
        promptSource: 'system',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'real answer' }] },
      }),
    ].join('\n') + '\n', 'utf8');

    const claudeTail = await readTranscriptTail('claude', claudePath, 10);
    assert.ok(claudeTail.includes('USER: real question'));
    assert.ok(claudeTail.includes('ASSISTANT: real answer'));
    assert.ok(!claudeTail.includes('b1bwbajl9'));
    assert.ok(!claudeTail.includes('task-notification'));

    const codexPath = path.join(dir, 'codex.jsonl');
    fs.writeFileSync(codexPath, [
      JSON.stringify({
        type: 'response_item',
        payload: { role: 'user', content: 'real codex question' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'real codex answer' },
      }),
    ].join('\n') + '\n', 'utf8');

    const codexTail = await readTranscriptTail('codex', codexPath, 10);
    assert.ok(codexTail.includes('USER: real codex question'));
    assert.ok(codexTail.includes('ASSISTANT: real codex answer'));
    assert.ok(!codexTail.includes('continued from a previous conversation'));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('read transcript tail synthetic user filter ok');
}).catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
