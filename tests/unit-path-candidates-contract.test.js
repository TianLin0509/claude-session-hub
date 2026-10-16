const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PREVIEW_PATH_RE,
  HUB_IMG_PATH_RE,
  collectPathCandidates,
  _cleanPathCandidate,
  _repairLocalPathCandidate,
  _normalizeLocalPathForOpen,
  classifyLocalPathHref,
} = require('../renderer/path-candidates.js');

test('collects URL and strips trailing punctuation', () => {
  const found = collectPathCandidates('Open http://localhost:3000/api, then continue.');
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0], {
    start: 5,
    end: 29,
    openPath: 'http://localhost:3000/api',
    isUrl: true,
  });
});

test('collects file URLs as the same local path used by card preview', () => {
  const raw = 'file:///C:/Vibe/My%20Report/report.md';
  const found = collectPathCandidates(`Open ${raw} now`);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].openPath, 'C:\\Vibe\\My Report\\report.md');
  assert.strictEqual(found[0].isUrl, false);
});

test('collects absolute Windows preview path without filesystem validation', () => {
  const text = 'HTML: C:\\Users\\lintian\\report.html.';
  const found = collectPathCandidates(text);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].openPath, 'C:\\Users\\lintian\\report.html');
  assert.strictEqual(PREVIEW_PATH_RE.test(found[0].openPath), true);
});

test('repairs common Codex Windows path separator mistakes without changing display offsets', () => {
  const variants = [
    ['C:\\\\Vibe\\\\_scratch\\\\report.md', 'C:\\Vibe\\_scratch\\report.md'],
    ['C:/Vibe/_scratch/report.md', 'C:\\Vibe\\_scratch\\report.md'],
    ['C:Users\\lintian\\report.md', 'C:\\Users\\lintian\\report.md'],
    ['/C:/Vibe/_scratch/report.md', 'C:\\Vibe\\_scratch\\report.md'],
  ];
  for (const [raw, expected] of variants) {
    const text = `open ${raw} now`;
    const found = collectPathCandidates(text);
    assert.strictEqual(found.length, 1, raw);
    assert.strictEqual(found[0].openPath, expected, raw);
    assert.strictEqual(text.slice(found[0].start, found[0].end + 1), raw, raw);
  }
});

test('collects Windows paths containing spaces and keeps the final compound extension', () => {
  const text = 'open C:\\Vibe\\My Report\\report.test.js, then continue';
  const found = collectPathCandidates(text);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].openPath, 'C:\\Vibe\\My Report\\report.test.js');
});

test('repairs and recognizes an existing directory with doubled separators', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-dir-'));
  const target = path.join(root, '_scratch');
  fs.mkdirSync(target);
  const raw = target.replace(/\\/g, '\\\\');
  const found = collectPathCandidates(`folder ${raw}`);
  assert.ok(found.some((item) => item.openPath === target));
});

test('classifies Markdown local hrefs but leaves web URLs alone', () => {
  assert.deepStrictEqual(
    classifyLocalPathHref('C:%5CVibe%5C_scratch%5Creport.md'),
    {
      displayPath: 'C:\\Vibe\\_scratch\\report.md',
      openPath: 'C:\\Vibe\\_scratch\\report.md',
    },
  );
  assert.deepStrictEqual(
    classifyLocalPathHref('docs/report.md', 'C:\\work'),
    {
      displayPath: 'docs/report.md',
      openPath: 'C:\\work\\docs\\report.md',
    },
  );
  assert.deepStrictEqual(
    classifyLocalPathHref('file:///C:/Vibe/My%20Report/report.md'),
    {
      displayPath: 'file:///C:/Vibe/My Report/report.md',
      openPath: 'C:\\Vibe\\My Report\\report.md',
    },
  );
  assert.strictEqual(classifyLocalPathHref('https://example.com/report.md', 'C:\\work'), null);
});

test('repairs only path-like drive-relative text', () => {
  assert.strictEqual(_repairLocalPathCandidate('C:Users\\me\\a.md'), 'C:\\Users\\me\\a.md');
  assert.strictEqual(_repairLocalPathCandidate('C: note.md'), 'C: note.md');
});

test('resolves existing relative paths against cwd only', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-candidates-'));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs', 'note.md'), '# note');
  const found = collectPathCandidates('See docs/note.md and docs/missing.md', cwd, { includeDirectories: false });
  const relative = found.map(x => path.relative(cwd, x.openPath));
  assert.ok(relative.includes('docs\\note.md'));
  assert.ok(!relative.includes('docs\\missing.md'));
});

test('treats a full-width Chinese colon as a relative-path boundary', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-cjk-label-'));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs', 'note.md'), '# note');
  const found = collectPathCandidates('相对路径：docs\\note.md', cwd);
  assert.ok(found.some(item => item.openPath === path.join(cwd, 'docs', 'note.md')));
});

test('normalizes relative open path with existence requirement', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-normalize-'));
  fs.writeFileSync(path.join(cwd, 'ok.txt'), 'ok');
  assert.strictEqual(_normalizeLocalPathForOpen('ok.txt', cwd), path.join(cwd, 'ok.txt'));
  assert.strictEqual(_normalizeLocalPathForOpen('missing.txt', cwd), null);
  assert.strictEqual(_normalizeLocalPathForOpen('missing.txt', cwd, false), path.join(cwd, 'missing.txt'));
});

test('cleans paired markdown punctuation from path candidates', () => {
  assert.strictEqual(_cleanPathCandidate('`"C:\\Users\\me\\a.md".`'), 'C:\\Users\\me\\a.md');
});

test('hub image path regex strips clipboard image paths from previews', () => {
  const text = 'C:\\Users\\lintian\\.claude-session-hub\\images\\clip.png user prompt';
  assert.strictEqual(text.replace(HUB_IMG_PATH_RE, ' ').trim(), 'user prompt');
});

// 2026-10-16 田哥截图：「设计稿：D:\AI-Artifacts\…设计-claude1.html（v1.1，开着的话刷新一下）」整段带上「（v1.1」成了链接、点开打不开。
// 文件名允许空格和中文，贪心匹配把「v1.1」的 .1 当成了扩展名。现在：整串存在就保留；否则收到「存在的那个常见扩展名」为止；
// 都不存在时收到第一个后面跟中文、全角标点或空白的常见扩展名。
test('path followed by Chinese prose with a version number stops at the real extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-ext-'));
  const file = path.join(dir, '20261016-会话管理与AI特战队通道设计-claude1.html');
  fs.writeFileSync(file, '<html></html>');
  const text = `5. 设计稿：${file}（v1.1，开着的话刷新一下）。`;
  const found = collectPathCandidates(text, null, { includeDirectories: false });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].openPath, file);
  assert.strictEqual(text.slice(found[0].start, found[0].end + 1), file);
});

test('a real file name that contains a space and a second extension is kept whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-ext-'));
  const file = path.join(dir, 'notes.md backup v2.md');
  fs.writeFileSync(file, '# x');
  const found = collectPathCandidates(`打开 ${file} 看看`, null, { includeDirectories: false });
  assert.strictEqual(found[0].openPath, file);
});

test('a path that does not exist yet is cut where prose begins, not at a later version number', () => {
  const target = path.join('D:\\', 'AIWork', 'not-created-yet-20261016', 'a.md');
  const text = `旧路径 ${target} v2.3 说明`;
  const found = collectPathCandidates(text, null, { includeDirectories: false });
  assert.strictEqual(text.slice(found[0].start, found[0].end + 1), target);
});
