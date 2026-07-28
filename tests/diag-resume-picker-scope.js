'use strict';
// 各家 CLI 的「恢复历史会话」picker 是全局还是只看当前目录？有没有"看全部"的开关？
// 用户反馈：以前会话都在 C:\Users\lintian 下，picker 一开就能凭记忆挑；
// 现在散落在 C:\Vibe\_scratch\* 和各归档目录，picker 里找不到了。
//   node tests/diag-resume-picker-scope.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const { cleanCliEnv } = require('./helpers/clean-cli-env.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-scope-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][B0]/g, '');

// steps: [{ afterMs, write }]
async function probe(cmd, steps, totalMs) {
  const p = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
    name: 'xterm-256color', cols: 150, rows: 50, cwd: ROOT, env: cleanCliEnv(), useConpty: true,
  });
  let out = '';
  p.onData(d => { out += d; });
  await wait(1500);
  p.write(`${cmd}\r\n`);
  let elapsed = 0;
  for (const s of steps) {
    await wait(s.afterMs); elapsed += s.afterMs;
    p.write(s.write);
  }
  await wait(Math.max(0, totalMs - elapsed));
  try { p.kill(); } catch {}
  await wait(500);
  return strip(out);
}

// 统计 picker 里出现了多少条"别处目录"的会话
function report(label, clean) {
  const lines = clean.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const outside = lines.filter(l =>
    /(C:[\\/]Vibe|_scratch|inbox-2026|claude-session-hub|chuxin-research)/i.test(l));
  const emptyMark = /no sessions found|no (previous |past )?conversation|没有会话|暂无/i.test(clean);
  console.log(`──── ${label} ────`);
  console.log(`  空列表提示: ${emptyMark ? '有' : '无'}   |  疑似跨目录条目: ${outside.length}`);
  outside.slice(0, 6).forEach(l => console.log(`     + ${l.trim().slice(0, 120)}`));
  const tail = lines.slice(-10);
  console.log('  末尾输出:');
  tail.forEach(l => console.log(`     ${l.trim().slice(0, 120)}`));
  console.log('');
  return { outside: outside.length, emptyMark };
}

async function main() {
  console.log(`空目录: ${ROOT}\n`);

  // Claude：picker 需要时间加载；不按任何键，只观察列表
  const claude = await probe('claude --resume', [], 22000);
  report('claude --resume（默认）', claude);

  // Codex：先回车通过信任对话框，再进 resume picker
  const codex = await probe('codex resume', [{ afterMs: 6000, write: '\r' }], 24000);
  report('codex resume（已过信任框）', codex);

  // Kimi：默认列表 + 按 Ctrl+A 切"全部"
  const kimiExe = path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe');
  const kimiAll = await probe(`& '${kimiExe}' --session`,
    [{ afterMs: 14000, write: '\x01' }], 30000);   // \x01 = Ctrl+A
  report('kimi --session（按 Ctrl+A 展开全部）', kimiAll);

  fs.rmSync(ROOT, { recursive: true, force: true });
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
