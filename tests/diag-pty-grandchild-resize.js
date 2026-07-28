'use strict';
// 隔离根因：ConPTY 的尺寸变化事件进的是共享控制台输入缓冲，谁先读走谁得到。
// Hub 的结构是  pty(powershell.exe) → 写入命令 → CLI(node)  ，CLI 是孙进程。
// 对照两种拓扑，看 resize 事件到底能不能到达 CLI：
//   A. 直接把 node 探针作为 PTY 进程
//   B. 先起 powershell，再把 node 探针命令写进去（＝ Hub 现在的做法）
//   node tests/diag-pty-grandchild-resize.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-grandchild-'));
const PROBE = path.join(ROOT, 'probe.js');

function writeProbe(logPath) {
  fs.writeFileSync(PROBE, `
const fs = require('fs');
const LOG = ${JSON.stringify('__LOG__')}.replace('__LOG__', '') || process.argv[2];
const log = o => { try { fs.appendFileSync(process.argv[2], JSON.stringify(o) + '\\n'); } catch {} };
log({ ev: 'boot', isTTY: !!process.stdout.isTTY, cols: process.stdout.columns, rows: process.stdout.rows });
process.stdout.on('resize', () => log({ ev: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
process.stdout.write('PROBE_READY\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`, 'utf8');
  return logPath;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function scenario(label, direct) {
  const logPath = path.join(ROOT, `${label}.log`);
  writeProbe(logPath);
  const p = direct
    ? pty.spawn(process.execPath, [PROBE, logPath], {
        name: 'xterm-256color', cols: 120, rows: 30, cwd: ROOT, env: process.env, useConpty: true,
      })
    : pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
        name: 'xterm-256color', cols: 120, rows: 30, cwd: ROOT, env: process.env, useConpty: true,
      });

  let ready = false;
  p.onData(d => { if (String(d).includes('PROBE_READY')) ready = true; });

  if (!direct) {
    await wait(1500);
    p.write(` & '${process.execPath}' '${PROBE}' '${logPath}'\r\n`);
  }
  for (let i = 0; i < 40 && !ready; i++) await wait(250);
  await wait(1200);

  const sizes = [[100, 20], [140, 50], [110, 35]];
  for (const [cols, rows] of sizes) {
    p.resize(cols, rows);
    await wait(1200);
  }
  await wait(1000);
  try { p.kill(); } catch {}
  await wait(600);

  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const boot = lines.find(l => l.ev === 'boot');
  const resizes = lines.filter(l => l.ev === 'resize');
  return { label, ready, boot, resizeCount: resizes.length, resizes: resizes.map(r => `${r.cols}x${r.rows}`) };
}

async function main() {
  try {
    const a = await scenario('A-直接作为PTY进程', true);
    const b = await scenario('B-powershell的孙进程', false);
    for (const r of [a, b]) {
      console.log(`\n【${r.label}】`);
      console.log(`  探针就绪: ${r.ready}`);
      console.log(`  boot    : ${r.boot ? `isTTY=${r.boot.isTTY} ${r.boot.cols}x${r.boot.rows}` : '未记录'}`);
      console.log(`  收到 resize: ${r.resizeCount} 次  ${r.resizes.join(' , ')}`);
    }
    console.log('\n=== 结论 ===');
    if (a.resizeCount > 0 && b.resizeCount === 0) {
      console.log('✅ 根因确认：CLI 作为 powershell 的孙进程时收不到 ConPTY 的尺寸变化事件，');
      console.log('   直接作为 PTY 进程则正常。Node 系 CLI（Claude Code / Codex）因此永远');
      console.log('   按启动尺寸排版，而 xterm 已经变了 —— 画面错位、大片空白由此而来。');
    } else if (a.resizeCount > 0 && b.resizeCount > 0) {
      console.log('两种拓扑都能收到 —— 孙进程假设不成立，需另找原因。');
    } else if (a.resizeCount === 0) {
      console.log('直接作为 PTY 进程也收不到 —— 是 node-pty/ConPTY 层面的问题，与拓扑无关。');
    }
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('diag failed:', e && e.message); process.exitCode = 1; });
