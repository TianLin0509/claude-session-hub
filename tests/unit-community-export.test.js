'use strict';

// 社区版导出闸门：主仓库任何改动都要保证「导出后的公开版」仍然干净、能解析、能加载。
// 私人模块新增了接线点却没加剥离标记，或者新代码写进了私人路径/网关，这里会先红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyStripMarkers } = require('../scripts/community/strip-markers');
const { scanText } = require('../scripts/community/leak-rules');
const { exportCommunity } = require('../scripts/community/export-community');

test('strip markers: removed in export, else-lines uncommented, malformed regions rejected', () => {
  const source = [
    'a();',
    '// @community-strip reason',
    'personal();',
    '// @community-else',
    '// community();',
    '// @community-end',
    '  <!-- @community-strip -->',
    '  <div id="private"></div>',
    '  <!-- @community-end -->',
    'b();',
  ].join('\n');
  assert.equal(applyStripMarkers(source, 'x').text, ['a();', 'community();', 'b();'].join('\n'));
  assert.throws(() => applyStripMarkers('// @community-strip\n// @community-strip\n// @community-end', 'x'), /不能嵌套/);
  assert.throws(() => applyStripMarkers('// @community-strip\nx();', 'x'), /没有 @community-end/);
  assert.throws(() => applyStripMarkers('// @community-strip\n// @community-else\nnotComment();\n// @community-end', 'x'), /必须是注释/);
});

test('leak rules catch identity, gateways and secrets but not ordinary text', () => {
  assert.ok(scanText('url: http://3.142.133.116:8080', 'f').length);
  assert.ok(scanText('key sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'f').length);
  assert.equal(scanText('const home = os.homedir();', 'f').length, 0);
});

test('the current tree exports to a clean, loadable community edition', { timeout: 240000 }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-community-export-')), 'tree');
  try {
    const report = exportCommunity({ ref: 'WORKTREE', out, log: () => {} });
    assert.deepEqual(report.leftoverMarkers, [], 'every strip marker is processed');
    assert.deepEqual(report.syntaxErrors, [], 'exported JavaScript parses');
    assert.deepEqual(report.unresolvedReferences, [], 'relative requires and page references resolve');
    assert.deepEqual(report.leaks, [], 'no identity, private service or secret in the public tree');
    assert.equal(report.publicAudit.ok, true, JSON.stringify(report.publicAudit.failures));
    assert.equal(report.ok, true);
    assert.ok(fs.existsSync(path.join(out, 'community-edition.json')));
    assert.ok(fs.existsSync(path.join(out, 'scripts', 'session-hub-hook.ps1')));
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});
