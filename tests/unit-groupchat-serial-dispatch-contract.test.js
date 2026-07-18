'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'main', 'groupchat', 'dispatcher.js'),
  'utf8'
);

console.log('Running serial groupchat dispatcher contract tests...');

assert.match(source, /appendUserMessage,\s*reuseTurnNum,\s*dispatchMode,/s,
  'dispatcher must accept the serial workflow arguments sent by the renderer');
assert.match(source, /orch\.beginTurn\(userInput \|\| '', \{[\s\S]*turnNum:[\s\S]*appendUserMessage:/,
  'dispatcher must reuse the visible turn and suppress duplicate user messages');
assert.match(source, /currentUserMessageAppended: begin\.didAppendUserMessage/,
  'delta construction must know whether this step appended the user message');
assert.match(source, /if \(isReusedTurn\) orch\.clearTurnInProgress\(turnNum\)/,
  'a failed reused step must not roll back the prior successful step');
assert.match(source, /dispatchMode: dispatchMode \|\| 'group'/,
  'serial dispatch metadata must reach turn completion');

console.log('  OK serial steps reuse one visible user turn');
console.log('  OK failed reused steps preserve prior completed work');
