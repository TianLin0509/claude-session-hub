'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
const room = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const dispatcher = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

assert.ok(room.includes("require('./groupchat-event-revision.js')")
  && renderer.includes("require('./groupchat-event-revision.js')"),
'meeting cards and sidebar must share the revision gate');
assert.ok(room.includes("ipcRenderer.on('groupchat-attempt-changed'")
  && renderer.includes("ipcRenderer.on('groupchat-attempt-changed'"),
'both projections must consume the same canonical attempt event');
assert.ok(dispatcher.includes("sendToRenderer('groupchat-attempt-changed'")
  && dispatcher.includes('attemptIdsBySid'),
'dispatcher must publish attempt-scoped lifecycle state');
assert.ok(room.includes('awaiting_binding')
  && room.includes('awaiting_final_text')
  && room.includes('不会自动重复发送 Prompt'),
'UI must distinguish binding/final-text reconciliation from ordinary thinking');
assert.ok(room.includes('data-gc-attempt-details')
  && room.includes('本轮运行证据')
  && css.includes('.mr-gc-attempt-btn'),
'each attempt should expose its bounded evidence timeline');
assert.ok(room.includes('quota_exceeded')
  && room.includes('network_interrupted')
  && room.includes('额度恢复或切换账号后可只重试本家'),
'quota and network failures must have actionable member-scoped wording');
assert.ok(renderer.includes("truth.state !== RUNTIME_FAILED"),
  'groupchat turn completion must not overwrite a member-scoped failure with completed');

console.log('groupchat attempt UI contract: ok');
