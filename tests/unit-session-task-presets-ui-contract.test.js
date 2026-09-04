'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'styles.css'));

assert(index.includes('<script src="task-presets.js"></script>'), 'task preset module must load in the renderer');
// 2026-09-04：原断言用 indexOf('renderer.js') 找加载位置，会被正文里任何含
// "renderer.js" 的字串抢先命中（当时是一条提到 session-list-renderer.js 的注释，
// 位置比真正的 <script> 早 4 万字符），于是顺序永远判为错。
// 改成只在 <script src> 标签之间比顺序 —— 守的还是同一条不变量，但不再被注释干扰。
const scriptSrcAt = (file) => index.indexOf(`<script src="${file}"></script>`);
const presetsAt = scriptSrcAt('task-presets.js');
const rendererAt = scriptSrcAt('renderer.js');
assert(rendererAt >= 0, 'renderer.js must be loaded by a plain <script src> tag');
assert(presetsAt < rendererAt, 'workflow task presets must load before renderer');
assert(renderer.includes("bridgeToolbar.className = 'fi-bridge-toolbar'"), 'normal session must render the ChatGPT pull row');
assert(renderer.includes("bridgePullBtn.className = 'fi-bridge-pull'"), 'normal session must expose exactly the pull action');
assert(renderer.includes('chatgptBridgeController.pullForInput'), 'pull action must use the two-stage bridge controller');
assert(!renderer.includes("button.className = 'fi-preset-chip'"), 'normal session must not render the unused preset buttons');
assert(!renderer.includes('presetApi.composePrompt(userText'), 'normal send path must not inject a hidden preset constraint');
assert(css.includes('.fi-bridge-toolbar'), 'ChatGPT pull row must be styled');
assert(css.includes('.fi-bridge-pull'), 'pull button must be styled');
assert(css.includes('.fi-composer-row'), 'existing input and action buttons must remain in one composer row');

console.log('session ChatGPT pull UI contract ok');
