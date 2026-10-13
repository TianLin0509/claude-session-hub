'use strict';
// 公司版新版本提醒与右下角「国内」状态（2026-10-13 用户）。真实界面流程见 tests/e2e-app-update-reminder-cdp.js。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { showDomesticRoute } = require('../renderer/session-list-renderer');
const { makeKindFilter } = require('../core/distribution');

// 右下角「国内正常 / 异常」只在发行版里有 Kimi / DeepSeek 时显示。
assert.strictEqual(showDomesticRoute(makeKindFilter(['codeagent']).kindAllowed), false, '公司纯净版只有 CodeAgent：不显示');
assert.strictEqual(showDomesticRoute(makeKindFilter(null).kindAllowed), true, '不限 AI（自用版）：照常显示');
assert.strictEqual(showDomesticRoute(makeKindFilter(['codex', 'kimi']).kindAllowed), true);
assert.strictEqual(showDomesticRoute(makeKindFilter(['claude', 'deepseek-claude']).kindAllowed), true);
assert.strictEqual(showDomesticRoute(), true, '主仓库默认显示');

// 更新提醒：按版本号只自动弹一次；「有新版本」不再挂标题栏小标签，改由设置红点提醒。
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app-update.js'), 'utf8');
assert.match(src, /readKey\(PROMPTED_KEY\) === version\) return/, '同一版本已弹过就不再弹');
assert.match(src, /\['ready', 'downloading'\]\.includes\(state\.phase\)/, '标题栏只在下载中 / 已就绪时出现');
assert.match(src, /#btn-options\.update-has-unread \.rail-utility-label:after/, '设置按钮的红点样式');
assert.match(src, /writeKey\(SEEN_KEY, version\)/, '从设置菜单点开后记为已看');

console.log('unit-app-update-reminder: all passed');
