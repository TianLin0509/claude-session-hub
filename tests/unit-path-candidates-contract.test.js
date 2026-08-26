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
