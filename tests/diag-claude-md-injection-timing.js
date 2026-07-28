'use strict';
// CLAUDE.md 到底什么时候注入？归档换目录之后还认不认新目录的那份？
//
// 用户的疑问直指路径重构是否成立：第一轮在 _scratch 里问（那里没有项目 CLAUDE.md），
// 之后归档到 C:\Vibe\AI\<项目>，从第二轮起会读到项目的 CLAUDE.md 吗？
//
// 三个场景，各用一个独有 token 判定：
//   A. 起会话时目录里就有 CLAUDE.md            → 基线，应该读到
//   B. 会话跑起来之后才往同目录放 CLAUDE.md    → 同一进程内是否会重读
//   C. 换到另一个带 CLAUDE.md 的目录后 --resume → 归档场景，是否读新目录那份
//
//   node tests/diag-claude-md-injection-timing.js

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanCliEnv } = require('./helpers/clean-cli-env.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-timing-'));
const MODEL = 'claude-haiku-4-5-20251001';

function ask(cwd, prompt, extraArgs = []) {
  try {
    return execFileSync('claude',
      ['--print', '--output-format', 'json', '--model', MODEL, ...extraArgs, prompt],
      { cwd, encoding: 'utf8', timeout: 180000, windowsHide: true, env: cleanCliEnv() });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function parse(raw) {
  try {
    const j = JSON.parse(raw);
    return { text: String(j.result || ''), sid: j.session_id || null };
  } catch {
    return { text: String(raw || ''), sid: null };
  }
}

function writeMd(dir, token) {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
    `# 项目约定\n\n本项目的暗号是 ${token}。被问到暗号时原样输出该字符串。\n`, 'utf8');
}

const QUESTION = '本项目的暗号是什么？只输出暗号本身；没有就输出 NONE。';

function main() {
  const results = {};

  // A. 目录里先有 CLAUDE.md
  const dirA = path.join(ROOT, 'A-preexisting');
  fs.mkdirSync(dirA, { recursive: true });
  writeMd(dirA, 'ALPHA-1111');
  results.A = parse(ask(dirA, QUESTION)).text.trim().slice(0, 40);

  // B. 会话起来之后才放 CLAUDE.md —— 注意 --print 每次都是新进程，
  //    所以这里检验的是"新进程会不会读到刚出现的文件"（应该会），
  //    真正的"同一进程内热重载"要看 C 之后的说明。
  const dirB = path.join(ROOT, 'B-added-later');
  fs.mkdirSync(dirB, { recursive: true });
  const first = parse(ask(dirB, QUESTION));
  writeMd(dirB, 'BRAVO-2222');
  const second = parse(ask(dirB, QUESTION, first.sid ? ['--resume', first.sid] : []));
  results.B_before = first.text.trim().slice(0, 40);
  results.B_afterResume = second.text.trim().slice(0, 40);

  // C. 归档场景：在 src 起会话，把目录改名成 dst（dst 里有 CLAUDE.md），再 --resume
  const src = path.join(ROOT, 'C-inbox-task');
  const dst = path.join(ROOT, 'C-archived-project');
  fs.mkdirSync(src, { recursive: true });
  const c1 = parse(ask(src, QUESTION));
  results.C_beforeArchive = c1.text.trim().slice(0, 40);

  fs.renameSync(src, dst);
  writeMd(dst, 'CHARLIE-3333');
  // 把 transcript 搬到新目录对应的桶里（Hub 归档流程做的就是这件事）
  try {
    const { migrateTranscriptsForCwdChange } = require('../core/claude-transcript-locator.js');
    if (c1.sid) migrateTranscriptsForCwdChange({ toCwd: dst, ccSessionIds: [c1.sid] });
  } catch (e) { console.warn('transcript 迁移失败:', e.message); }
  const c2 = parse(ask(dst, QUESTION, c1.sid ? ['--resume', c1.sid] : []));
  results.C_afterArchiveResume = c2.text.trim().slice(0, 40);

  console.log('\n=== 结果 ===');
  console.log(`A 目录里本来就有 CLAUDE.md          : ${results.A}`);
  console.log(`B 放 CLAUDE.md 之前                 : ${results.B_before}`);
  console.log(`B 放 CLAUDE.md 之后再 --resume      : ${results.B_afterResume}`);
  console.log(`C 归档前（源目录无 CLAUDE.md）      : ${results.C_beforeArchive}`);
  console.log(`C 归档到有 CLAUDE.md 的目录后 resume: ${results.C_afterArchiveResume}`);

  console.log('\n=== 判定 ===');
  const aOk = /ALPHA-1111/.test(results.A);
  const bOk = /BRAVO-2222/.test(results.B_afterResume);
  const cOk = /CHARLIE-3333/.test(results.C_afterArchiveResume);
  console.log(`A 基线注入            : ${aOk ? '✅ 读到' : '❌ 没读到'}`);
  console.log(`B 后放的 CLAUDE.md    : ${bOk ? '✅ 下一轮就读到' : '❌ 读不到'}`);
  console.log(`C 归档后新目录那份    : ${cOk ? '✅ 读到 —— 路径重构成立' : '❌ 读不到 —— 归档后拿不到项目约定'}`);
}

try { main(); } finally { fs.rmSync(ROOT, { recursive: true, force: true }); }
