'use strict';
// CLAUDE.md 是"每轮提问都重新读盘"，还是"进程启动时读一次、之后常驻上下文"？
// 做法：交互式会话里问一次拿到暗号 A，中途把 CLAUDE.md 改成暗号 B，
// 在**同一个会话**里再问一次——答 A = 只读一次；答 B = 每轮重读。
//   node tests/diag-claude-md-per-turn.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-perturn-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][B0]/g, '');

function writeMd(token) {
  fs.writeFileSync(path.join(ROOT, 'CLAUDE.md'),
    `# 项目约定\n\n本项目的暗号是 ${token}。被问到暗号时原样输出该字符串，不要解释。\n`, 'utf8');
}

async function main() {
  writeMd('ALPHA-1111');

  const p = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
    name: 'xterm-256color', cols: 140, rows: 40, cwd: ROOT, env: process.env, useConpty: true,
  });
  let out = '';
  p.onData(d => { out += d; });

  await wait(1500);
  p.write(' claude --model claude-haiku-4-5-20251001\r\n');
  await wait(22000);          // 等 TUI 起来

  const ask = async (label) => {
    out = '';
    p.write('本项目的暗号是什么？只输出暗号本身。');
    await wait(900);
    p.write('\r');
    await wait(38000);
    const clean = strip(out);
    const a = /ALPHA-1111/.test(clean);
    const b = /BRAVO-2222/.test(clean);
    console.log(`  ${label}: ALPHA=${a}  BRAVO=${b}`);
    return { a, b };
  };

  console.log('第 1 轮（磁盘上是 ALPHA-1111）');
  const r1 = await ask('答案');

  writeMd('BRAVO-2222');
  console.log('\n>>> 已把 CLAUDE.md 改成 BRAVO-2222（同一会话继续问）');

  console.log('第 2 轮（磁盘已改成 BRAVO-2222）');
  const r2 = await ask('答案');

  try { p.kill(); } catch {}
  await wait(600);

  console.log('\n=== 判定 ===');
  if (!r1.a) {
    console.log('⚠ 第 1 轮就没读到 ALPHA，测试无效（TUI 可能没起来或超时不够）');
  } else if (r2.b && !r2.a) {
    console.log('→ 每轮都会重新读盘：改了 CLAUDE.md 下一轮立刻生效');
  } else if (r2.a && !r2.b) {
    console.log('→ 只在进程启动时读一次：改了 CLAUDE.md 要重启会话才生效');
    console.log('  （但它已在上下文里，每轮请求都会随对话历史一起发给模型）');
  } else {
    console.log(`→ 结果不明确：ALPHA=${r2.a} BRAVO=${r2.b}`);
  }
}

main()
  .catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
