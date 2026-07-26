'use strict';

const assert = require('assert');
const { createAutoTitleManager } = require('../main/auto-title-manager.js');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const events = [];
  const sessions = new Map([
    ['s1', { id: 's1', kind: 'codex', title: 'Codex 1', status: 'idle', cwd: 'C:\\scratch-session' }],
  ]);
  const meetings = new Map([
    ['m1', { id: 'm1', title: 'AI 群聊 #1', groupChat: true, autoTitlePending: true, workspace: 'C:\\scratch-meeting' }],
  ]);
  const workspaceNames = [];

  const manager = createAutoTitleManager({
    allAiKinds: ['codex', 'gemini'],
    getHubConfig: () => ({ deepseekApiKey: '' }),
    kindLabels: { codex: 'Codex', gemini: 'Gemini' },
    sessionManager: {
      getSession: (id) => sessions.get(id),
      updateSessionMeta: (id, patch) => {
        const next = { ...sessions.get(id), ...patch };
        sessions.set(id, next);
        return next;
      },
    },
    meetingManager: {
      getMeeting: (id) => meetings.get(id),
      updateMeeting: (id, patch) => {
        const next = { ...meetings.get(id), ...patch };
        meetings.set(id, next);
        return next;
      },
    },
    workspaceService: {
      updateSuggestedName: (cwd, title) => {
        workspaceNames.push({ cwd, title });
        return { path: cwd, label: title };
      },
    },
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
  });

  assert.strictEqual(manager.fallbackSessionTitleFromPrompt('请帮我分析这个 repo 的结构', 'codex'),
    'Codex · 请帮我分析这个 repo 的结构',
    'session fallback should preserve provider label and trim prompt text');

  assert.strictEqual(manager.isGenericAutoSessionTitle('Codex 12'), true,
    'default session titles should be eligible for auto-title');
  assert.strictEqual(manager.isGenericAutoSessionTitle('用户已命名'), false,
    'custom session titles should not be overwritten');

  manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: 's1', text: '请帮我分析这个 repo 的结构' });
  await delay(20);
  assert.strictEqual(sessions.get('s1').autoTitleGenerated, true,
    'eligible session should be marked as auto titled');
  assert.strictEqual(events.some(e => e.channel === 'session-updated'), true,
    'session auto-title should notify renderer');
  assert.strictEqual(sessions.get('s1').workspaceLabel, sessions.get('s1').title,
    'session workspace display label should follow the first-prompt title without moving cwd');

  manager.maybeAutoTitleMeetingFromPrompt('m1', '讨论下一轮重构计划');
  await delay(20);
  assert.strictEqual(meetings.get('m1').autoTitleGenerated, true,
    'eligible meeting should be marked as auto titled');
  assert.strictEqual(meetings.get('m1').autoTitlePending, false,
    'meeting auto-title should clear pending flag');
  assert.strictEqual(events.some(e => e.channel === 'meeting-updated'), true,
    'meeting auto-title should notify renderer');
  assert.strictEqual(meetings.get('m1').workspaceLabel, meetings.get('m1').title,
    'meeting workspace display label should follow the first-prompt title');
  assert.strictEqual(workspaceNames.length, 2,
    'both session and meeting workspace registries should receive the generated name');

  console.log('Auto title manager contract: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
