'use strict';
// 找出 Codex resume picker 里把 Filter 从 [Cwd] 切到 All 的按键。
// picker 顶部显示 `Filter: [Cwd] All`，方括号表示当前选中项。
//   node tests/diag-codex-picker-filter.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-filter-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][B0]/g, '');

const KEYS = [
  ['Tab', '\t'],
  ['Right', '\x1b[C'],
  ['Ctrl+A', '\x01'],
  ['Ctrl+F', '\x06'],
  ['Ctrl+R', '\x12'],
  ['a', 'a'],
];

async function tryKey(label, seq) {
  const p = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
    name: 'xterm-256color', cols: 150, rows: 45, cwd: ROOT, env: process.env, useConpty: true,
  });
  let out = '';
  p.onData(d => { out += d; });
  await wait(1500);
  p.write('codex resume\r\n');
  await wait(6000);
  p.write('\r');            // 过信任对话框
  await wait(7000);
  const beforeAll = strip(out);
  out = '';
  p.write(seq);
  await wait(4000);
  const after = strip(out);
  try { p.kill(); } catch {}
  await wait(400);

  const both = beforeAll + after;
  // 选中态用方括号标记：Filter: Cwd [All]
  const allSelected = /Filter:\s*Cwd\s*\[All\]/i.test(after) || /Cwd\s*\[All\]/i.test(after);
  const cwdSelected = /Filter:\s*\[Cwd\]\s*All/i.test(after) || /\[Cwd\]\s*All/i.test(after);
  const sessionsLine = (both.match(/Showing[^\n]*|\d+ \/ \d+[^\n]*|N session yet/gi) || []).slice(-2);
  return { label, allSelected, cwdSelected, sessionsLine };
}

async function main() {
  console.log(`空目录: ${ROOT}\n判据：picker 顶部 "Filter: [Cwd] All"，方括号内为当前选中\n`);
  for (const [label, seq] of KEYS) {
    try {
      const r = await tryKey(label, seq);
      const verdict = r.allSelected ? '✅ 切到了 All' : (r.cwdSelected ? '仍是 Cwd' : '未识别到 Filter 行');
      console.log(`  ${label.padEnd(8)} → ${verdict}   ${r.sessionsLine.join(' | ').slice(0, 60)}`);
      if (r.allSelected) { console.log(`\n结论：Codex 用 ${label} 切换 Filter 到 All`); break; }
    } catch (e) {
      console.log(`  ${label.padEnd(8)} → 探测失败 ${e.message}`);
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
