const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
// Windows 检出为 CRLF，下面有跨行的源码字面量断言，读入时统一归一化为 LF
const js = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

assert.ok(js.includes("_CARD_VIEW_MODE_KEY = 'mr-card-view-mode'"), 'card view mode is persisted');
assert.ok(js.includes('id="mr-btn-view-parallel"'), 'header renders parallel mode button');
assert.ok(js.includes('id="mr-btn-view-tab"'), 'header renders tab mode button');
assert.ok(!js.includes('id="mr-btn-density"'), 'old density button is removed from header');
assert.ok(js.includes('data-gc-card-tab-sid'), 'tab mode renders per-AI card tabs');
assert.ok(js.includes("_focusGroupChatSession(meeting, sid)"), 'card tab click switches focused AI');
assert.ok(js.includes('if (_isCardTabMode()) return;'), 'card body click is inert in tab mode');

assert.ok(css.includes('.mr-view-toggle'), 'header segmented view toggle is styled');
assert.ok(css.includes('.mr-card-view-tabs'), 'card tab bar is styled');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-strip .mr-ft:not(.active)'), 'tab mode hides inactive cards');
assert.ok(css.includes('grid-template-columns: minmax(0, 1fr)'), 'tab mode uses a single card column');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-head'), 'tab mode hides card header chrome');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-escape-bar'), 'tab mode hides card action bar');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-bottom'), 'tab mode gives preview the full card body');
assert.ok(css.includes('body.mr-card-tab-mode .mr-gc-timetravel-banner'), 'tab mode hides time-travel banner');
assert.ok(css.includes('body.mr-card-tab-mode .mr-gc-userq'), 'tab mode hides question banner');

assert.ok(!js.includes(['_GROUP', '_VIEW_MODE_KEY'].join('')), 'group chat no longer persists a second legacy view mode');
assert.ok(!js.includes('id="mr-btn-group-' + 'card-view"') && !js.includes('id="mr-btn-group-' + 'chat-view"'), 'group header exposes one unified conversation-card surface');
assert.ok(js.includes('if (meeting.groupChat) {\n      return _renderGroupChatView'), 'all group rooms render the unified conversation-card surface');
assert.ok(js.includes('data-gc-resend-turn') && js.includes('data-gc-edit-turn'), 'group user cards inherit resend and edit-resend actions');
assert.ok(js.includes('data-gc-retry-answer') && js.includes('data-gc-escape="resend-prompt"'), 'group assistant cards expose retry and stuck-input recovery');

console.log('meeting-room card view mode contract ok');
