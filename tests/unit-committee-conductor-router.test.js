'use strict';

const assert = require('assert');
const { createCommitteeConductor } = require('../main/groupchat/committee-conductor.js');

async function main() {
  const sessions = {
    fund: { id: 'fund', kind: 'deepseek', status: 'active' },
    news: { id: 'news', kind: 'claude', status: 'active' },
    tech: { id: 'tech', kind: 'codex', status: 'active' },
    challenger: { id: 'challenger', kind: 'codex', status: 'active' },
    chair: { id: 'chair', kind: 'claude', status: 'active' },
  };
  const dispatchCalls = [];
  const conductor = createCommitteeConductor({
    dispatchGroupChatTurn: async (meetingId, args) => {
      dispatchCalls.push([meetingId, args]);
      return {
        status: 'completed',
        results: [{
          sid: 'chair',
          text: JSON.stringify({
            intent: 'single_stock',
            mode: 'quick',
            symbols: [{ name: '赛力斯', symbol: '601127' }],
            needs_clarification: false,
          }),
        }],
      };
    },
    meetingManager: {
      getMeeting: () => ({
        scene: 'committee',
        groupChat: true,
        subSessions: ['fund', 'news', 'tech', 'challenger', 'chair'],
      }),
    },
    sessionManager: { getSession: sid => sessions[sid] || null },
    logger: { log() {}, warn() {}, error() {} },
    sendToRenderer() {},
  });

  const isCommand = await conductor.isCommitteeCommand('m-router', '赛力斯怎么样');
  assert.strictEqual(isCommand, true);
  assert.strictEqual(dispatchCalls.length, 0, 'high-confidence Chinese stock name must not block on chair router');

  const route = await conductor._resolveCommitteeRoute('m-router', '赛力斯怎么样', { allowLlm: false });
  assert.strictEqual(route.intent, 'single_stock');
  assert.strictEqual(route.source, 'deterministic');
  assert.strictEqual(route.symbols[0].symbol, '601127');

  const llmCommand = await conductor.isCommitteeCommand('m-router-llm', '请用投委会分析我说的那个核心标的');
  assert.strictEqual(llmCommand, true);
  assert.strictEqual(dispatchCalls.length, 1);
  assert.strictEqual(dispatchCalls[0][1].silent, true);
  assert.deepStrictEqual(dispatchCalls[0][1].targetMemberIds, ['m5']);
  assert.ok(dispatchCalls[0][1].userInput.includes('投委会 · 立项路由'));

  const llmRoute = await conductor._resolveCommitteeRoute('m-router-llm', '请用投委会分析我说的那个核心标的', { allowLlm: false });
  assert.strictEqual(llmRoute.intent, 'single_stock');
  assert.strictEqual(llmRoute.source, 'llm');
  assert.strictEqual(llmRoute.symbols[0].symbol, '601127');

  console.log('Committee conductor router: ok');
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
