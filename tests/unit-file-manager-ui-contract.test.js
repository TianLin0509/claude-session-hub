'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const html = read('renderer/index.html');
const renderer = read('renderer/renderer.js');
const meeting = read('renderer/meeting-room.js');
const panel = read('renderer/file-manager-panel.js');
const panelCss = read('renderer/file-manager-panel.css');
const account = read('renderer/account-usage-controller.js');
const { fileVisualKind, isPreviewableFile } = require('../renderer/file-manager-panel.js');

assert.match(html, /id="file-manager-panel"/);
assert.match(html, /id="file-manager-tree"[\s\S]*role="tree"/);
assert.match(html, /file-manager-panel\.css/);
assert.match(renderer, /createFileManagerPanel\(\{/);
assert.match(renderer, /btn-file-manager-toggle/);
assert.match(meeting, /id="mr-btn-files"/);
assert.match(panel, /file-manager:list-directory/);
assert.match(panel, /openPathInHub\(targetPath/,
  'file clicks must reuse the Hub preview/external-open router');
assert.match(panel, /async function openDirectory\(/,
  'recognized directories need a public in-Hub navigation entry point');
assert.match(panel, /hub-side-panel-opening/,
  'file manager and memo should share an exclusive right-sidebar contract');
assert.match(panelCss, /@media \(max-width: 980px\)/,
  'narrow windows need an overlay sidebar instead of crushing the terminal');
assert.match(panelCss, /:focus-visible/);
assert.match(panelCss, /prefers-reduced-motion/);

assert.doesNotMatch(renderer, /metric-context-window/,
  'the per-session ctx window badge was explicitly removed from the header');
assert.doesNotMatch(html, /recent-turn-copy-total/,
  'the redundant “共 N 轮” label was explicitly removed');
assert.match(renderer, /bridgeToolbar\.appendChild\(branchBtn\)/,
  'branch belongs beside Pull in the composer toolbar');
assert.doesNotMatch(renderer, /className = 'btn-zoom btn-fork-session'/,
  'branch must not remain in the session header');
assert.match(account, /data-action="open-memo"[\s\S]{0,100}>备忘录<\/button>/,
  'memo replaces memory in the global usage ticker');
assert.match(renderer, /memoryBtn\.dataset\.action = 'open-memory'/,
  'memory moves into the former header memo position');
assert.match(renderer, /在文件管理中打开/,
  'the workspace path must open inside Hub instead of copying or launching Explorer');
const directoryRoute = renderer.slice(
  renderer.indexOf('if (_isDirectoryPath(fullPath))'),
  renderer.indexOf('if (PREVIEW_PATH_RE.test(fullPath))'),
);
assert.match(directoryRoute, /manager\.openDirectory\(fullPath, context\)/);
assert.doesNotMatch(directoryRoute, /ipcRenderer\.invoke\('open-path'/,
  'ordinary directory clicks must not escape to the OS shell');
assert.match(renderer, /a\.setAttribute\('data-cwd', cwd\)/,
  'recognized paths must retain their owning workspace instead of consulting only global active state');
assert.match(renderer, /a\.dataset\.cwd \|\| getSessionCwd\(activeSessionId\)/);
assert.match(meeting, /if \(!a\.closest\('#meeting-room-panel'\)\) return;/,
  'meeting path delegation must not consume ordinary-session links a second time');
assert.match(meeting, /a\.dataset\.cwd \|\| _activeMeetingCwd\(\)/);
assert.equal(isPreviewableFile('README.md'), true);
assert.equal(isPreviewableFile('dashboard.HTML'), true);
assert.equal(isPreviewableFile('external-demo.zip'), false);
assert.equal(fileVisualKind('plot.png'), 'image');
assert.equal(fileVisualKind('src', 'directory'), 'folder');

console.log('file manager UI contract ok');
