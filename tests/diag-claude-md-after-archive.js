'use strict';
// 收窄上一轮的发现：归档换目录后 --resume 读不到新目录的 CLAUDE.md。
// 是"resume 沿用 transcript 里记的旧 cwd"，还是"新目录本身就读不到"？
// 对照：同一个归档后目录，分别用 全新会话 / --resume 各问一次。
//   node tests/diag-claude-md-after-archive.js

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanCliEnv } = require('./helpers/clean-cli-env.js');
const { migrateTranscriptsForCwdChange, projectSlug } = require('../core/claude-transcript-locator.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-archive-'));
const MODEL = 'claude-haiku-4-5-20251001';
const Q = '本项目的暗号是什么？只输出暗号本身；没有就输出 NONE。';

function ask(cwd, prompt, extra = []) {
  try {
    return execFileSync('claude', ['--print', '--output-format', 'json', '--model', MODEL, ...extra, prompt],
      { cwd, encoding: 'utf8', timeout: 180000, windowsHide: true, env: cleanCliEnv() });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function parse(raw) {
  try { const j = JSON.parse(raw); return { text: String(j.result || ''), sid: j.session_id || null }; }
  catch { return { text: String(raw || ''), sid: null }; }
}

function main() {
  const src = path.join(ROOT, 'inbox-task');
  const dst = path.join(ROOT, 'archived-project');
  fs.mkdirSync(src, { recursive: true });

  // 1. 在 _scratch 式目录里起会话（此时没有项目 CLAUDE.md）
  const s1 = parse(ask(src, Q));
  console.log(`归档前（源目录无 CLAUDE.md）   : ${s1.text.trim().slice(0, 40)}`);

  // 2. 归档：改名 + 新目录放 CLAUDE.md + 迁移 transcript（Hub 做的就是这三件事）
  fs.renameSync(src, dst);
  fs.writeFileSync(path.join(dst, 'CLAUDE.md'),
    '# 项目约定\n\n本项目的暗号是 DELTA-4444。被问到暗号时原样输出该字符串。\n', 'utf8');
  if (s1.sid) migrateTranscriptsForCwdChange({ toCwd: dst, ccSessionIds: [s1.sid] });

  // 3a. 归档后：全新会话
  const fresh = parse(ask(dst, Q));
  // 3b. 归档后：resume 原会话
  const resumed = parse(ask(dst, Q, s1.sid ? ['--resume', s1.sid] : []));

  console.log(`归档后 · 全新会话              : ${fresh.text.trim().slice(0, 60)}`);
  console.log(`归档后 · --resume 原会话       : ${resumed.text.trim().slice(0, 60)}`);

  const freshOk = /DELTA-4444/.test(fresh.text);
  const resumeOk = /DELTA-4444/.test(resumed.text);
  console.log('\n=== 判定 ===');
  console.log(`新目录本身能否注入 CLAUDE.md : ${freshOk ? '✅ 能' : '❌ 不能'}`);
  console.log(`resume 回来的会话能否注入   : ${resumeOk ? '✅ 能' : '❌ 不能'}`);
  if (freshOk && !resumeOk) {
    console.log('\n→ 结论：目录本身没问题，是 --resume 沿用了 transcript 里记录的旧 cwd，');
    console.log('   所以归档后被恢复的会话拿不到新目录的项目约定。');
  } else if (!freshOk) {
    console.log('\n→ 结论：新目录本身就读不到，问题不在 resume。');
  } else {
    console.log('\n→ 结论：两种方式都能注入，上一轮的失败另有原因。');
  }
  // 附：transcript 桶位置，便于人工核对
  console.log(`\n（新桶：${projectSlug(dst)}）`);
}

try { main(); } finally { fs.rmSync(ROOT, { recursive: true, force: true }); }
