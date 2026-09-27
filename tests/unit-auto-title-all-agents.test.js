'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { ALL_AI_KINDS, KIND_LABELS, HARNESS_LABELS } = require('../core/ai-kinds');
const { isGenericAutoSessionTitle, isStableSessionTitle } = require('../core/session-title-guards');
const { createAutoTitleManager } = require('../main/auto-title-manager');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('every Agent default/resume title reaches DeepSeek; old false completion flags recover; user rename wins', async () => {
  const sessions = new Map();
  const requests = [];
  const original = https.request;
  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.write = body => { req.body = JSON.parse(body); };
    req.end = () => requests.push({ options, req, finish(title) {
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response);
      response.emit('data', JSON.stringify({ choices: [{ message: { content: title } }] }));
      response.emit('end');
    }});
    return req;
  };
  const manager = createAutoTitleManager({
    allAiKinds: ALL_AI_KINDS, kindLabels: KIND_LABELS,
    getHubConfig: () => ({ deepseekApiKey: 'test-key' }),
    sessionManager: {
      getSession: id => sessions.get(id), getAllSessions: () => [...sessions.values()],
      updateSessionMeta: (id, patch) => { const s = sessions.get(id); assert(s); Object.assign(s, patch); return s; },
    }, sendToRenderer() {}, meetingManager: {},
  });
  try {
    for (const kind of ALL_AI_KINDS) for (const resume of [false, true]) {
      const id = kind + (resume ? '-resume' : '');
      const title = HARNESS_LABELS[kind] || `${KIND_LABELS[kind]}${resume ? ' Resume' : ''} 1`;
      assert.equal(isGenericAutoSessionTitle(title), true, title);
      assert.equal(isStableSessionTitle(title), false, title);
      sessions.set(id, { id, kind: id, title, autoTitleGenerated: resume });
      manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: id, text: '核对网络迁移方案' });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests.length, ALL_AI_KINDS.length * 2);
    for (const request of requests) {
      assert.equal(request.options.hostname, 'api.deepseek.com');
      assert.equal(request.req.body.model, 'deepseek-chat');
      assert.equal(request.req.body.messages[1].content, '核对网络迁移方案');
      request.finish('网络迁移方案核对');
    }
    await tick();
    for (const s of sessions.values()) {
      assert.equal(s.title, '网络迁移方案核对'); assert.equal(s.autoTitleGenerated, true);
    }
    const s = { id: 'race', kind: 'qwen', title: HARNESS_LABELS.qwen };
    sessions.set(s.id, s);
    manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: s.id, text: '分析架构' });
    await new Promise(resolve => setTimeout(resolve, 20));
    s.title = '用户亲手起的名字'; s.userRenamed = true;
    requests.at(-1).finish('迟到的标题'); await tick();
    assert.equal(s.title, '用户亲手起的名字');
  } finally { https.request = original; }
});
