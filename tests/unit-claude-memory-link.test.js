'use strict';
// Claude Code buckets `memory/` by cwd, so every fresh _scratch\inbox-* task used
// to start with an empty memory store while the real library sat in the home
// bucket. These tests pin the junction that reconnects them.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalMemoryDir, ensureMemoryLink } = require('../core/claude-memory-link.js');
const { CLAUDE_PROJECT_ROOT_DIRS, projectSlug } = require('../core/claude-transcript-locator.js');

const SESSION_MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memlink-'));
  try {
    const canonical = canonicalMemoryDir(home);
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'MEMORY.md'), '# Memory Router\n', 'utf8');
    fn(home, canonical);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('Running claude memory link tests...');

test('canonical store is the home directory bucket', () => {
  const home = 'C:\\Users\\lintian';
  assert.strictEqual(
    canonicalMemoryDir(home),
    path.join(home, '.claude', 'projects', 'C--Users-lintian', 'memory'),
  );
});

test('a fresh scratch cwd gets memory linked for every CLI root', () => {
  withHome((home, canonical) => {
    const cwd = 'C:\\Vibe\\_scratch\\inbox-abc';
    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {} } });

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.linked.length, CLAUDE_PROJECT_ROOT_DIRS.length,
      'claude and deepseek roots must both see the shared library');
    for (const root of CLAUDE_PROJECT_ROOT_DIRS) {
      const linked = path.join(home, root, 'projects', projectSlug(cwd), 'memory');
      assert.ok(fs.lstatSync(linked).isSymbolicLink(), `${root} must be a junction`);
      assert.strictEqual(fs.readFileSync(path.join(linked, 'MEMORY.md'), 'utf8'), '# Memory Router\n');
    }
    assert.ok(fs.existsSync(canonical), 'canonical store must be untouched');
  });
});

test('an existing real memory directory is never replaced', () => {
  withHome((home) => {
    const cwd = 'C:\\Vibe\\AI\\has-own-memory';
    const own = path.join(home, '.claude', 'projects', projectSlug(cwd), 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'MEMORY.md'), 'project-local\n', 'utf8');

    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {} } });
    assert.ok(result.skipped.includes(own), 'real directory must be skipped');
    assert.strictEqual(fs.readFileSync(path.join(own, 'MEMORY.md'), 'utf8'), 'project-local\n');
    assert.strictEqual(fs.lstatSync(own).isSymbolicLink(), false);
  });
});

test('linking the canonical bucket to itself is a no-op', () => {
  withHome((home) => {
    const result = ensureMemoryLink(home, { homeDir: home, logger: { warn() {} } });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.linked.includes(canonicalMemoryDir(home)), false);
    assert.ok(fs.existsSync(path.join(canonicalMemoryDir(home), 'MEMORY.md')));
  });
});

test('missing canonical store degrades to a no-op instead of creating junk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memlink-empty-'));
  try {
    const result = ensureMemoryLink('C:\\Vibe\\_scratch\\inbox-x', { homeDir: home, logger: { warn() {} } });
    assert.deepStrictEqual(result.linked, []);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.skipped.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session-manager links memory once per spawn and skips isolated hubs', () => {
  assert.match(
    SESSION_MANAGER_SRC,
    /if \(!process\.env\.CLAUDE_HUB_DATA_DIR\) \{\s*\n\s*try \{ ensureMemoryLink\(spawnCwd\); \}/,
    'link must run at spawn for every session kind, but never inside an isolated hub / E2E run',
  );
  const spawnAt = SESSION_MANAGER_SRC.indexOf('ensureMemoryLink(spawnCwd)');
  const cwdAt = SESSION_MANAGER_SRC.indexOf('if (!spawnCwd) spawnCwd =');
  assert.ok(cwdAt > 0 && spawnAt > cwdAt, 'link must run after the cwd fallback is resolved');
});

if (!process.exitCode) console.log('All claude memory link tests passed.');
