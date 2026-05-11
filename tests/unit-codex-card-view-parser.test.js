const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
} = require('../core/codex-transcript-parser');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');

async function main() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-card-parser-'));
  const cwd = path.join(os.tmpdir(), 'codex-card-project');
  const sid = '019eaaaa-bbbb-7ccc-8ddd-123456789abc';
  const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid });
  try {
    await fr.start();
    await fr.writeRaw({
      timestamp: '2026-05-10T09:59:58.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '# AGENTS.md instructions for C:\\Users\\lintian\n\n<INSTRUCTIONS>\n<!-- CAT-CAFE-GOVERNANCE-START -->\nsystem prompt text',
        }],
      },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T09:59:59.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first question' }],
      },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'first question' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'intermediate commentary' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: 'final answer one',
        duration_ms: 1234,
      },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:00:59.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:01:00.000Z',
      type: 'response_item',
      payload: { role: 'user', content: 'second question' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:01:01.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'partial answer two' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:02:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<image name=[Image #1]>\n\nthird question with image' }],
      },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:02:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'third question with image' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:02:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: 'final answer three',
        duration_ms: 456,
      },
    });
    await fr.close();

    assert.strictEqual(findCodexRolloutBySid(sid, tmpRoot), fr.rolloutPath);
    assert.strictEqual(
      findCodexRolloutByCwd(cwd, tmpRoot, { sinceMs: Date.now() - 10000 }),
      fr.rolloutPath,
    );

    const turns = parseCodexRolloutToTurns(fr.rolloutPath, { limit: 10, fromTail: true });
    assert.strictEqual(turns.length, 6);
    assert.deepStrictEqual(turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.strictEqual(turns[0].text, 'first question');
    assert.ok(!turns.some(t => t.text.includes('AGENTS.md instructions')), 'injected AGENTS prompt must not surface as a user turn');
    assert.strictEqual(turns[1].text, 'final answer one');
    assert.strictEqual(turns[1].stopReason, 'task_complete');
    assert.strictEqual(turns[1].durationMs, 1234);
    assert.strictEqual(turns[2].text, 'second question');
    assert.strictEqual(turns[3].text, 'partial answer two');
    assert.strictEqual(turns[3].stopReason, 'partial_commentary');
    assert.strictEqual(turns[4].text, 'third question with image');
    assert.ok(!turns.some(t => /^<image name=/.test(t.text)), 'image-only prompt marker must not create a duplicate user turn');
    assert.strictEqual(turns[5].text, 'final answer three');

    const tail = parseCodexRolloutToTurns(fr.rolloutPath, { limit: 2, fromTail: true });
    assert.deepStrictEqual(tail.map(t => t.text), ['third question with image', 'final answer three']);
  } finally {
    await fr.cleanup().catch(() => {});
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => {
  console.log('codex card view parser ok');
}).catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
