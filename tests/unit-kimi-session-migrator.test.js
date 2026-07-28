'use strict';
// Kimi 把会话绑死在 cwd 上并且会校验：归档改路径后 `kimi --session <id>` 会打印
// "was created under a different directory" 并以 exit 1 退出（2026-07-27 用真实
// kimi.exe 在隔离 KIMI_CODE_HOME 里复现，见 tests/diag-kimi-archive-real.js）。
// Hub 的 PTY spawn 仍然成功，所以 Hub 完全察觉不到——用户拿到一个死终端。
// 这些测试锁住迁移逻辑和它在归档流程里的接线。

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  kimiWorkspaceKey,
  lookupKimiSession,
  migrateKimiSession,
  toPosix,
} = require('../core/kimi-session-migrator.js');

const HANDLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'workspace-handlers.js'), 'utf8');

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

function seedHome(home, sessionId, cwd) {
  const key = kimiWorkspaceKey(cwd);
  const sessionDir = path.join(home, 'sessions', key, sessionId);
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'),
    JSON.stringify({ workDir: toPosix(cwd), other: 'keep-me' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), '{"t":"payload"}\n', 'utf8');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId, sessionDir: toPosix(sessionDir), workDir: toPosix(cwd) })}\n`, 'utf8');
  fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: { [key]: { root: toPosix(cwd), name: path.basename(cwd), created_at: 'T0', last_opened_at: 'T0' } },
  }, null, 2), 'utf8');
  return { key, sessionDir };
}

function withHome(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-mig-'));
  try { fn(path.join(root, 'home'), root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('Running kimi session migrator tests...');

test('workspace key is wd_<slug(basename)>_<sha256(posix path) first 12 hex>', () => {
  // 5 组真实 key（来自用户 ~/.kimi-code/workspaces.json）全部复算通过
  const known = {
    'C:/Users/lintian/claude-session-hub': 'wd_claude-session-hub_02c7bbc0f2e1',
    'C:/Users/lintian': 'wd_lintian_efc895266f60',
    'C:/Users/lintian/chuxin-research': 'wd_chuxin-research_1cb58250bac4',
    'C:/Vibe/_scratch/inbox-20260727-201613-011200': 'wd_inbox-20260727-201613-011200_d99e001aaf10',
    'C:/Vibe/_scratch/inbox-20260727-202311-c1a2f1': 'wd_inbox-20260727-202311-c1a2f1_96448668793b',
    // 2026-07-28 真实 kimi.exe（隔离 KIMI_CODE_HOME）在这两个目录里实际创建的桶：
    // basename 要先 slug 化——小写、非 [a-z0-9._-] 折叠成 -、40 字符截断。
    'C:/Vibe/_scratch/hub-kimi-slug-test/AI-HUB路径重构排查-LongNameTest': 'wd_ai-hub--longnametest_c6a3d5e233e0',
    'C:/Vibe/_scratch/hub-kimi-slug-test/Very-Long Project Name With Spaces And MANY Uppercase Letters 2026': 'wd_very-long-project-name-with-spaces-and-m_32b105079b26',
  };
  for (const [p, expected] of Object.entries(known)) {
    assert.strictEqual(kimiWorkspaceKey(p), expected, `key mismatch for ${p}`);
  }
  // 算法自洽性：换个路径也应是 sha256 前 12 位
  const probe = 'C:/tmp/x';
  const digest = crypto.createHash('sha256').update(probe, 'utf8').digest('hex').slice(0, 12);
  assert.strictEqual(kimiWorkspaceKey(probe), `wd_x_${digest}`);
  // slug 边界：全中文目录名折叠后为空 → 兜底 'workspace'
  const cnOnly = 'C:/tmp/路径';
  const cnDigest = crypto.createHash('sha256').update(cnOnly, 'utf8').digest('hex').slice(0, 12);
  assert.strictEqual(kimiWorkspaceKey(cnOnly), `wd_workspace_${cnDigest}`);
});

test('migration moves the session dir and rewrites all four workDir records', () => {
  withHome((home, root) => {
    fs.mkdirSync(home, { recursive: true });
    const sessionId = 'session_abc';
    const from = path.join(root, 'inbox-task');
    const to = path.join(root, 'archived');
    fs.mkdirSync(from, { recursive: true });
    const { sessionDir: oldDir } = seedHome(home, sessionId, from);
    fs.mkdirSync(to, { recursive: true });

    const result = migrateKimiSession({ sessionId, toCwd: to, homeDir: home });
    assert.strictEqual(result.ok, true, result.reason);

    // 1. 目录搬到新 workspace key 下，内容完整
    const newKey = kimiWorkspaceKey(to);
    const newDir = path.join(home, 'sessions', newKey, sessionId);
    assert.strictEqual(result.sessionDir, newDir);
    assert.ok(fs.existsSync(newDir), 'session dir must exist at the new key');
    assert.strictEqual(fs.existsSync(oldDir), false, 'old session dir must be gone');
    assert.strictEqual(
      fs.readFileSync(path.join(newDir, 'agents', 'main', 'wire.jsonl'), 'utf8'), '{"t":"payload"}\n',
      'transcript payload must survive the move');

    // 2. state.json
    const state = JSON.parse(fs.readFileSync(path.join(newDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.workDir, toPosix(to));
    assert.strictEqual(state.other, 'keep-me', 'unrelated state fields must be preserved');

    // 3. workspaces.json
    const ws = JSON.parse(fs.readFileSync(path.join(home, 'workspaces.json'), 'utf8'));
    assert.strictEqual(ws.workspaces[newKey].root, toPosix(to));
    assert.ok(ws.workspaces[kimiWorkspaceKey(from)], 'the old workspace entry stays for other sessions');

    // 4. session_index.jsonl
    const idx = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    assert.strictEqual(idx.length, 1);
    assert.strictEqual(idx[0].workDir, toPosix(to));
    assert.strictEqual(idx[0].sessionDir, toPosix(newDir));
  });
});

test('state.json agent homedirs inside the old session dir are remapped', () => {
  withHome((home, root) => {
    fs.mkdirSync(home, { recursive: true });
    const sessionId = 'session_homedir';
    const from = path.join(root, 'inbox-task');
    const to = path.join(root, 'archived');
    fs.mkdirSync(from, { recursive: true });
    const { sessionDir: oldDir } = seedHome(home, sessionId, from);
    const state = JSON.parse(fs.readFileSync(path.join(oldDir, 'state.json'), 'utf8'));
    state.agents = {
      main: { homedir: path.join(oldDir, 'agents', 'main'), type: 'main' },
      sub: { homedir: 'C:/elsewhere/agents/sub', type: 'subagent' },
    };
    fs.writeFileSync(path.join(oldDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
    fs.mkdirSync(to, { recursive: true });

    const result = migrateKimiSession({ sessionId, toCwd: to, homeDir: home });
    assert.strictEqual(result.ok, true, result.reason);

    const migrated = JSON.parse(fs.readFileSync(path.join(result.sessionDir, 'state.json'), 'utf8'));
    assert.strictEqual(migrated.agents.main.homedir, path.join(result.sessionDir, 'agents', 'main'),
      'homedir under the old session dir must follow the move');
    assert.strictEqual(migrated.agents.sub.homedir, 'C:/elsewhere/agents/sub',
      'homedir pointing outside the session dir must stay untouched');
  });
});

test('duplicate index lines for the same sessionId are all updated', () => {
  withHome((home, root) => {
    fs.mkdirSync(home, { recursive: true });
    const sessionId = 'session_dup';
    const from = path.join(root, 'inbox-task');
    const to = path.join(root, 'archived');
    fs.mkdirSync(from, { recursive: true });
    const { sessionDir: oldDir } = seedHome(home, sessionId, from);
    // 历史原因（重试/多实例）可能给同一 sessionId 写两行，旧实现只改第一行。
    fs.appendFileSync(path.join(home, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId, sessionDir: toPosix(oldDir), workDir: toPosix(from) })}\n`, 'utf8');
    fs.mkdirSync(to, { recursive: true });

    const result = migrateKimiSession({ sessionId, toCwd: to, homeDir: home });
    assert.strictEqual(result.ok, true, result.reason);

    const idx = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    assert.strictEqual(idx.length, 2);
    for (const entry of idx) {
      assert.strictEqual(entry.workDir, toPosix(to), 'every duplicate line must be migrated');
      assert.strictEqual(entry.sessionDir, toPosix(result.sessionDir));
    }
  });
});

test('lookupKimiSession reads the index without mutating anything', () => {
  withHome((home, root) => {
    fs.mkdirSync(home, { recursive: true });
    const from = path.join(root, 'inbox-task');
    fs.mkdirSync(from, { recursive: true });
    const { sessionDir } = seedHome(home, 'session_lookup', from);
    const hit = lookupKimiSession('session_lookup', { homeDir: home });
    assert.strictEqual(hit.workDir, toPosix(from));
    assert.strictEqual(hit.sessionDir, toPosix(sessionDir));
    assert.strictEqual(lookupKimiSession('session_nope', { homeDir: home }), null);
  });
});

test('other sessions in the index are left untouched', () => {
  withHome((home, root) => {
    fs.mkdirSync(home, { recursive: true });
    const from = path.join(root, 'inbox-task');
    const to = path.join(root, 'archived');
    fs.mkdirSync(from, { recursive: true });
    fs.mkdirSync(to, { recursive: true });
    seedHome(home, 'session_a', from);
    const other = { sessionId: 'session_b', sessionDir: 'C:/elsewhere/session_b', workDir: 'C:/elsewhere' };
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify(other)}\n`, 'utf8');

    migrateKimiSession({ sessionId: 'session_a', toCwd: to, homeDir: home });

    const idx = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    assert.strictEqual(idx.length, 2);
    assert.deepStrictEqual(idx.find(e => e.sessionId === 'session_b'), other);
  });
});

test('migration is idempotent', () => {
  withHome((home, root) => {
    fs.mkdirSync(home, { recursive: true });
    const from = path.join(root, 'inbox-task');
    const to = path.join(root, 'archived');
    fs.mkdirSync(from, { recursive: true });
    fs.mkdirSync(to, { recursive: true });
    seedHome(home, 'session_a', from);
    const first = migrateKimiSession({ sessionId: 'session_a', toCwd: to, homeDir: home });
    const second = migrateKimiSession({ sessionId: 'session_a', toCwd: to, homeDir: home });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.alreadyCurrent, true, 're-running must be a no-op, not an error');
  });
});

test('an unknown session reports a reason instead of throwing', () => {
  withHome((home) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), '', 'utf8');
    const r = migrateKimiSession({ sessionId: 'session_missing', toCwd: home, homeDir: home });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /not found/);
  });
});

test('archive flow migrates kimi sessions before resuming, and only kimi ones', () => {
  const migrateAt = HANDLER_SRC.indexOf('migrateKimiSession({');
  const resumeAt = HANDLER_SRC.indexOf('const restart = await resumeAll(');
  assert.ok(migrateAt > 0, 'archive-and-restart must migrate kimi sessions');
  assert.ok(resumeAt > migrateAt, 'kimi migration must run before the CLIs are resumed');
  assert.match(HANDLER_SRC, /baseKind\(snapshot\.kind\) !== 'kimi' \|\| !snapshot\.kimiSid/,
    'only kimi snapshots with a bound sid may be migrated');
  assert.match(HANDLER_SRC, /toCwd: workspace\.path/, 'target must be the archived path');
});

if (!process.exitCode) console.log('All kimi session migrator tests passed.');
