'use strict';
// 2026-10-13 Hub 附带块挪到正文前面后，两处按「用户原话」比对/取字的地方必须先剥掉附带块：
//   1. Codex 原生记录里同一条消息有两份（response_item message + item_completed UserMessage），
//      卡片那份剥过、事件那份没剥，比不上就会出现两张一样的用户卡片（真实隔离 Hub e2e 抓到）；
//   2. 会话自动标题取第一句话，hook 上报的是整段原文，不剥就成了「Codex · ai-hub-rules ref=」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const RULES = '<ai-hub-rules ref="hubrules-1">\n以下是 AI Hub 默认带上的规则（通用规则 v1，可在 Hub 左侧「规则」页查看或关闭）。\n先给结论\n</ai-hub-rules>';
const QUESTION = '周报要不要改成双周？';

test('Codex 原生记录里同一条带规则的消息两份，只出一张用户卡片', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-envelope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = `${RULES}\n\n${QUESTION}`;
  const at = ms => new Date(Date.UTC(2026, 9, 13, 1, 8, 38) + ms).toISOString();
  const rows = [
    { timestamp: at(-4000), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: at(0), type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text }] } },
    { timestamp: at(2), type: 'event_msg', payload: { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', client_id: 'c1', content: [{ type: 'text', text, text_elements: [] }] }, started_at_ms: Date.parse(at(2)), completed_at_ms: Date.parse(at(2)) } },
    { timestamp: at(2000), type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: '📌 **先保持每周五。**' }], phase: 'final_answer' } },
    { timestamp: at(2600), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '📌 **先保持每周五。**' } },
  ];
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const turns = require('../core/codex-transcript-parser').parseCodexRolloutToTurns(file, { limit: Infinity });
  const users = turns.filter(x => x.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, QUESTION);
  assert.equal(users[0].hubAttached.length, 1);
  const { userTextIdentity } = require('../core/conversation-display');
  assert.equal(userTextIdentity(text), userTextIdentity(QUESTION));
});

test('自动标题只取用户自己的话', async () => {
  const sessions = new Map([['s1', { id: 's1', kind: 'codex', title: 'Codex 1', status: 'idle', cwd: 'C:\\scratch' }]]);
  const manager = require('../main/auto-title-manager.js').createAutoTitleManager({
    allAiKinds: ['codex'], getHubConfig: () => ({ deepseekApiKey: '' }), kindLabels: { codex: 'Codex' },
    sessionManager: { getSession: id => sessions.get(id), getAllSessions: () => [...sessions.values()],
      updateSessionMeta: (id, patch) => { const next = { ...sessions.get(id), ...patch }; sessions.set(id, next); return next; } },
    meetingManager: { getMeeting: () => null, updateMeeting: () => null },
    workspaceService: { updateSuggestedName: cwd => ({ path: cwd }) },
    sendToRenderer: () => {},
  });
  manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: 's1', text: `${RULES}\n\n${QUESTION}` });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sessions.get('s1').title, `Codex · ${QUESTION}`);
});
