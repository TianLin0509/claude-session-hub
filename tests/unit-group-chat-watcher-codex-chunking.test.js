'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const watcher = require('../core/group-chat-watcher.js');

(async () => {
  const writes = [];
  const prompt = 'x'.repeat(9001);
  const sessionManager = {
    getSession() {
      return { cwd: tmpDir };
    },
    writeToSession(sid, data) {
      writes.push({ sid, data });
    },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prompt-file-'));

  const chunkedActualPrompt = await watcher._private.writePromptToSession(sessionManager, 'sid1', prompt, 'codex');
  assert.ok(writes.length > 1, 'large Codex prompt should be chunked');
  assert.strictEqual(writes.map(w => w.data).join(''), prompt, 'chunked writes must preserve prompt exactly');
  assert.strictEqual(chunkedActualPrompt, prompt, 'chunked Codex path should return the actual prompt recorded by Codex');

  writes.length = 0;
  const claudeActualPrompt = await watcher._private.writePromptToSession(sessionManager, 'sid2', prompt, 'claude');
  assert.strictEqual(writes.length, 1, 'Claude-family prompt path should remain a single write for bracketed paste caller');
  assert.strictEqual(writes[0].data, prompt);
  assert.strictEqual(claudeActualPrompt, prompt);

  writes.length = 0;
  const shortActualPrompt = await watcher._private.writePromptToSession(sessionManager, 'sid3', 'short prompt', 'codex');
  assert.deepStrictEqual(writes, [{ sid: 'sid3', data: 'short prompt' }], 'small Codex prompt should not be chunked');
  assert.strictEqual(shortActualPrompt, 'short prompt');

  writes.length = 0;
  const chinesePrompt = '请只回复：就位。';
  const pointerActualPrompt = await watcher._private.writePromptToSession(sessionManager, 'sid-cn', chinesePrompt, 'codex');
  assert.strictEqual(writes.length, 1, 'non-ASCII Codex prompt should be replaced by a file-pointer prompt');
  assert.match(writes[0].data, /UTF-8 group-chat prompt has been saved/);
  assert.match(writes[0].data, /Read that file, follow its instructions exactly/);
  assert.ok(!/[\r\n]/.test(writes[0].data), 'file-pointer prompt should be single-line so Codex retry clear/input detection stays reliable');
  assert.strictEqual(pointerActualPrompt, writes[0].data, 'non-ASCII Codex path should return the pointer text actually submitted to Codex');
  const fileMatch = writes[0].data.match(/([A-Z]:\\[^\r\n]+groupchat-[^\r\n]+\.md)/i);
  assert.ok(fileMatch, 'file-pointer prompt should include a Windows path to the UTF-8 prompt file');
  assert.strictEqual(fs.readFileSync(fileMatch[1], 'utf8'), chinesePrompt, 'prompt file should preserve Chinese text as UTF-8');

  writes.length = 0;
  assert.strictEqual(watcher._private.writeSubmitSignal(sessionManager, 'sid4', 'codex', 0), 'cr');
  assert.strictEqual(watcher._private.writeSubmitSignal(sessionManager, 'sid4', 'codex', 1), 'lf');
  assert.strictEqual(watcher._private.writeSubmitSignal(sessionManager, 'sid4', 'codex', 2), 'crlf');
  assert.deepStrictEqual(writes.map(w => w.data), ['\r', '\n', '\r\n'], 'Codex submit fallback should rotate CR/LF/CRLF');

  writes.length = 0;
  assert.strictEqual(watcher._private.writeSubmitSignal(sessionManager, 'sid5', 'claude', 2), 'cr');
  assert.deepStrictEqual(writes, [{ sid: 'sid5', data: '\r' }], 'non-Codex submit should stay CR-only');

  writes.length = 0;
  assert.strictEqual(await watcher._private.clearCodexInputLine(sessionManager, 'sid6', 'codex'), true);
  assert.deepStrictEqual(writes, [{ sid: 'sid6', data: '\x15' }], 'Codex rewrite should clear stale input with Ctrl+U');

  writes.length = 0;
  assert.strictEqual(await watcher._private.clearCodexInputLine(sessionManager, 'sid7', 'claude'), false);
  assert.deepStrictEqual(writes, [], 'non-Codex rewrite should not send Ctrl+U');

  console.log('Group-chat watcher Codex chunking: ok');
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
