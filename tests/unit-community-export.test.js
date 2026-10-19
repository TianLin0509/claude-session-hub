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

// 2026-10-19：无线助理的声明被剥，退出清理里的引用没剥，公司版「重启并继续」报 wirelessService is not defined 被取消。
test('main.js 剥离段里的顶层声明，剥离后不再被引用', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const names = new Set();
  let state = 'keep';
  for (const line of src.split(/\r?\n/)) {
    const marker = /^[ \t]*\/\/\s*@community-(strip|else|end)\b/.exec(line);
    if (marker) { state = marker[1] === 'end' ? 'keep' : marker[1]; continue; }
    const decl = state === 'strip' && /^(?:let|const|var|class|(?:async )?function\*?)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (decl) names.add(decl[1]);
  }
  assert.ok(names.has('wirelessService'), '样本：无线助理的声明在剥离段里');
  const kept = applyStripMarkers(src, 'main.js').text.split(/\r?\n/).map(l => l.replace(/\/\/.*$/, ''));
  const dangling = [];
  for (const name of names) {
    if (kept.some(l => new RegExp(`^(?:let|const|var|class|(?:async )?function\\*?)\\s+${name}\\b`).test(l))) continue;
    const ref = new RegExp(`(^|[^\\w$.'"\`-])${name}\\b`);
    kept.forEach((l, i) => { if (ref.test(l)) dangling.push(`${name} @ 导出后第 ${i + 1} 行：${l.trim().slice(0, 80)}`); });
  }
  assert.deepEqual(dangling, [], '这些名字的声明被剥了，引用也要包进剥离标记');
});

test('公司版产品名放行只对传了 leakAllow 的导出生效，社区版照拦；放行项必须是带 Huawei/华为 的完整名字', () => {
  const line = '窗口标题：AI HUB-Huawei 内测先锋版；安装包 AIHubHuawei-Setup-1.0.1.exe';
  assert.ok(scanText(line, 'f').some(h => h.rule === 'personal-preference'), '社区版不传放行，照拦');
  assert.equal(scanText(line, 'f', { allowLiterals: ['AI HUB-Huawei', 'AIHubHuawei-'] }).length, 0);
  assert.ok(scanText('AI HUB-Huawei 和华为内部系统', 'f', { allowLiterals: ['AI HUB-Huawei'] }).some(h => h.match === '华为'), '同一行别的内容照常检查');
  assert.throws(() => scanText('x', 'f', { allowLiterals: ['Huawei'] }), /完整产品名/);
  assert.throws(() => scanText('x', 'f', { allowLiterals: ['some other name'] }), /Huawei/);
  assert.equal(scanText('https://me.lt-stockpartner.tech/hub-update/company/latest.json', 'f').length, 0, '更新目录随发行版公开');
  assert.ok(scanText('https://me.lt-stockpartner.tech/private/', 'f').length, '同一服务器的其他地址照拦');
  const target = require('../community/targets/company/target.json');
  assert.deepEqual(target.leakAllow, ['AI HUB-Huawei', 'AIHubHuawei-']);
  assert.equal(target.productName, 'AI HUB-Huawei');
});

test('leak rules catch identity, gateways and secrets but not ordinary text', () => {
  assert.ok(scanText('url: http://3.142.133.116:8080', 'f').length);
  assert.ok(scanText('key sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'f').length);
  assert.equal(scanText('const home = os.homedir();', 'f').length, 0);
});

// 一个最小的合成仓库：有私人文件、清单、覆盖文件和公开审计脚本，足以跑完整导出。
function syntheticRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-export-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('package.json', JSON.stringify({ name: 'x', version: '9.9.9', build: { files: ['core/**/*'] } }));
  write('core/app.js', "'use strict';\nmodule.exports = 1;\n");
  write('core/private-thing.js', "'use strict';\n");
  write('community/manifest.json', JSON.stringify({ version: '1.2.3', include: ['package.json', 'core/**'], drop: ['core/private-thing.js'], scrub: [], package: { scripts: {} } }));
  write('community/overlay/README.md', 'install @@COMMUNITY_TAG@@ from upstream @@UPSTREAM_VERSION@@\n');
  write('community/overlay/scripts/install-release.ps1', "param([string]$Version = '@@COMMUNITY_TAG@@')\n");
  write('community/overlay/scripts/audit-public.js', "console.log(JSON.stringify({ ok: true, failures: [] }));\n");
  const git = (...args) => require('child_process').execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  return { root, write, commit: git('rev-parse', 'HEAD').trim() };
}

test('exporting a commit ignores uncommitted overlay, manifest and untracked files', t => {
  const repo = syntheticRepo(t);
  // Checkout follows the user's core.autocrlf, so compare text with normalized line endings.
  const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
  // Counterexamples in the working tree: none of them may reach an export of the commit.
  repo.write('community/overlay/README.md', 'TAMPERED TRACKED OVERLAY\n');
  repo.write('community/overlay/untracked-probe.txt', 'UNTRACKED OVERLAY PROBE\n');
  repo.write('community/manifest.json', JSON.stringify({ version: '6.6.6', include: ['package.json', 'core/**'], drop: [], scrub: [], package: { scripts: {} } }));
  const out = path.join(repo.root, '..', path.basename(repo.root) + '-out');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const report = exportCommunity({ ref: repo.commit, out, root: repo.root });
  assert.equal(report.ok, true, JSON.stringify(report.publicAudit));
  assert.equal(report.upstreamDirty, false);
  assert.equal(report.upstreamCommit, repo.commit);
  assert.equal(read(out, 'README.md'), 'install v1.2.3 from upstream 9.9.9\n', 'committed overlay with versions filled in');
  assert.equal(fs.existsSync(path.join(out, 'untracked-probe.txt')), false, 'untracked overlay file is not exported');
  assert.equal(fs.existsSync(path.join(out, 'core', 'private-thing.js')), false, 'committed manifest still drops the private file');
  assert.equal(JSON.parse(read(out, 'community-edition.json')).version, '1.2.3', 'committed manifest version, not the edited one');
  assert.match(read(out, 'scripts/install-release.ps1'), /\$Version = 'v1\.2\.3'/, 'installer defaults to this release');

  // WORKTREE mode may read uncommitted content, and must say so — untracked files included.
  const wt = path.join(repo.root, '..', path.basename(repo.root) + '-wt');
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const wtReport = exportCommunity({ ref: 'WORKTREE', out: wt, root: repo.root });
  assert.equal(wtReport.upstreamDirty, true);
  assert.equal(JSON.parse(read(wt, 'community-edition.json')).upstreamDirty, true);
});

test('WORKTREE export marks an untracked-only change as dirty', t => {
  const repo = syntheticRepo(t);
  repo.write('community/overlay/only-untracked.txt', 'x\n');
  const out = path.join(repo.root, '..', path.basename(repo.root) + '-u');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.equal(exportCommunity({ ref: 'WORKTREE', out, root: repo.root }).upstreamDirty, true);
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
    const edition = JSON.parse(fs.readFileSync(path.join(out, 'community-edition.json'), 'utf8')).version;
    assert.match(fs.readFileSync(path.join(out, 'scripts', 'install-release.ps1'), 'utf8'),
      new RegExp(`\\$Version = 'v${edition.replace(/\./g, '\\.')}'`), 'installer defaults to this release');
    // The first-run panel mounts into the home page by class; an upstream home redesign
    // once removed its anchor and the panel silently disappeared.
    const welcome = fs.readFileSync(path.join(out, 'renderer', 'community-welcome.js'), 'utf8');
    const anchor = /const host = document\.querySelector\('\.([\w-]+)'\)/.exec(welcome);
    assert.ok(anchor, 'community-welcome.js names its home page anchor');
    assert.match(fs.readFileSync(path.join(out, 'renderer', 'index.html'), 'utf8'), new RegExp(`class="[^"]*\\b${anchor[1]}\\b`),
      `home page still has .${anchor[1]} for the community first-run panel`);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});
