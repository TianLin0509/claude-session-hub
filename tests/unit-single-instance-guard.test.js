'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('bootstrap grants one owner per Electron userData/data directory', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main-bootstrap.js'), 'utf8');
  assert.match(source, /app\.requestSingleInstanceLock\(/,
    'bootstrap must acquire ownership before loading the Hub runtime');
  assert.match(source, /if \(!hasPrimaryDataDirLock\)[\s\S]{0,220}app\.quit\(\)/,
    'a losing same-data-dir process must quit without loading runtime state');
  assert.match(source, /app\.on\('second-instance'/,
    'the primary Hub must focus its existing window for a second launch');
  assert.ok(source.indexOf('requestSingleInstanceLock') < source.indexOf("require('./main.js')"),
    'ownership must be decided before main.js can repair state or create PTYs');
});

// 2026-07-27：上面的契约生效时删掉了 `const hasSingleInstanceLock = ...`，
// 却把 whenReady 里的 `if (!hasSingleInstanceLock) return;` 留下了。变量无定义 →
// whenReady 立刻抛 ReferenceError → 窗口和全部 IPC 注册都不执行，Hub 直接起不来
// （隔离实例实测 page target 数为 0）。语法检查发现不了，只能靠这条契约。
// 注释里提到这个名字是允许的（修复说明就写在那里），所以先把注释剥掉再扫。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('main runtime does not read an undeclared single-instance flag', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'));
  const reads = code.match(/\bhasSingleInstanceLock\b/g) || [];
  const defines = code.match(/(?:const|let|var)\s+hasSingleInstanceLock\b/g) || [];
  assert.ok(reads.length === 0 || defines.length > 0,
    'hasSingleInstanceLock is read but never defined — whenReady throws ReferenceError and no window is created');
});

test('whenReady does not early-return on an undeclared identifier', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'));
  const start = code.indexOf('app.whenReady().then(');
  assert.ok(start > 0, 'whenReady handler must exist');
  const guard = code.slice(start, start + 400).match(/if \(!([A-Za-z_$][\w$]*)\) return;/);
  if (guard) {
    const name = guard[1];
    const defined = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(code)
      || new RegExp(`\\b${name}\\s*=[^=]`).test(code.slice(0, start));
    assert.ok(defined, `whenReady early-returns on "${name}" which is never defined`);
  }
});
