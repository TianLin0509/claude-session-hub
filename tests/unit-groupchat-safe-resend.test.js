'use strict';

const assert = require('node:assert');
const groupChatWatcher = require('../core/group-chat-watcher.js');

const writes = [];
let buffer = '› ready\nContext 90% left';
const sessionManager = {
  getSession: () => ({ kind: 'codex', transcriptKind: 'codex' }),
  getSessionBuffer: () => buffer,
  getGroupChatLastActivity: () => 1,
  writeToSession: (_sid, data) => writes.push(data),
};
groupChatWatcher.init({
  sessionManager,
  cliReadyDetector: {},
  transcriptTap: { notePrompt() {} },
});

(async () => {
  const state = groupChatWatcher.inspectPromptSubmissionState({
    sid: 's1', kind: 'codex', promptHeader: 'DO THE THING',
  });
  assert.notStrictEqual(state.state, 'input_pending');
  const refused = await groupChatWatcher.resendCurrentPrompt({
    sid: 's1', kind: 'codex', prompt: 'DO THE THING\nfull body',
    promptHeader: 'DO THE THING', allowRewrite: false,
  });
  assert.deepStrictEqual(refused, { ok: false, mode: 'none', reason: 'rewrite_not_authorized' });
  assert.deepStrictEqual(writes, [], 'uncertain recovery must never rewrite or press Enter automatically');

  buffer = '› [Pasted Content 1234 chars]';
  const pending = groupChatWatcher.inspectPromptSubmissionState({
    sid: 's1', kind: 'codex', promptHeader: 'DO THE THING',
  });
  assert.strictEqual(pending.state, 'possible_input_pending');

  console.log('groupchat safe resend: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
