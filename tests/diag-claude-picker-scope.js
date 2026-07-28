'use strict';
// Claude 的 --resume picker 是不是只看当前目录？有没有"看全部"的开关？
// 在一个空目录里开 picker，等它加载完，看列出的是不是别处的会话。
//   node tests/diag-claude-picker-scope.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const { cleanCliEnv } = require('./helpers/clean-cli-env.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-picker-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][B0]/g, '');

async function run(label, keys, totalMs) {
  const p = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
    name: 'xterm-256color', cols: 150, rows: 45, cwd: ROOT, env: cleanCliEnv(), useConpty: true,
  });
  let out = '';
  p.onData(d => { out += d; });
  await wait(1500);
  p.write('claude --resume\r\n');
  let spent = 0;
  for (const k of keys) { await wait(k.afterMs); spent += k.afterMs; p.write(k.write); }
  await wait(Math.max(0, totalMs - spent));
  try { p.kill(); } catch {}
  await wait(400);
  const clean = strip(out);
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const outside = lines.filter(l => /(C:[\\/]Vibe|_scratch|inbox-2026|claude-session-hub)/i.test(l));
  const stillLoading = /Loading conversations/i.test(lines.slice(-6).join(' '));
  console.log(`──── ${label} ────`);
  console.log(`  仍在加载: ${stillLoading}  |  跨目录条目: ${outside.length}`);
  outside.slice(0, 5).forEach(l => console.log(`     + ${l.slice(0, 120)}`));
  console.log('  末尾输出:');
  lines.slice(-9).forEach(l => console.log(`     ${l.slice(0, 120)}`));
  console.log('');
  return { outside: outside.length, stillLoading };
}

async function main() {
  console.log(`空目录: ${ROOT}\n`);
  await run('默认（等 40s 让它加载完）', [], 40000);
  fs.rmSync(ROOT, { recursive: true, force: true });
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
