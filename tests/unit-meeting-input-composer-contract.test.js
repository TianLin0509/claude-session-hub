const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

assert.ok(js.includes("_INPUT_DRAFTS_STORAGE_KEY = 'mr-input-drafts-v1'"), 'input drafts must be persisted per meeting');
assert.ok(js.includes("_INPUT_HISTORY_STORAGE_KEY = 'mr-input-history-v1'"), 'prompt history must be persisted per meeting');
assert.ok(js.includes('_LONG_INPUT_CHAR_THRESHOLD = 1200'), 'long input threshold must be explicit');
assert.ok(js.includes("row.id = 'mr-input-preflight'"), 'preflight row must be created near the input');
assert.ok(js.includes('mr-input-battle-label'), 'preflight row must expose the battle panel label');
assert.ok(js.includes('mr-input-battle-detail'), 'preflight row must expose selected targets and workflow detail');
assert.ok(js.includes("historyBtn.id = 'mr-input-history-btn'"), 'prompt history button must be installed');
assert.ok(js.includes("expandBtn.id = 'mr-input-expand-btn'"), 'expanded editor button must be installed');
assert.ok(js.includes("overlay.id = 'mr-input-editor-overlay'"), 'expanded editor modal must be installed');
// 2026-07-20 产品决策：五个低频 next-action 按钮已从 UI 摘除（见 meeting-room.js _renderNextActionBar 注释），
// 但 _handleNextAction 各分支与 [data-gc-next-action] 点击委托保留备用。契约锁定这一现状：
// 按钮标记不再出现，handler 分支必须健在。
assert.ok(!js.includes('data-gc-next-action="synthesize"'), 'synthesize button stays removed from the next-action bar');
assert.ok(js.includes("action === 'synthesize'"), 'synthesize handler branch must be kept for reuse');
assert.ok(js.includes("action === 'quote-latest'"), 'quote-latest handler branch must be kept for reuse');
assert.ok(js.includes('[data-gc-next-action]'), 'next-action click delegation must be kept for reuse');
assert.ok(js.includes('mr-card-roster'), 'card view must expose a member roster');
assert.ok(js.includes('mr-latest-round'), 'card view must give the latest round an explicit priority region');
assert.ok(js.includes('mr-mobile-workbench'), 'group chat must expose a mobile workbench');
assert.match(js, /_pushPromptHistory\(m\.id,\s*userText\s*\|\|\s*finalText\);/, 'send path must record prompt history');
assert.match(js, /_clearInputDraft\(m\.id\);/, 'send path must clear the persisted draft');
assert.match(js, /_setInputDraft\(activeMeetingId,\s*text\);/, 'input events must save persistent drafts');
assert.match(js, /_updateInputPreflight\(meetingData\[activeMeetingId\]\);/, 'input events must refresh preflight status');

assert.ok(css.includes('.mr-input-preflight'), 'preflight row must be styled');
assert.ok(css.includes('.mr-input-battle-label'), 'battle panel label must be styled');
assert.ok(css.includes('.mr-input-battle-detail'), 'battle panel detail must be styled');
assert.ok(css.includes('.mr-input-tool-btn'), 'input tool buttons must be styled with stable dimensions');
assert.ok(css.includes('.mr-input-history-menu'), 'prompt history menu must be styled');
assert.ok(css.includes('.mr-input-editor-overlay'), 'expanded editor overlay must be styled');
assert.ok(css.includes('grid-template-rows: auto minmax(220px, 1fr) auto'), 'expanded editor must reserve a useful writing area');
assert.ok(css.includes('.mr-turn-lane'), 'turn progress lane must be styled');
assert.ok(css.includes('.mr-next-actions'), 'next action bar must be styled');
assert.ok(css.includes('.mr-card-roster'), 'card roster must be styled');
assert.ok(css.includes('.mr-latest-round'), 'latest-round region must be styled');
assert.ok(css.includes('.mr-mobile-workbench'), 'mobile workbench must be styled');

console.log('meeting input composer contract ok');
