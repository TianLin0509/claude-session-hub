'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (err.message || err));
  }
}

test('主 webContents 的 file 白名单只认 Hub 自己的 index.html', () => {
  assert.match(main, /const hubShellPath = path\.resolve\(path\.join\(__dirname, 'renderer', 'index\.html'\)\)/);
  assert.match(main, /path\.resolve\(fileURLToPath\(u\)\)\.toLowerCase\(\) === hubShellPath\.toLowerCase\(\)/);
  assert.doesNotMatch(main, /return u\.protocol === 'file:' \|\|/);
});

test('其他本地文件被阻止后重新投递到 Hub 预览', () => {
  assert.match(main, /event\.preventDefault\(\);\s*routeBlockedMainNavigation\(urlStr\)/);
  assert.match(main, /sendToRenderer\('preview-local-file', targetPath\)/);
  assert.match(renderer, /ipcRenderer\.on\('preview-local-file',[\s\S]{0,260}openPathInHub\(filePath/);
});

test('原始 file 链接在 renderer 捕获阶段直接进入预览', () => {
  assert.match(renderer, /const isLocalFileUrl = \/\^file:\/i\.test\(href\)/);
  assert.match(renderer, /if \(isLocalFileUrl\) \{[\s\S]{0,280}openPathInHub\(fileURLToPath\(href\)/);
});

test('window.open 本地文件也不再创建可逃逸的窗口', () => {
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\) => \{\s*routeBlockedMainNavigation\(url\);\s*return \{ action: 'deny' \}/);
});

console.log('Running main navigation guard contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
