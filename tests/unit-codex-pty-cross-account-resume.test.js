'use strict';
// 2026-09-26 生产现场：全局 Codex 账号切到 default 后，群聊里 second 账号的
// Codex 成员全部恢复失败 —— PTY 的 `codex resume <sid>` 只按 id 查 CODEX_HOME
// 下的线程索引，报 "No saved session found"。原生模式靠 app-server 的
// thread/resume{path} + sqlite_home 指回原历史；PTY 必须用 CODEX_SQLITE_HOME 对齐。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { historySqliteHomeSync } = require('../core/codex-global-account');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pty-xacct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'second');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, env: { CLAUDE_HUB_DATA_DIR: path.join(root, 'hub') } };
}

test('history index defaults to the history home itself', t => {
  const { home, env } = tmp(t);
  assert.equal(historySqliteHomeSync(home, null, env), path.resolve(home));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\n[tui]\nsqlite_home = "elsewhere"\n');
  assert.equal(historySqliteHomeSync(home, null, env), path.resolve(home), 'a table-scoped key is not the top-level sqlite_home');
});

test('a top-level sqlite_home in the history account wins; relative paths resolve against that home', t => {
  const { root, home, env } = tmp(t);
  fs.writeFileSync(path.join(home, 'config.toml'), "sqlite_home = 'db'\n");
  assert.equal(historySqliteHomeSync(home, null, env), path.join(home, 'db'));
  const abs = path.join(root, 'abs-db');
  fs.writeFileSync(path.join(home, 'config.toml'), `sqlite_home = "${abs.replace(/\\/g, '/')}"\n`);
  assert.equal(historySqliteHomeSync(home, null, env), path.resolve(abs));
});

test('a value probed earlier by Codex itself is reused', t => {
  const { root, home, env } = tmp(t);
  const persisted = path.join(root, 'probed');
  assert.equal(historySqliteHomeSync(home, persisted, env), path.resolve(persisted));
});

test('unreadable sqlite_home blocks the resume instead of guessing another database', t => {
  const { home, env } = tmp(t);
  fs.writeFileSync(path.join(home, 'config.toml'), 'sqlite_home = "C:\\\\esc\\\\aped"\n');
  assert.throws(() => historySqliteHomeSync(home, null, env), /sqlite_home 写法无法识别/);
  fs.writeFileSync(path.join(home, 'config.toml'), 'sqlite_home = "unterminated\n');
  assert.throws(() => historySqliteHomeSync(home, null, env), /config\.toml 无法识别/);
});

test('test isolation rejects a history index outside the test root', t => {
  const { home, env } = tmp(t);
  assert.throws(() => historySqliteHomeSync(home, path.join(os.homedir(), '.codex'), env), /不在隔离目录内/);
});

test('PTY Codex resume/fork across accounts passes the history index on that one command only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const at = src.indexOf('codexPtySqliteHome = require(\'./codex-global-account\')');
  assert.ok(at > 0, 'PTY path must resolve the history index');
  const guard = src.slice(src.lastIndexOf('if (isPtyAgent && followsGlobalAccount', at), at);
  assert.match(guard, /opts\.codexForkSid \|\| \(opts\.useResume && opts\.codexSid\)/, 'only exact resume / fork need the old index');
  assert.match(guard, /toLowerCase\(\) !== /, 'same-account launches keep Codex defaults');
  // 审查发现：写进 sessionEnv 会留在整个 PowerShell 里，CLI 退出后同一终端新开的 codex
  // 会把新会话登记进旧账号的索引。
  assert.doesNotMatch(src, /sessionEnv\.CODEX_SQLITE_HOME\s*=/, 'the old index must not leak into the PTY shell environment');
  assert.match(src, /if \(codexPtySqliteHome\) cmd \+= ` -c "sqlite_home='\$\{codexPtySqliteHome\}'"`;/, 'passed as a TOML literal on the resume/fork command');
  assert.match(src, /\/\['"`\$\\r\\n\]\/\.test\(codexPtySqliteHome\)/, 'paths that cannot cross PowerShell + TOML quoting are rejected');
});
