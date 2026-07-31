'use strict';

// cwd 失效时允许兼容性回落，但必须把事实从 main 一直送到 renderer、持久化并明确提示；
// 否则用户会在 Home 聚合根里继续工作，却以为仍在原项目。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const sessionManager = read('core/session-manager.js');
const resumeHandler = read('main/ipc/resume-session-handlers.js');
const persistence = read('main/ipc/persistence-handlers.js');
const renderer = read('renderer/renderer.js');
const sidebar = read('renderer/session-list-renderer.js');
const main = read('main.js');

assert.match(sessionManager, /cwdFellBackFrom:\s*cwdFellBack/,
  'spawn result must expose the original invalid cwd');
assert.match(sessionManager, /fs\.statSync\(spawnCwd\)\.isDirectory\(\)/,
  'an existing file path is not a valid PTY cwd and must take the fallback path');
assert.match(sessionManager, /opts\.cwdFellBackFrom/,
  'a warning from an earlier dormant resume must survive later resumes');
assert.match(resumeHandler, /cwdFellBackFrom:\s*meta\.cwdFellBackFrom/,
  'resume handler must forward prior fallback metadata');
assert.match(persistence, /'cwdFellBackFrom'/,
  'persistence merge whitelist must retain fallback metadata');
assert.match(renderer, /cwdFellBackFrom:\s*s\.cwdFellBackFrom/,
  'renderer persistence payload must retain fallback metadata');
assert.match(renderer, /cwdFellBackFrom:\s*meta\.cwdFellBackFrom/,
  'dormant restore must retain fallback metadata');
assert.match(renderer, /原工作目录已不存在/,
  'interactive dormant wake must show an explicit warning');
assert.match(sidebar, /session\.cwdFellBackFrom/,
  'sidebar warning helper must still read the original invalid cwd');
assert.match(sidebar, /anyWarning \? `<span class="sl-pin"/,
  'sidebar must keep a visible warning after the one-time dialog closes');
assert.match(main, /meetings:\s*Array\.isArray\(bootState\.meetings\)/,
  'boot heal persistence must write a complete snapshot, not an ambiguous partial state');

console.log('unit-cwd-fallback-warning.test.js OK');
