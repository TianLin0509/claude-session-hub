'use strict';
// Codex rollout 迁移的备份策略回归（2026-07-29，修 P1-1 / P2-2 / P2-3）。
//
// 旧实现每次迁移都 `fs.copyFileSync(rollout, `${rollout}.pre-migrate-${Date.now()}.bak`)`：
//   P1-1 备份无限累积（真实数据里单个 rollout 最大 656 MB，~/.codex/sessions 合计 4.8 GB，
//        归档一次就多一份等大垃圾，失败也留）；
//   P2-2 alreadyCurrent 用裸字符串比 path.resolve，大小写或 `\\?\` 前缀不同就判成"要迁"，
//        白搬一遍 GB 级文件再多存一份备份；
//   P2-3 同毫秒两次迁移撞名，备份被写成"迁移后"的状态，原始 cwd 永久丢失。
//
// 这里锁住新契约：备份只存首行、落 Hub 数据目录、一个 rollout 只有一份、
// originalFirstLine 永不被后续迁移覆盖、失败不留残骸、正文字节级不变。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rewriteRolloutCwd, migrateCodexSession } = require('../core/codex-session-migrator.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error && error.stack || error)); }
}

const ORIGINAL_CWD = 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e';

function metaLine(cwd) {
  return JSON.stringify({
    timestamp: '2026-07-28T10:39:06.688Z',
    type: 'session_meta',
    payload: {
      session_id: '019fa84b-dc6b-7210-abaa-7723ed2c4e74',
      cwd,
      originator: 'codex-tui',
      cli_version: '0.144.0',
    },
  });
}

// 正文故意掺入非法 UTF-8 字节、NUL 和 CRLF：旧实现整文件 readFileSync('utf8') 往返
// 会把它们换成 U+FFFD，新实现按 Buffer 搬运必须逐字节保真。
const DIRTY_TAIL = Buffer.concat([
  Buffer.from('\n{"type":"message","payload":{"text":"正文里的 cwd 字样不许被动"}}\r\n', 'utf8'),
  Buffer.from('{"type":"raw","payload":"', 'utf8'),
  Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]),
  Buffer.from('"}\n', 'utf8'),
]);

function withRollout(fn, { cwd = ORIGINAL_CWD, tail = DIRTY_TAIL } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backup-'));
  const rolloutDir = path.join(dir, 'sessions', '2026', '07', '28');
  fs.mkdirSync(rolloutDir, { recursive: true });
  const file = path.join(rolloutDir, 'rollout-2026-07-28T10-39-06-019fa84b-dc6b-7210-abaa-7723ed2c4e74.jsonl');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(metaLine(cwd), 'utf8'), tail]));
  const opts = { backupDir: path.join(dir, 'hub-data', 'backups', 'codex') };
  try { return fn({ file, dir, rolloutDir, opts }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function listBackups(opts) {
  try { return fs.readdirSync(opts.backupDir).sort(); } catch { return []; }
}

function strayFiles(rolloutDir, file) {
  return fs.readdirSync(rolloutDir).filter(n => n !== path.basename(file)).sort();
}

function readCwd(file) {
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(0x0a);
  return JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8')).payload.cwd;
}

console.log('Running codex migrator backup strategy tests...');

// ---- P1-1：备份不再累积 -------------------------------------------------

test('P1-1 反复迁移只留一份备份，rollout 旁边不落任何文件', () => {
  withRollout(({ file, rolloutDir, opts }) => {
    for (const target of ['C:\\Vibe\\AI\\home-1', 'C:\\Vibe\\AI\\home-2', 'C:\\Vibe\\AI\\home-3']) {
      const res = rewriteRolloutCwd(file, target, opts);
      assert.strictEqual(res.ok, true, res.reason);
    }
    assert.strictEqual(listBackups(opts).length, 1, '三次迁移只能留一份备份');
    assert.deepStrictEqual(strayFiles(rolloutDir, file), [],
      'codex sessions 目录里不许多出 .bak/.tmp —— CLI 自己的 resume picker 会扫这棵树');
    assert.strictEqual(readCwd(file), 'C:\\Vibe\\AI\\home-3');
  });
});

test('P1-1 备份大小与 rollout 大小无关（只存首行）', () => {
  const bigTail = Buffer.concat([Buffer.from('\n', 'utf8'), Buffer.alloc(6 * 1024 * 1024, 0x61), Buffer.from('\n', 'utf8')]);
  withRollout(({ file, opts }) => {
    const rolloutSize = fs.statSync(file).size;
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\big', opts);
    assert.strictEqual(res.ok, true, res.reason);
    const backupSize = fs.statSync(res.backup).size;
    assert.ok(rolloutSize > 6 * 1024 * 1024, `rollout 应该是 MB 级，实际 ${rolloutSize}`);
    assert.ok(backupSize < 4096, `备份必须是 KB 级 sidecar，实际 ${backupSize}`);
  }, { tail: bigTail });
});

test('P1-1 迁移成功后顺手清掉旧实现留下的全量 .bak', () => {
  withRollout(({ file, rolloutDir, opts }) => {
    const legacyA = `${file}.pre-migrate-1753700000000.bak`;
    const legacyB = `${file}.pre-migrate-1753700000001.bak`;
    const keepA = `${file}.pre-migrate-manual.bak`;   // 非本模式，不许动
    const keepB = path.join(rolloutDir, 'unrelated.bak');
    for (const p of [legacyA, legacyB, keepA, keepB]) fs.writeFileSync(p, 'x');

    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home', opts);
    assert.strictEqual(res.ok, true, res.reason);
    assert.strictEqual(fs.existsSync(legacyA), false);
    assert.strictEqual(fs.existsSync(legacyB), false);
    assert.strictEqual(fs.existsSync(keepA), true, '只清 `.pre-migrate-<数字>.bak` 这一种');
    assert.strictEqual(fs.existsSync(keepB), true);
    assert.strictEqual(res.prunedLegacyBackups.length, 2);
  });
});

test('默认备份目录跟随 CLAUDE_HUB_DATA_DIR，不写 ~/.codex 也不写生产 Hub 目录', () => {
  withRollout(({ file, rolloutDir, dir }) => {
    const hubDir = path.join(dir, 'isolated-hub');
    const prev = process.env.CLAUDE_HUB_DATA_DIR;
    process.env.CLAUDE_HUB_DATA_DIR = hubDir;
    try {
      const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home');
      assert.strictEqual(res.ok, true, res.reason);
      assert.strictEqual(res.backup.startsWith(path.join(hubDir, 'backups', 'codex')), true, res.backup);
      assert.strictEqual(fs.existsSync(res.backup), true);
      assert.deepStrictEqual(strayFiles(rolloutDir, file), []);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
      else process.env.CLAUDE_HUB_DATA_DIR = prev;
    }
  });
});

// ---- P2-2：alreadyCurrent 短路 ------------------------------------------

const SHORT_CIRCUIT_CASES = [
  ['大小写不同', ORIGINAL_CWD, 'c:\\vibe\\_scratch\\INBOX-20260728-183610-6ADE8E'],
  ['rollout 带 \\\\?\\ 长路径前缀', `\\\\?\\${ORIGINAL_CWD}`, ORIGINAL_CWD],
  ['目标带 \\\\?\\ 长路径前缀', ORIGINAL_CWD, `\\\\?\\${ORIGINAL_CWD}`],
  ['两边都带 \\\\?\\ 且大小写不同', `\\\\?\\${ORIGINAL_CWD}`, `\\\\?\\${ORIGINAL_CWD.toUpperCase()}`],
  ['正斜杠混用', ORIGINAL_CWD, 'C:/Vibe/_scratch/inbox-20260728-183610-6ade8e'],
  ['尾随分隔符', ORIGINAL_CWD, `${ORIGINAL_CWD}\\`],
];

for (const [label, storedCwd, targetCwd] of SHORT_CIRCUIT_CASES) {
  test(`P2-2 ${label} 时走 alreadyCurrent 短路（不重写、不备份）`, () => {
    withRollout(({ file, rolloutDir, opts }) => {
      const before = fs.readFileSync(file);
      const mtimeBefore = fs.statSync(file).mtimeMs;
      const res = rewriteRolloutCwd(file, targetCwd, opts);
      assert.strictEqual(res.ok, true, res.reason);
      assert.strictEqual(res.alreadyCurrent, true, `${storedCwd} → ${targetCwd} 应判为同一目录`);
      assert.strictEqual(fs.statSync(file).mtimeMs, mtimeBefore, '短路时不该碰文件');
      assert.strictEqual(Buffer.compare(fs.readFileSync(file), before), 0);
      assert.deepStrictEqual(listBackups(opts), [], '短路时不该产生备份');
      assert.deepStrictEqual(strayFiles(rolloutDir, file), []);
    }, { cwd: storedCwd });
  });
}

test('P2-2 真的不同的目录仍然照常迁移（短路不能误伤）', () => {
  withRollout(({ file, opts }) => {
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8f', opts);
    assert.strictEqual(res.ok, true, res.reason);
    assert.notStrictEqual(res.alreadyCurrent, true);
    assert.strictEqual(readCwd(file), 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8f');
  });
});

// ---- P2-3：同毫秒/多次迁移不丢原始 cwd ---------------------------------

test('P2-3 同一毫秒内连迁两次，备份里仍是最初的 cwd', () => {
  withRollout(({ file, opts }) => {
    const realNow = Date.now;
    Date.now = () => 1753800000000;
    try {
      assert.strictEqual(rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\step-1', opts).ok, true);
      assert.strictEqual(rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\step-2', opts).ok, true);
    } finally {
      Date.now = realNow;
    }
    const backups = listBackups(opts);
    assert.strictEqual(backups.length, 1, '同毫秒两次迁移不许各留一份，也不许撞名互相覆盖');
    const record = JSON.parse(fs.readFileSync(path.join(opts.backupDir, backups[0]), 'utf8'));
    assert.strictEqual(record.originalCwd, ORIGINAL_CWD, '最初的 cwd 必须还在（旧实现会被冲成 step-1）');
    assert.strictEqual(JSON.parse(record.originalFirstLine).payload.cwd, ORIGINAL_CWD);
    assert.strictEqual(record.previousCwd, 'C:\\Vibe\\AI\\step-1', '上一次改写前的状态也要留着，供回滚最后那次写入');
    assert.strictEqual(record.migrations, 2);
  });
});

// ---- 失败清理 -----------------------------------------------------------

function withBrokenRename(file, fn) {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === path.resolve(file)) throw new Error('注入故障：rename 失败');
    return real(from, to);
  };
  try { return fn(); } finally { fs.renameSync = real; }
}

test('迁移失败时不留备份、不留 .tmp，rollout 逐字节不变', () => {
  withRollout(({ file, rolloutDir, opts }) => {
    const before = fs.readFileSync(file);
    withBrokenRename(file, () => {
      assert.throws(() => rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home', opts), /注入故障/);
    });
    assert.deepStrictEqual(listBackups(opts), [], '失败的迁移不许留下备份');
    assert.deepStrictEqual(strayFiles(rolloutDir, file), [], '失败的迁移不许留下 .tmp');
    assert.strictEqual(Buffer.compare(fs.readFileSync(file), before), 0, 'rollout 必须原封不动');
  });
});

test('迁移失败时不覆盖已有的历史备份', () => {
  withRollout(({ file, opts }) => {
    assert.strictEqual(rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home-1', opts).ok, true);
    const backupPath = path.join(opts.backupDir, listBackups(opts)[0]);
    const before = fs.readFileSync(backupPath, 'utf8');

    withBrokenRename(file, () => {
      assert.throws(() => rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home-2', opts), /注入故障/);
    });
    assert.strictEqual(listBackups(opts).length, 1);
    assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), before,
      '失败要回滚到动手之前的备份内容，不能把 migrations/previousCwd 记成没发生过的那次');
    const record = JSON.parse(before);
    assert.strictEqual(record.originalCwd, ORIGINAL_CWD);
    assert.strictEqual(record.migrations, 1);
  });
});

test('migrateCodexSession 把底层异常降级成 { ok:false }，不反向拖垮归档', () => {
  withRollout(({ file, dir, opts }) => {
    const sessionsRoot = path.join(dir, 'sessions');
    withBrokenRename(file, () => {
      const res = migrateCodexSession({
        sessionId: '019fa84b-dc6b-7210-abaa-7723ed2c4e74',
        toCwd: 'C:\\Vibe\\AI\\home',
        sessionsRoot,
        backupDir: opts.backupDir,
      });
      assert.strictEqual(res.ok, false);
      assert.match(res.reason, /改写 rollout cwd 失败/);
    });
    assert.deepStrictEqual(listBackups(opts), []);
  });
});

test('migrateCodexSession 正常路径：按 sid 定位并迁移，备份进指定目录', () => {
  withRollout(({ file, dir, rolloutDir, opts }) => {
    const res = migrateCodexSession({
      sessionId: '019fa84b-dc6b-7210-abaa-7723ed2c4e74',
      toCwd: 'C:\\Vibe\\AI\\home',
      sessionsRoot: path.join(dir, 'sessions'),
      backupDir: opts.backupDir,
    });
    assert.strictEqual(res.ok, true, res.reason);
    assert.strictEqual(path.resolve(res.rolloutPath), path.resolve(file));
    assert.strictEqual(listBackups(opts).length, 1);
    assert.deepStrictEqual(strayFiles(rolloutDir, file), []);
  });
});

// ---- 字节保真 -----------------------------------------------------------

test('首行之后逐字节不变（含非法 UTF-8 / NUL / CRLF）', () => {
  withRollout(({ file, opts }) => {
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home', opts);
    assert.strictEqual(res.ok, true, res.reason);
    const after = fs.readFileSync(file);
    const nl = after.indexOf(0x0a);
    assert.ok(nl > 0, '首行换行符必须还在');
    assert.strictEqual(Buffer.compare(after.subarray(nl), DIRTY_TAIL), 0,
      '正文必须与原文件逐字节一致（旧实现的 utf8 往返会把坏字节换成 U+FFFD）');
    assert.strictEqual(readCwd(file), 'C:\\Vibe\\AI\\home');
  });
});

test('CRLF 行尾的 rollout 改写后仍是 CRLF', () => {
  const tail = Buffer.from('\r\n{"type":"message","payload":{"text":"crlf"}}\r\n', 'utf8');
  withRollout(({ file, opts }) => {
    // 首行末尾的 \r 属于第一行，改写后必须补回去，否则首行变 LF、其余是 CRLF。
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\home', opts);
    assert.strictEqual(res.ok, true, res.reason);
    const after = fs.readFileSync(file);
    const nl = after.indexOf(0x0a);
    assert.strictEqual(after[nl - 1], 0x0d, '首行必须保留 \\r');
    assert.strictEqual(Buffer.compare(after.subarray(nl), tail.subarray(1)), 0);
    assert.strictEqual(readCwd(file), 'C:\\Vibe\\AI\\home');
  }, { tail });
});

if (failed > 0) {
  console.error(`codex migrator backup: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('All codex migrator backup tests passed.');
}
