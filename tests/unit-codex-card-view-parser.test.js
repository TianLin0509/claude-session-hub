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
  let fr147 = null;
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
      timestamp: '2026-05-10T09:59:59.250Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
      },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T09:59:59.500Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>',
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
    assert.ok(!turns.some(t => t.text.includes('continued from a previous conversation')), 'compact summaries must not surface as user turns');
    assert.ok(!turns.some(t => t.text.includes('local-command-caveat')), 'local command caveats must not surface as user turns');
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

    await fr.writeRaw({
      timestamp: '2026-05-10T10:02:30.000Z',
      type: 'noise',
      payload: { blob: 'x'.repeat(9 * 1024 * 1024) },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:03:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'tail window question' },
    });
    await fr.writeRaw({
      timestamp: '2026-05-10T10:03:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: 'tail window answer',
        duration_ms: 789,
      },
    });
    await fr.close();

    const largeTail = parseCodexRolloutToTurns(fr.rolloutPath, { limit: 2, fromTail: true });
    assert.deepStrictEqual(
      largeTail.map(t => t.text),
      ['tail window question', 'tail window answer'],
      'large rollout parsing should use the tail window and still render the latest cards',
    );

    const goalObjective = '验证 /goal 自动命名与卡片中间输出';
    fr147 = new FakeCodexRollout({
      sessionsRoot: tmpRoot,
      cwd: `${cwd}-0147`,
      sid: '019effff-0147-7000-8000-000000000147',
      startAt: new Date('2026-08-20T03:46:00.000Z'),
      cliVersion: '0.147.0',
    });
    await fr147.start();
    await fr147.writeRaw({
      timestamp: '2026-08-20T03:46:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'thread_goal_updated',
        threadId: fr147.sid,
        goal: { threadId: fr147.sid, objective: goalObjective, status: 'active' },
      },
    });
    await fr147.writeRaw({
      timestamp: '2026-08-20T03:46:01.100Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-goal-0147' },
    });
    await fr147.writeRaw({
      timestamp: '2026-08-20T03:46:01.200Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `<codex_internal_context source="goal">\n<objective>${goalObjective}</objective>\n</codex_internal_context>`,
        }],
      },
    });
    for (const [offset, message] of [[300, '第一条中间进度'], [400, '第二条中间进度']]) {
      await fr147.writeRaw({
        timestamp: new Date(Date.parse('2026-08-20T03:46:01.000Z') + offset).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-goal-0147',
          item: {
            type: 'AgentMessage',
            id: `commentary-${offset}`,
            content: [{ type: 'text', text: message }],
            phase: 'commentary',
          },
          started_at_ms: Date.parse('2026-08-20T03:46:01.000Z') + offset - 50,
          completed_at_ms: Date.parse('2026-08-20T03:46:01.000Z') + offset,
        },
      });
    }

    const partial147 = parseCodexRolloutToTurns(fr147.rolloutPath);
    assert.deepStrictEqual(partial147.map(t => t.role), ['user', 'assistant']);
    assert.equal(partial147[0].text, goalObjective, 'goal card must show the objective, not the injected wrapper');
    assert.equal(partial147[1].text, '第一条中间进度\n\n第二条中间进度');
    assert.equal(partial147[1].stopReason, 'partial_commentary');
    assert.ok(!partial147.some(t => t.text.includes('codex_internal_context')),
      'injected /goal execution wrapper must stay hidden');

    await fr147.writeRaw({
      timestamp: '2026-08-20T03:46:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-goal-0147',
        item: {
          type: 'AgentMessage',
          id: 'final-goal-0147',
          content: [{ type: 'text', text: '0.147 最终回答' }],
          phase: 'final_answer',
        },
        started_at_ms: Date.parse('2026-08-20T03:46:01.500Z'),
        completed_at_ms: Date.parse('2026-08-20T03:46:02.000Z'),
      },
    });
    await fr147.close();
    const final147 = parseCodexRolloutToTurns(fr147.rolloutPath);
    assert.deepStrictEqual(final147.map(t => t.text), [goalObjective, '0.147 最终回答']);
    assert.equal(final147[1].stopReason, 'task_complete');
    assert.equal(final147[1].durationMs, 500);
  } finally {
    if (fr147) await fr147.cleanup().catch(() => {});
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
