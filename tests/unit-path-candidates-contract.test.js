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
  _normalizeLocalPathForOpen,
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

test('collects absolute Windows preview path without filesystem validation', () => {
  const text = 'HTML: C:\\Users\\lintian\\report.html.';
  const found = collectPathCandidates(text);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].openPath, 'C:\\Users\\lintian\\report.html');
  assert.strictEqual(PREVIEW_PATH_RE.test(found[0].openPath), true);
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
