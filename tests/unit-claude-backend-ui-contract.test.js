'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'config-modal.js'), 'utf8');

assert.match(html, /id="cfg-claude-backend"/);
assert.match(html, /当前订阅 \/ Claude Code 登录（默认）/);
assert.match(html, /同事中转 \/ Fable 5 · 1M/);
assert.match(html, /id="cfg-status-claude"/);
assert.match(html, /placeholder="claude-fable-5"/);
assert.match(html, /中转参数已保存备用；当前订阅模式不会读取或发送中转 Key/);

assert.match(controller, /DEFAULT_CLAUDE_FABLE_MODEL = 'claude-fable-5'/);
assert.match(controller, /updateClaudeBackendControls/);
assert.doesNotMatch(controller, /璁㈤槄|缂\?Key/);

console.log('unit-claude-backend-ui-contract OK');
