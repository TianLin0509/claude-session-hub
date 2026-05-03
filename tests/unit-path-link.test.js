const test = require('node:test');
const assert = require('node:assert');
const { extractPathLinks } = require('../renderer/path-link.js');

test('finds .md path', () => {
  const found = extractPathLinks('参考 docs/foo.md 看一下');
  assert.deepStrictEqual(found.map(f => f.path), ['docs/foo.md']);
});

test('finds .html absolute path', () => {
  const found = extractPathLinks('打开 C:\\Users\\me\\report.html');
  assert.strictEqual(found.length, 1);
  assert.match(found[0].path, /\.html$/);
});

test('finds URL', () => {
  const found = extractPathLinks('访问 http://localhost:3000/api');
  assert.strictEqual(found.length, 1);
  assert.match(found[0].path, /^http/);
});

test('does not match prose words', () => {
  const found = extractPathLinks('this is just text without paths');
  assert.strictEqual(found.length, 0);
});

test('URL strips trailing period', () => {
  const found = extractPathLinks('See https://example.com.');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].path, 'https://example.com');
});

test('URL strips trailing comma', () => {
  const found = extractPathLinks('Go to http://api.test, then back');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].path, 'http://api.test');
});

test('URL preserves trailing slash and query', () => {
  const found = extractPathLinks('Visit https://example.com/api?x=1 now');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].path, 'https://example.com/api?x=1');
});
