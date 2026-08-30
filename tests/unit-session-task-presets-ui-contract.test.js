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
assert(index.indexOf('task-presets.js') < index.indexOf('renderer.js'), 'workflow task presets must load before renderer');
assert(renderer.includes("bridgeToolbar.className = 'fi-bridge-toolbar'"), 'normal session must render the ChatGPT pull row');
assert(renderer.includes("bridgePullBtn.className = 'fi-bridge-pull'"), 'normal session must expose exactly the pull action');
assert(renderer.includes('chatgptBridgeController.pullForInput'), 'pull action must use the two-stage bridge controller');
assert(!renderer.includes("button.className = 'fi-preset-chip'"), 'normal session must not render the unused preset buttons');
assert(!renderer.includes('presetApi.composePrompt(userText'), 'normal send path must not inject a hidden preset constraint');
assert(css.includes('.fi-bridge-toolbar'), 'ChatGPT pull row must be styled');
assert(css.includes('.fi-bridge-pull'), 'pull button must be styled');
assert(css.includes('.fi-composer-row'), 'existing input and action buttons must remain in one composer row');

console.log('session ChatGPT pull UI contract ok');
