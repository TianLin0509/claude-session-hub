'use strict';
// 「内存与进程」弹层 E2E：隔离 Hub + 真实进程。
//   1. 造一个父进程已退出的「无主 Claude 进程」（node.exe 复制成 claude.exe，空转）
//   2. 在隔离 Hub 里开一个真实 Claude 会话（不发消息，不耗 token）
//   3. 真实鼠标点底部 CPU/内存/硬盘区 → 弹层按会话列出；勾选会话 → 释放 → 确认
//   4. 断言：无主进程真的被结束、会话进入休眠（可恢复）、Hub 窗口自身只显示不提供操作
//   node tests/e2e-memory-release-panel-cdp.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.join(os.tmpdir(), `hub-memory-release-${Date.now()}-${process.pid}`);
const DATA = path.join(ROOT, 'hub-data');
const WORK = path.join(ROOT, 'work');
const TASK_DIR = path.join(WORK, '20261003-memory-release-e2e');
const FAKE_DIR = path.join(ROOT, 'fake-cli');
const ARTIFACT = path.join(__dirname, '..', 'output', 'playwright', 'memory-release');
const SESSION_TITLE = 'E2E 内存释放会话';

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(e => (e ? reject(e) : resolve(a.port))); });
  });
}

async function waitFor(label, fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await _waitMs(250);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 父进程（cmd）立即退出，留下一个没有父进程、几乎不占 CPU 的 claude.exe。
async function spawnOrphanCli() {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const fake = path.join(FAKE_DIR, 'claude.exe');
  fs.copyFileSync(process.execPath, fake);
  const pidFile = path.join(FAKE_DIR, 'pid.txt');
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e6);`;
  const child = spawn('cmd.exe', ['/c', 'start', '""', '/b', fake, '-e', script], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  const pid = Number(await waitFor('orphan pid file', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), 10000));
  assert.ok(alive(pid));
  return pid;
}

async function realClick(client, expression) {
  const box = await client.eval(`(() => {
    const el = ${expression};
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  assert.ok(box && box.w > 0 && box.h > 0, `${expression} 应可见可点`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

async function shot(client, name) {
  const file = path.join(ARTIFACT, `${name}-${Date.now()}.png`);
  const png = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
  return file;
}

const panelState = `(() => {
  const p = document.getElementById('memory-release-panel');
  if (!p || p.hidden) return { visible: false };
  const rows = [...p.querySelectorAll('.mr-row')].map(r => ({
    title: r.querySelector('.mr-main strong')?.textContent || '',
    meta: r.querySelector('.mr-main small')?.textContent || '',
    tier: (r.className.match(/mr-tier-(\\w+)/) || [])[1],
    checkbox: !!r.querySelector('input.mr-check'),
    checked: !!r.querySelector('input.mr-check')?.checked,
  }));
  const r = p.getBoundingClientRect();
  return {
    visible: true, busy: !!p.querySelector('.mr-busy'), text: (p.textContent || '').replace(/\\s+/g, ' ').trim(), rows,
    primary: p.querySelector('.mr-primary')?.textContent || '', primaryDisabled: !!p.querySelector('.mr-primary')?.disabled,
    inViewport: r.top >= 0 && r.bottom <= document.documentElement.clientHeight && r.right <= document.documentElement.clientWidth,
  };
})()`;

async function main() {
  for (const dir of [DATA, WORK, TASK_DIR, ARTIFACT]) fs.mkdirSync(dir, { recursive: true });
  const orphanPid = await spawnOrphanCli();
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA, port, label: 'memory-release',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WORK, CLAUDE_HUB_E2E: '1', CLAUDE_HUB_E2E_MEMORY_RELEASE_IDLE_MS: '1500', CLAUDE_HUB_NO_EFFORT_MAX: '1' },
  });
  let client = null;
  try {
    client = await waitFor('cdp', async () => { try { return await connectFirstPage(hub); } catch { return null; } });
    await waitFor('renderer', () => client.eval('typeof sessions !== "undefined" && !!document.querySelector("#sidebar-strip .strip-resources")'));

    const created = await client.eval(`ipcRenderer.invoke('create-session', ${JSON.stringify({ kind: 'claude', opts: { cwd: TASK_DIR, title: SESSION_TITLE, mcpProfile: 'none' } })})`);
    assert.ok(created && created.id, `create-session: ${JSON.stringify(created)}`);
    const sid = created.id;
    await _waitMs(4000); // 让 CLI 起来并超过测试用的 1.5 秒空闲门槛
    // 新建会话会自动成为焦点（焦点会话不允许休眠）；模拟用户切走去看别处。
    await client.eval(`ipcRenderer.send('focus-session', { sessionId: null })`);
    // 等 CLI 启动输出平息、空闲超过测试门槛（只读查询清单，不点界面）。
    await waitFor('session becomes idle', async () => {
      const plan = await client.eval(`ipcRenderer.invoke('get-memory-release-plan')`);
      const item = plan && plan.items && plan.items.find(i => i.title === SESSION_TITLE);
      // Claude 启动后约 12 秒内会断续输出，连续安静满 8 秒才算真正空闲。
      return item && item.tier === 'suspend' && item.idleMs >= 8000;
    }, 90000);

    await realClick(client, `document.querySelector('#sidebar-strip .strip-resources')`);
    const listed = await waitFor('panel list', async () => {
      const s = await client.eval(panelState);
      return s.visible && !s.busy && s.rows.length ? s : null;
    }, 30000);
    assert.ok(listed.inViewport, '弹层必须完整在窗口内');
    console.log('清单：');
    for (const r of listed.rows.slice(0, 12)) console.log(`  [${r.tier}] ${r.checked ? '☑' : r.checkbox ? '☐' : ' '} ${r.title} | ${r.meta}`);

    const orphanRow = listed.rows.find(r => /无人接管的 Claude Code 进程/.test(r.title));
    assert.ok(orphanRow, '应识别出无主 Claude 进程');
    assert.equal(orphanRow.tier, 'safe');
    assert.equal(orphanRow.checked, true, '无主且空转的进程默认勾选');

    const sessionRow = listed.rows.find(r => r.title === SESSION_TITLE);
    assert.ok(sessionRow, '真实 Claude 会话应按标题列出，而不是 claude.exe');
    assert.equal(sessionRow.tier, 'suspend');
    assert.match(sessionRow.meta, /Claude Code · 会话 [0-9a-f]{8} · 当前 Hub 窗口/);
    assert.equal(sessionRow.checked, false, '空闲不足 1 小时的会话不默认勾选');

    const hubRow = listed.rows.find(r => /AI Hub · 当前 Hub 窗口/.test(r.title));
    assert.ok(hubRow && hubRow.tier === 'info' && !hubRow.checkbox, 'Hub 窗口自身只显示不提供操作');

    // 真实点击勾选会话
    await realClick(client, `[...document.querySelectorAll('#memory-release-panel .mr-row')].find(r => r.querySelector('.mr-main strong')?.textContent === ${JSON.stringify(SESSION_TITLE)})?.querySelector('input.mr-check')`);
    await waitFor('session checked', async () => (await client.eval(panelState)).rows.find(r => r.title === SESSION_TITLE)?.checked);
    const listShot = await shot(client, 'memory-release-list');

    await realClick(client, `document.querySelector('#memory-release-panel [data-mr-review]')`);
    const confirm = await waitFor('confirm view', async () => {
      const s = await client.eval(panelState);
      return /确认释放/.test(s.primary) ? s : null;
    }, 5000);
    assert.match(confirm.text, /结束 \d+ 个残留/);
    assert.match(confirm.text, /休眠 1 个会话/);
    const confirmShot = await shot(client, 'memory-release-confirm');

    await realClick(client, `document.querySelector('#memory-release-panel [data-mr-confirm]')`);
    const done = await waitFor('result view', async () => {
      const s = await client.eval(panelState);
      return /腾出/.test(s.text) && !s.busy ? s : null;
    }, 30000);
    console.log(`结果：${done.text.slice(0, 160)}`);
    assert.match(done.text, /成功 \d+\/\d+ 项/);
    const resultShot = await shot(client, 'memory-release-result');

    await waitFor('orphan ended', () => !alive(orphanPid), 10000);
    const status = await waitFor('session dormant', () => client.eval(`(async () => {
      const list = await ipcRenderer.invoke('get-dormant-sessions').catch(() => null);
      const s = sessions.get(${JSON.stringify(sid)});
      return s && (s.status === 'dormant' || s.dormant) ? 'dormant' : (Array.isArray(list) && list.some(x => x.id === ${JSON.stringify(sid)}) ? 'dormant' : null);
    })()`), 20000);
    assert.equal(status, 'dormant');

    console.log(`\n截图: ${listShot}\n截图: ${confirmShot}\n截图: ${resultShot}`);
    console.log('✅ 内存与进程：按会话列出、真实点击勾选与确认、无主进程被结束、会话进入可恢复的休眠');
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    if (alive(orphanPid)) { try { process.kill(orphanPid); } catch { /* ignore */ } }
    const resolved = path.resolve(ROOT);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('hub-memory-release-')) throw new Error('unsafe test cleanup path');
    await _waitMs(500);
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
    catch (error) { console.warn(`临时目录稍后由系统清理：${error.message}`); }
  }
}

main().catch(e => { console.error('E2E FAILED:', e && e.message); process.exitCode = 1; });
