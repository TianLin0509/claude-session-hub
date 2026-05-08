const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.css'), 'utf8');

assert.ok(js.includes("_CARD_VIEW_MODE_KEY = 'mr-card-view-mode'"), 'card view mode is persisted');
assert.ok(js.includes('id="mr-btn-view-parallel"'), 'header renders parallel mode button');
assert.ok(js.includes('id="mr-btn-view-tab"'), 'header renders tab mode button');
assert.ok(!js.includes('id="mr-btn-density"'), 'old density button is removed from header');
assert.ok(js.includes('data-rt-card-tab-sid'), 'tab mode renders per-AI card tabs');
assert.ok(js.includes("_focusRoundtableSession(meeting, sid)"), 'card tab click switches focused AI');
assert.ok(js.includes('if (_isCardTabMode()) return;'), 'card body click is inert in tab mode');

assert.ok(css.includes('.mr-view-toggle'), 'header segmented view toggle is styled');
assert.ok(css.includes('.mr-card-view-tabs'), 'card tab bar is styled');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-strip .mr-ft:not(.active)'), 'tab mode hides inactive cards');
assert.ok(css.includes('grid-template-columns: minmax(0, 1fr)'), 'tab mode uses a single card column');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-head'), 'tab mode hides card header chrome');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-escape-bar'), 'tab mode hides card action bar');
assert.ok(css.includes('body.mr-card-tab-mode .mr-ft-bottom'), 'tab mode gives preview the full card body');
assert.ok(css.includes('body.mr-card-tab-mode .mr-rt-timetravel-banner'), 'tab mode hides time-travel banner');
assert.ok(css.includes('body.mr-card-tab-mode .mr-rt-userq'), 'tab mode hides question banner');

console.log('meeting-room card view mode contract ok');
