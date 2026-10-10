'use strict';
// 看不见的终端不整屏重画（renderer/xterm-hidden-render-guard.js）的真实界面验收（2026-10-11）。
// 隔离 Hub、关闭显卡加速（终端用 DOM 渲染，屏幕上的字就是 DOM 文本，可以逐行核对），
// 3 个持续滚动输出的 CodeAgent 替身会话藏在卡片后面一段时间，然后：
//   ① 闸门确实拦下了藏起来时的整屏重画；
//   ② 点「后台」后，屏幕上每一行都和终端缓冲区一致（没有漏画、没有旧帧）；
//   ③ 后台里切到另一个会话，同样逐行一致。
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { spawnSync } = require('child_process');
// 隐藏窗口不出帧、终端不刷新，没法核对屏幕；用真实可见窗口，挪到屏幕外（不抢位置，Chromium 仍按可见出帧）。
process.env.HUB_E2E_SHOW_WINDOWS = '1';
const ps = script => String(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout || '').trim();
const WIN32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);'`;
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-tui-standin', 'codeagent.cmd');

// 当前可见终端：DOM 行文本与缓冲区视口文本逐行比较。
const COMPARE = `(() => {
  const cached = terminalCache.get(activeSessionId); const t = cached.terminal; const buf = t.buffer.active;
  const rows = [...cached.container.querySelectorAll('.xterm-rows > div')].map(d => d.textContent.replace(/\\u00a0/g, ' ').trimEnd());
  const want = []; for (let y = 0; y < t.rows; y++) { const line = buf.getLine(buf.viewportY + y); want.push(line ? line.translateToString(true).trimEnd() : ''); }
  const bad = []; for (let y = 0; y < t.rows; y++) if ((rows[y] || '') !== want[y]) bad.push({ y, dom: rows[y], buf: want[y] });
  return { mode: cached._rendererMode, rows: t.rows, domRows: rows.length, mismatches: bad.length, sample: bad.slice(0, 3), nonEmpty: want.filter(Boolean).length };
})()`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-guard-'));
  const cac = path.join(root, '.cac'), work = path.join(root, 'work'); for (const d of [cac, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' } }));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'visible', label: 'render guard', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), AI_HUB_DISABLE_GPU: '1', FAKE_TUI_INTERVAL_MS: '20', FAKE_TUI_STOP_AFTER_MS: '30000' } });
    c = await connectFirstPage(hub);
    for (let i = 0; i < 150 && !(await c.eval('typeof sessions !== "undefined" && typeof selectSession === "function"').catch(() => false)); i++) await sleep(400);
    let hwnd = '0'; for (let i = 0; i < 30 && hwnd === '0'; i++) { hwnd = ps(`(Get-Process -Id ${hub.pid}).MainWindowHandle.ToInt64()`) || '0'; if (hwnd === '0') await sleep(500); }
    ps(`${WIN32}; [W.U]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]::Zero, -24000, -24000, 1400, 900, 0x14) | Out-Null`);
    await sleep(800);
    assert.equal(await c.eval('document.visibilityState'), 'visible', 'window must render frames');
    const ids = [];
    for (let i = 0; i < 3; i++) { const s = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, effort: 'low' } })})`); ids.push(s.id); await sleep(1000); }
    // 每个会话先在后台打开一次，让终端按实际尺寸排好（之后藏起来时正文满屏会触发滚动重画）。
    for (const id of ids) { await c.eval(`selectSession(${j(id)})`); await sleep(600); await c.eval(`applyViewMode('pty')`); await sleep(900); }
    await c.eval(`selectSession(${j(ids[0])})`); await sleep(500); await c.eval(`applyViewMode('card')`);
    await sleep(36000); // 替身输出 30 秒后停下：藏起来期间持续滚动，核对时内容已静止
    const guard = await c.eval(`[...terminalCache.values()].map(v => v.terminal._core._renderService.__hubHiddenGuard && v.terminal._core._renderService.__hubHiddenGuard.skipped)`);
    if (process.env.HUB_DISABLE_HIDDEN_RENDER_GUARD !== '1') assert.ok(guard.every(n => typeof n === 'number') && guard.reduce((a, b) => a + b, 0) > 0, 'the guard must skip hidden full redraws: ' + j(guard));
    console.log('PASS ① 藏起来时拦下整屏重画：' + j(guard));
    await c.eval(`applyViewMode('pty')`); await sleep(1500);
    const a = await c.eval(COMPARE);
    assert.equal(a.mode, 'dom'); assert.ok(a.nonEmpty > 5, 'terminal has content ' + j(a));
    assert.equal(a.mismatches, 0, 'visible rows match the buffer after 后台: ' + j(a));
    console.log(`PASS ② 点后台后 ${a.rows} 行全部与缓冲区一致（非空 ${a.nonEmpty} 行）`);
    await c.eval(`selectSession(${j(ids[1])})`); await sleep(800); await c.eval(`applyViewMode('pty')`); await sleep(1500);
    const b = await c.eval(COMPARE);
    assert.equal(b.mismatches, 0, 'visible rows match the buffer after switching: ' + j(b));
    console.log(`PASS ③ 后台里切会话后 ${b.rows} 行全部与缓冲区一致（非空 ${b.nonEmpty} 行）`);
  } finally {
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().then(() => setTimeout(() => process.exit(0), 300)).catch(e => { console.error('FAIL', e.message); setTimeout(() => process.exit(1), 300); });
