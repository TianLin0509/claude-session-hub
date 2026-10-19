'use strict';
// 终端链接识别不能把界面卡死（2026-10-19 公司真机：点开 CodeAgent 会话的后台，鼠标一到终端上界面就无响应，
// 界面进程内存约 20 秒从 0.35 GB 涨到 4.2 GB 后崩溃，10 分钟 3 次后停止自动恢复）。
// 根因：xterm 的 getLine 越过末行会绕回开头，旧的链接识别往下拼「逻辑行」只靠 getLine 返回空值收尾；
// 每一行都算续行的屏幕（四周有边框的全屏 TUI，或一整行不换行、写满滚动缓冲的输出）就无限拼接。
//
// 真实链路：隔离 Hub → PowerShell 会话 → 在终端里跑一段 Node 脚本输出触发内容 → 用 CDP 发真实的鼠标移动
// （走 xterm 自己的 Linkifier → provideLinks）→ 检查界面是否还响应、界面进程内存、链接是否还能识别。
//   A. 备用屏幕上四周带边框的全屏 TUI（CodeAgent 启动界面的形态），第 5 行有一条中文路径。
//   B. 普通屏幕：一整行不换行的长输出把 10000 行滚动缓冲写满。
// 修复前：A 一悬停界面就卡死（本测试记下卡住、内存曲线和崩溃/自救记录后判失败），B 每行识别 65–90 ms；
// 修复后两种都在毫秒级完成（B 这种超过 64 行的逻辑行直接放弃识别）。
// HANG_E2E_ONLY=A 或 B 只跑一种。隔离实例、后台窗口；不碰生产 Hub，不写剪贴板。
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const j = JSON.stringify;
const ONLY = String(process.env.HANG_E2E_ONLY || '').trim().toUpperCase();
const RUN_ID = `${Date.now()}-${process.pid}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-long-wrap-hang-'));
const DATA_DIR = path.join(ROOT, 'data');
const HOME_DIR = path.join(ROOT, 'home');
const WORK_DIR = path.join(ROOT, '工作区');
const TARGET_FILE = path.join(WORK_DIR, '中文目录', '报告.md');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'window-events.log');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const readLog = () => { try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; } };

// 触发内容由终端里的 Node 脚本输出（与真实 CLI 一样经 ConPTY 进 xterm）。
const TUI_SCRIPT = `
const out = process.stdout;
const E = '\\x1b[';
const target = ${j(TARGET_FILE)};
const w = s => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
function draw() {
  const cols = out.columns || 100, rows = out.rows || 30;
  let s = E + '?25l' + E + '2J';
  for (let r = 1; r <= rows; r++) {
    let line;
    if (r === 1) line = '┌' + '─'.repeat(cols - 2) + '┐';
    else if (r === rows) line = '└' + '─'.repeat(cols - 2) + '┘';
    else {
      const body = r === 5 ? ' 输出路径：' + target : ' CodeAgent 启动界面 第 ' + r + ' 行';
      line = '│' + body + ' '.repeat(Math.max(0, cols - 2 - w(body))) + '│';
    }
    s += E + r + ';1H' + line;
  }
  out.write(s);
}
out.write(E + '?1049h');
draw();
out.on('resize', draw);
const leave = () => { out.write(E + '?25h' + E + '?1049l'); process.exit(0); };
process.on('SIGINT', leave);
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on('data', d => { if (String(d).includes('\\u0003') || String(d).includes('q')) leave(); });
process.stdin.resume();
`;
const LONG_SCRIPT = `
const cols = process.stdout.columns || 100, rows = process.stdout.rows || 30;
process.stdout.write('x'.repeat(cols * (10000 + rows + 60)), () => process.stdout.write('\\r\\nLONG_LINE_DONE\\r\\n'));
`;

function sampleWorkingSetMB(pid) {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const m = String(stdout).match(/"([\d,. ]+) K"/);
      resolve(m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : null);
    });
  });
}

(async () => {
  fs.mkdirSync(path.dirname(TARGET_FILE), { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(TARGET_FILE, '# 长折行卡死回归\n', 'utf8');
  const tuiPath = path.join(WORK_DIR, 'boxed-tui.js');
  const longPath = path.join(WORK_DIR, 'long-line.js');
  fs.writeFileSync(tuiPath, TUI_SCRIPT, 'utf8');
  fs.writeFileSync(longPath, LONG_SCRIPT, 'utf8');

  let hub = null;
  let c = null;
  const passed = [];
  const result = { runId: RUN_ID, scenarios: {} };
  const ok = (cond, label, detail) => { assert.ok(cond, label + (detail === undefined ? '' : ' ' + j(detail))); passed.push(label); console.log('  ✓ ' + label + (detail === undefined ? '' : ' ' + j(detail))); };
  let memTimer = null;
  const mem = { pid: null, samples: [] };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await freePort(), label: 'long-wrap-hang', windowMode: 'background',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: HOME_DIR, DEEPSEEK_API_KEY: '', AI_HUB_STALL_RESCUE_SEC: '20' },
    });
    c = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    const evalT = (expr, ms = 8000) => Promise.race([
      c.eval(expr),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`renderer did not answer within ${ms} ms`)), ms)),
    ]);
    const until = async (expr, label, ms = 30000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (await evalT(expr, 5000)) return; } catch {} await _waitMs(150); }
      throw new Error('timeout: ' + label);
    };
    await until('typeof sessions !== "undefined" && document.readyState === "complete" && !!window.__hubE2E', 'renderer ready', 60000);

    const created = await evalT(`ipcRenderer.invoke('create-session',{kind:'powershell',opts:{title:'长折行卡死回归',cwd:${j(WORK_DIR)}}})`, 20000);
    const sid = created && created.id;
    assert.ok(sid, j(created));
    await until(`sessions.has(${j(sid)})`, 'session in renderer');
    await evalT(`selectSession(${j(sid)})`);
    try {
      await until(`window.__hubE2E.terminalCacheStats().ids.includes(${j(sid)})`, 'real xterm cache', 30000);
      await until(`window.__hubE2E.terminalBufferText(${j(sid)}).length > 20`, 'PowerShell prompt', 40000);
    } catch (error) {
      const diag = await evalT(`({ stats: window.__hubE2E.terminalCacheStats(), text: window.__hubE2E.terminalBufferText(${j(sid)}, 10), status: sessions.get(${j(sid)})?.status })`).catch(e => e.message);
      throw new Error(error.message + ' ' + j(diag));
    }

    mem.pid = await evalT('process.pid');
    memTimer = setInterval(async () => {
      const mb = await sampleWorkingSetMB(mem.pid);
      if (mb != null) mem.samples.push({ t: Date.now(), mb });
    }, 1000);
    const memSince = t0 => mem.samples.filter(s => s.t >= t0).map(s => s.mb);

    const send = data => evalT(`ipcRenderer.send('terminal-input',{sessionId:${j(sid)},data:${j(data)}}), true`);
    const geometry = () => evalT(`(() => {
      const cached = terminalCache.get(${j(sid)});
      const screen = cached.container.querySelector('.xterm-screen');
      const cell = cached.terminal._core?._renderService?.dimensions?.css?.cell;
      const r = screen.getBoundingClientRect();
      const b = cached.terminal.buffer.active;
      return { left: r.left, top: r.top, cw: cell.width, ch: cell.height, cols: cached.terminal.cols, rows: cached.terminal.rows,
        type: b.type, length: b.length, viewportY: b.viewportY };
    })()`);
    const statsExpr = `(() => ({ activation: terminalCache.get(${j(sid)})._localPathLinkProvider.getActivationStats() }))()`;

    // 悬停整屏：从上到下每一行都移过去，最后停在目标行的路径上。任何一步界面不答话都算卡住。
    async function hoverAcross(g, targetRow, targetCol) {
      const t0 = Date.now();
      const steps = [];
      for (let row = 0; row < g.rows; row += 1) steps.push({ row, col: 4 + (row % 30) });
      steps.push({ row: targetRow, col: targetCol });
      for (const step of steps) {
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: g.left + (step.col + 0.5) * g.cw,
          y: g.top + (step.row + 0.5) * g.ch,
          modifiers: 0,
        });
        await _waitMs(25);
        // 每移一步都确认界面还在答话（xterm 收到鼠标移动后同步调用 provideLinks）。
        await evalT('1', 8000);
      }
      await _waitMs(1500);
      const pingStart = Date.now();
      const alive = await evalT(`!!terminalCache.get(${j(sid)})?._localPathLinkProvider`, 8000);
      if (!alive) throw new Error('terminal disappeared after hover (renderer was reloaded)');
      return { hoverMs: Date.now() - t0, pingMs: Date.now() - pingStart };
    }

    // 记下卡死时的证据：内存曲线、界面无响应 / 自救 / 崩溃记录。
    async function recordHang(label, t0, error) {
      console.error(`  ✗ ${label}：${error.message}`);
      const end = Date.now() + 60000;
      while (Date.now() < end && !/ (render-process-gone|renderer-stall-rescue) /.test(readLog())) await _waitMs(1000);
      const curve = memSince(t0);
      const hang = {
        error: error.message,
        workingSetMB: { first: curve[0], peak: Math.max(...curve), samples: curve },
        secondsObserved: Math.round((Date.now() - t0) / 1000),
        log: readLog().split('\n').filter(l => / (unresponsive|renderer-hang-stack|renderer-stall-rescue|render-process-gone|renderer-memory-at-gone|renderer-recover)/.test(l)).map(l => l.slice(0, 400)),
      };
      console.error(j(hang, null, 2));
      return hang;
    }

    if (!ONLY || ONLY === 'A') {
      await send(`node "${tuiPath}"\r`);
      await until(`(() => { const b = terminalCache.get(${j(sid)}).terminal.buffer.active; return b.type === 'alternate' && (b.getLine(b.length - 1)?.translateToString(true) || '').includes('┘'); })()`, 'boxed TUI on alternate screen', 30000);
      await _waitMs(500);
      const g = await geometry();
      const row5 = await evalT(`terminalCache.get(${j(sid)}).terminal.buffer.active.getLine(4).translateToString(true)`);
      const pathCol = [...row5.slice(0, row5.indexOf(':\\') - 1)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0) + 3;
      const before = await evalT(statsExpr);
      const memBefore = await sampleWorkingSetMB(mem.pid);
      const t0 = Date.now();
      let timing;
      let after;
      try {
        timing = await hoverAcross(g, 4, pathCol);
        after = await evalT(statsExpr);
      } catch (error) {
        result.scenarios.A = { buffer: g, hang: await recordHang('A 备用屏幕全屏边框 TUI：悬停后界面卡死', t0, error) };
        throw new Error('scenario A: renderer hung on hover');
      }
      const direct = await evalT(`(() => {
        const cached = terminalCache.get(${j(sid)});
        const p = cached._localPathLinkProvider; const b = cached.terminal.buffer.active;
        const times = []; let found = null;
        for (let y = 1; y <= b.length; y++) {
          const s = performance.now();
          p.provideLinks(y, links => { for (const l of links || []) { if (y === 5) found = { text: l.text, range: l.range }; l.dispose?.(); } });
          times.push(performance.now() - s);
        }
        return { rows: b.length, maxMs: Math.max(...times), totalMs: times.reduce((a, v) => a + v, 0), found };
      })()`);
      const curve = memSince(t0);
      result.scenarios.A = { buffer: g, timing, direct, memBeforeMB: memBefore, memPeakMB: Math.max(memBefore, ...curve) };
      ok(g.type === 'alternate', 'A：CodeAgent 形态的全屏边框界面在备用屏幕上', { cols: g.cols, rows: g.rows, length: g.length });
      ok(timing.pingMs < 1000, 'A：鼠标扫过整屏后界面立即响应', timing);
      ok(direct.maxMs < 50 && direct.found && direct.found.text === TARGET_FILE, 'A：逐行识别都在 50 ms 内，第 5 行的中文路径照样识别', direct);
      ok(after.activation.hovers > before.activation.hovers, 'A：真实鼠标悬停经 xterm 识别到了链接（hover 计数增加）', { before: before.activation.hovers, after: after.activation.hovers });
      ok(result.scenarios.A.memPeakMB - memBefore < 300, 'A：界面进程内存没有上涨', { beforeMB: memBefore, peakMB: result.scenarios.A.memPeakMB });
      await send('q');
      await until(`terminalCache.get(${j(sid)}).terminal.buffer.active.type === 'normal'`, 'TUI exited', 20000);
      await _waitMs(800);
    }

    if (!ONLY || ONLY === 'B') {
      await send(`node "${longPath}"\r`);
      await until(`window.__hubE2E.terminalBufferText(${j(sid)}, 6).includes('LONG_LINE_DONE')`, 'long line printed', 180000);
      await _waitMs(1500);
      const g = await geometry();
      const memBefore = await sampleWorkingSetMB(mem.pid);
      const t0 = Date.now();
      let timing;
      try {
        timing = await hoverAcross(g, Math.max(0, g.rows - 6), 10);
      } catch (error) {
        result.scenarios.B = { buffer: g, hang: await recordHang('B 写满滚动缓冲的不换行长输出：悬停后界面卡死', t0, error) };
        throw new Error('scenario B: renderer hung on hover');
      }
      const direct = await evalT(`(() => {
        const cached = terminalCache.get(${j(sid)});
        const p = cached._localPathLinkProvider; const b = cached.terminal.buffer.active;
        const times = [];
        for (const y of [1, 2, Math.floor(b.length / 2), b.length - 8, b.length - 3, b.length]) {
          const s = performance.now();
          p.provideLinks(y, links => { for (const l of links || []) l.dispose?.(); });
          times.push(+(performance.now() - s).toFixed(2));
        }
        return { length: b.length, times, maxMs: Math.max(...times) };
      })()`);
      const curve = memSince(t0);
      result.scenarios.B = { buffer: g, timing, direct, memBeforeMB: memBefore, memPeakMB: Math.max(memBefore, ...curve) };
      ok(g.length >= 10000, 'B：滚动缓冲已写满（越过末行的读取会绕回开头）', { length: g.length, type: g.type });
      ok(timing.pingMs < 1000 && direct.maxMs < 50, 'B：悬停与逐行识别都不卡', { timing, direct });
      ok(result.scenarios.B.memPeakMB - memBefore < 300, 'B：界面进程内存没有上涨', { beforeMB: memBefore, peakMB: result.scenarios.B.memPeakMB });
    }

    const skips = readLog().split(/\r?\n/).filter(l => / page-terminal-link-budget /.test(l));
    ok(!skips.some(l => /"reason":"time"/.test(l)), '正常机器上没有触发识别超时保护', skips.map(l => l.slice(0, 200)));
    if (!ONLY || ONLY === 'B') {
      ok(skips.some(l => /"reason":"lines"/.test(l) && !/xxxx/.test(l)), 'B：超长逻辑行放弃识别时记了一条只含原因和行数的日志', skips.map(l => l.slice(0, 200)));
    }
    ok(!/ (render-process-gone|renderer-stall-rescue) /.test(readLog()), '全程没有界面崩溃或卡死自救');
    console.log(`\nPASS ${passed.length} checks`);
  } catch (error) {
    console.error('FAIL', error && error.stack || error);
    process.exitCode = 1;
  } finally {
    if (memTimer) clearInterval(memTimer);
    console.log('RESULT ' + j(result));
    try { c && c.close(); } catch {}
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true, timeoutMs: 30000 }).catch(error => console.warn('quit:', error.message));
  }
})();
