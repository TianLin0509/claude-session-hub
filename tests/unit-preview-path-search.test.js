'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clearPreviewPathSearchCache,
  cleanPathQuery,
  scorePathEntry,
  searchPreviewPaths,
} = require('../core/preview-path-search.js');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-preview-search-'));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'design'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'hidden-package'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'preview-report.md'), '# report', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'design', 'preview-workbench.html'), '<h1>ok</h1>', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'hidden-package', 'preview-secret.md'), 'hidden', 'utf8');
  return root;
}

test('cleanPathQuery expands quotes, home and environment variables', () => {
  assert.equal(cleanPathQuery('  "C:\\tmp\\demo.md"  '), 'C:\\tmp\\demo.md');
  assert.equal(cleanPathQuery('%DEMO_ROOT%\\a.md', { DEMO_ROOT: 'C:\\demo' }, 'C:\\home'), 'C:\\demo\\a.md');
  assert.equal(cleanPathQuery('~\\notes.md', {}, 'C:\\home'), path.join('C:\\home', 'notes.md'));
});

test('scorePathEntry favors basename and supports subsequence matching', () => {
  const exact = scorePathEntry({ name: 'preview-report.md', relativePath: 'artifacts/preview-report.md' }, 'preview-report.md');
  const fuzzy = scorePathEntry({ name: 'preview-workbench.html', relativePath: 'docs/design/preview-workbench.html' }, 'pvwb');
  const miss = scorePathEntry({ name: 'other.txt', relativePath: 'docs/other.txt' }, 'pvwb');
  assert.ok(exact > fuzzy);
  assert.ok(fuzzy >= 0);
  assert.equal(miss, -1);
});

test('searchPreviewPaths resolves exact relative paths and fuzzy workspace paths', async (t) => {
  const root = makeWorkspace();
  t.after(() => {
    clearPreviewPathSearchCache(root);
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), 'cleanup target must remain inside the OS temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const exact = await searchPreviewPaths({
    query: 'artifacts\\preview-report.md',
    cwd: root,
  });
  assert.equal(exact.results[0].source, 'exact');
  assert.equal(exact.results[0].path, path.join(root, 'artifacts', 'preview-report.md'));

  const fuzzy = await searchPreviewPaths({ query: 'pvwb', cwd: root });
  assert.equal(fuzzy.results[0].name, 'preview-workbench.html');
  assert.equal(fuzzy.results.some(item => item.path.includes('node_modules')), false);
  assert.ok(fuzzy.indexedCount >= 4);
});

test('searchPreviewPaths allows an existing absolute path without a workspace', async (t) => {
  const root = makeWorkspace();
  const target = path.join(root, 'artifacts', 'preview-report.md');
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), 'cleanup target must remain inside the OS temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const result = await searchPreviewPaths({ query: target, cwd: null });
  assert.equal(result.source, 'exact');
  assert.equal(result.results[0].path, target);
});

test('concurrent searches share one in-flight workspace index build', async (t) => {
  const root = makeWorkspace();
  let readdirCalls = 0;
  const fsImpl = {
    promises: {
      stat: (...args) => fs.promises.stat(...args),
      async readdir(...args) {
        readdirCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return fs.promises.readdir(...args);
      },
    },
  };
  t.after(() => {
    clearPreviewPathSearchCache(root);
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), 'cleanup target must remain inside the OS temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    searchPreviewPaths({ query: 'preview', cwd: root }, { fsImpl }),
    searchPreviewPaths({ query: 'report', cwd: root }, { fsImpl }),
  ]);
  assert.ok(first.results.length > 0);
  assert.ok(second.results.length > 0);
  assert.equal(readdirCalls, 4, 'root + three visible directories should be indexed only once');
});

test('unreadable workspace root returns an explicit search error', async () => {
  const denied = new Error('EACCES denied');
  denied.code = 'EACCES';
  const result = await searchPreviewPaths({ query: 'report', cwd: 'C:\\locked' }, {
    fsImpl: {
      promises: {
        async stat() { throw denied; },
        async readdir() { throw denied; },
      },
    },
  });
  assert.equal(result.source, 'error');
  assert.equal(result.errorsCount, 1);
  assert.match(result.error, /workspace 无法读取.*EACCES denied/);
});

test('absolute exact-path I/O failure is not disguised as no result', async () => {
  const denied = new Error('EIO device failure');
  denied.code = 'EIO';
  const result = await searchPreviewPaths({ query: 'C:\\broken\\report.md', cwd: null }, {
    fsImpl: {
      promises: {
        async stat() { throw denied; },
        async readdir() { throw denied; },
      },
    },
  });
  assert.equal(result.source, 'error');
  assert.equal(result.errorsCount, 1);
  assert.match(result.error, /路径无法读取.*EIO device failure/);
});
