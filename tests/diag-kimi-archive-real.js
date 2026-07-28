'use strict';
// 用真实 kimi.exe 证明两件事（隔离 KIMI_CODE_HOME，绝不碰用户真实会话）：
//   A. 归档改路径后 `kimi --session <id>` 会因 "created under a different directory" 退出
//   B. 跑过 migrateKimiSession 之后同一条命令不再报这个错
//   node tests/diag-kimi-archive-real.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { kimiWorkspaceKey, migrateKimiSession, toPosix } = require('../core/kimi-session-migrator.js');

const KIMI_EXE = path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe');
const REAL_HOME = path.join(os.homedir(), '.kimi-code');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `kimi-arch-${Date.now()}-`));
const HOME = path.join(ROOT, 'kimi-home');
const SRC_CWD = path.join(ROOT, 'inbox-fake-task');
const DST_CWD = path.join(ROOT, 'archived-project');

// 从用户真实 home 里挑一个会话，复制进隔离 home 当样本。
function seedIsolatedHome() {
  const idx = path.join(REAL_HOME, 'session_index.jsonl');
  const entries = fs.readFileSync(idx, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter(e => e.sessionDir && fs.existsSync(path.join(e.sessionDir, 'state.json')));
  if (entries.length === 0) throw new Error('用户 home 里没有可用作样本的 kimi 会话');
  const sample = entries[0];

  fs.mkdirSync(SRC_CWD, { recursive: true });
  const key = kimiWorkspaceKey(SRC_CWD);
  const sessionDir = path.join(HOME, 'sessions', key, sample.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.cpSync(sample.sessionDir, sessionDir, { recursive: true });

  // 把样本改写成"这个会话属于 SRC_CWD"
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.workDir = toPosix(SRC_CWD);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  fs.writeFileSync(path.join(HOME, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: sample.sessionId, sessionDir: toPosix(sessionDir), workDir: toPosix(SRC_CWD) })}\n`, 'utf8');
  fs.writeFileSync(path.join(HOME, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: { [key]: { root: toPosix(SRC_CWD), name: path.basename(SRC_CWD), created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } },
  }, null, 2), 'utf8');
  // 凭证：没有它 kimi 会先要求登录，掩盖我们要观察的错误
  for (const f of ['credentials', 'config.toml', 'device_id', 'AGENTS.md', 'tui.toml']) {
    const src = path.join(REAL_HOME, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(HOME, f), { recursive: true });
  }
  return sample.sessionId;
}

// 起 kimi，抓前几秒输出后杀掉（成功时它是常驻 TUI，不会自己退出）
function probeKimi(cwd, sessionId, label) {
  return new Promise(resolve => {
    const child = spawn(KIMI_EXE, ['--yolo', '--session', sessionId], {
      cwd,
      env: { ...process.env, KIMI_CODE_HOME: HOME },
      windowsHide: true,
    });
    let out = '';
    let exited = false;
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('exit', code => {
      exited = true;
      finish(code);
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 9000);
    let done = false;
    function finish(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const wrongDir = /created under a different directory/i.test(out);
      resolve({
        label,
        exitedOnItsOwn: exited,
        exitCode: code,
        wrongDirectoryError: wrongDir,
        tail: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter(Boolean).slice(-4),
      });
    }
  });
}

async function main() {
  if (!fs.existsSync(KIMI_EXE)) throw new Error(`kimi.exe 不存在: ${KIMI_EXE}`);
  fs.mkdirSync(HOME, { recursive: true });
  const sessionId = seedIsolatedHome();
  console.log('样本 session:', sessionId);
  console.log('隔离 KIMI_CODE_HOME:', HOME);

  // A. 模拟归档：目录改名，但不动 kimi 注册表 —— 现状
  fs.renameSync(SRC_CWD, DST_CWD);
  const before = await probeKimi(DST_CWD, sessionId, 'A-归档后未迁移(现状)');
  console.log('\n[A] 归档后直接 --session：', JSON.stringify(before, null, 1));

  // B. 跑迁移后重试
  const result = migrateKimiSession({ sessionId, toCwd: DST_CWD, homeDir: HOME });
  console.log('\n迁移结果:', JSON.stringify(result, null, 1));
  const after = await probeKimi(DST_CWD, sessionId, 'B-迁移后');
  console.log('\n[B] 迁移后 --session：', JSON.stringify(after, null, 1));

  console.log('\n=== 结论 ===');
  console.log(`修复前报 "created under a different directory": ${before.wrongDirectoryError}`);
  console.log(`修复后报 "created under a different directory": ${after.wrongDirectoryError}`);
  const fixed = before.wrongDirectoryError === true && after.wrongDirectoryError === false;
  console.log(fixed ? '✅ 迁移解决了问题' : '❌ 未达成预期');
  process.exitCode = fixed ? 0 : 1;
}

main()
  .catch(err => { console.error('diag failed:', err && err.message); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
