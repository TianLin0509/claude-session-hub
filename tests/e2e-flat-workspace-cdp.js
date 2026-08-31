'use strict';
// 平铺工作根的端到端验证（2026-08-31）。
//
// 单测只覆盖了 WorkspaceService 的纯逻辑。这里要验的是真实 Electron 里的整条链路：
// renderer 的三档选择 → IPC → 主进程 resolveForSession → 落到哪个目录。
// 特别是「默认档不传 workspace，让后端接管」这个约定 —— 它跨了 renderer 和主进程，
// 单测两边都测不到。
//
// 隔离要求（用户规则）：独立 data 目录 + 独立 home + 独立 workspace 根 + 随机 CDP 端口，
// 绝不碰生产 Hub。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-flat-ws-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'AIWork');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function evalJson(page, expression) {
  const { result } = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result && result.subtype === 'error') throw new Error(result.description || 'evaluate failed');
  return result ? result.value : undefined;
}

(async () => {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  // 标记决定行为：先不放，验证旧路径；中途放上，验证平铺路径。
  const marker = path.join(WORKSPACE_ROOT, '.aiwork-root');

  const port = await reservePort();
  // launchIsolatedHub 自己会派生隔离的 CLAUDE_HUB_HOME_DIR；这里只需把工作根指过去。
  const hub = await launchIsolatedHub({
    port,
    dataDir: DATA_DIR,
    label: 'flat-ws',
    extraEnv: { AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT },
  });

  const failures = [];
  const record = (name, fn) => {
    try { fn(); console.log(`  OK   ${name}`); } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.log(`  FAIL ${name}: ${error.message}`);
    }
  };

  let page;
  try {
    // connectFirstPage 收的是 hub 对象（它自己拼 cdpHttpBase），不是端口号。
    // 只认 renderer/index.html 这个 target，避免连到 DevTools 或其它页面。
    page = await connectFirstPage(hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await page.send('Runtime.enable');
    await _waitMs(2500);

    console.log('\n=== A. 未挂标记：旧行为 ===');
    let listing = await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:list').then(r => JSON.stringify(r))`);
    let parsed = JSON.parse(listing);
    record('listing.flatRoot === false', () => assert.equal(parsed.flatRoot, false));

    let def = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:default', {label:'未命名任务'}).then(r => JSON.stringify(r))`));
    record('未挂标记时 workspace:default 退回 scratch', () => {
      assert.equal(def.flat, false);
      assert.ok(def.path.toLowerCase().includes(`${path.sep}_scratch${path.sep}`.toLowerCase()),
        `应落在 _scratch，实际 ${def.path}`);
    });

    console.log('\n=== B. 挂上标记：平铺行为 ===');
    fs.writeFileSync(marker, 'marker');

    listing = await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:list').then(r => JSON.stringify(r))`);
    parsed = JSON.parse(listing);
    record('listing.flatRoot === true', () => assert.equal(parsed.flatRoot, true));

    def = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:default', {label:'未命名任务'}).then(r => JSON.stringify(r))`));
    record('workspace:default 落在工作根', () => {
      assert.equal(def.flat, true);
      assert.equal(path.resolve(def.path).toLowerCase(), path.resolve(WORKSPACE_ROOT).toLowerCase());
    });
    record('工作根不是 draft（不会触发归档提示）', () => assert.equal(def.draft, false));
    record('工作根名字不被 label 覆盖', () => assert.equal(def.label, path.basename(WORKSPACE_ROOT)));
    record('.vibe-root 被写到工作根', () =>
      assert.ok(fs.existsSync(path.join(WORKSPACE_ROOT, '.vibe-root'))));

    console.log('\n=== C. 连开三个默认会话，工作根名字必须稳定 ===');
    for (let i = 0; i < 3; i += 1) {
      await evalJson(page,
        `require('electron').ipcRenderer.invoke('workspace:default', {label:'第${i}个未命名任务'}).then(() => 1)`);
    }
    const after = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:list').then(r => JSON.stringify(r))`));
    const rootEntry = after.items.find(it =>
      path.resolve(it.path).toLowerCase() === path.resolve(WORKSPACE_ROOT).toLowerCase());
    record('注册表里工作根仍叫目录名', () => {
      assert.ok(rootEntry, '工作根应在注册表里');
      assert.equal(rootEntry.label, path.basename(WORKSPACE_ROOT));
    });
    record('工作根 tier 为 root', () => assert.equal(rootEntry.tier, 'root'));

    console.log('\n=== D. 临时目录档仍然可用且每次唯一 ===');
    const s1 = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:create-scratch', {label:'t1'}).then(r => JSON.stringify(r))`));
    const s2 = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:create-scratch', {label:'t2'}).then(r => JSON.stringify(r))`));
    record('两次临时目录不撞名', () => assert.notEqual(s1.path, s2.path));
    record('临时目录仍在 _scratch 下', () =>
      assert.ok(s1.path.toLowerCase().includes(`${path.sep}_scratch${path.sep}`.toLowerCase())));

    console.log('\n=== E. 工作根可以被显式选中（守卫已放行）===');
    const picked = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('workspace:select', ${JSON.stringify(WORKSPACE_ROOT)}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({error:String(e && e.message || e)}))`));
    record('显式选工作根不再被拒', () => {
      assert.ok(!picked.error, `不该报错，实际 ${picked.error}`);
      assert.equal(path.resolve(picked.path).toLowerCase(), path.resolve(WORKSPACE_ROOT).toLowerCase());
    });

    console.log('\n=== F. 记忆面板拿到 flatRoot 与真实文件数 ===');
    const overview = JSON.parse(await evalJson(page,
      `require('electron').ipcRenderer.invoke('memory:get-overview').then(r => JSON.stringify({flatRoot:r.flatRoot, wsLabels:r.workspaceFiles.map(f=>f.label), total:r.claudeMemory.canonical.totalFiles, listed:r.claudeMemory.canonical.files.length})).catch(e => JSON.stringify({error:String(e && e.message || e)}))`));
    record('overview.flatRoot === true', () => {
      assert.ok(!overview.error, `不该报错，实际 ${overview.error}`);
      assert.equal(overview.flatRoot, true);
    });
    record('工作根文件标签改成「直接读」文案', () =>
      assert.ok(overview.wsLabels.some(l => l.includes('直接读')),
        `标签应含「直接读」，实际 ${JSON.stringify(overview.wsLabels)}`));
    record('canonical 暴露 totalFiles（不受 50 上限影响）', () =>
      assert.equal(typeof overview.total, 'number'));

    console.log('\n=== G. 渲染层三档按钮存在且默认选中「默认工作目录」===');
    const modes = JSON.parse(await evalJson(page, `JSON.stringify({
      session: Array.from(document.querySelectorAll('.session-workspace-choice')).map(b => ({
        mode: b.dataset.workspaceMode, selected: b.classList.contains('selected')
      }))
    })`));
    record('单会话有三档', () => assert.equal(modes.session.length, 3));
    record('默认档是 default 且选中', () => {
      const d = modes.session.find(m => m.mode === 'default');
      assert.ok(d, 'default 档应存在');
      assert.equal(d.selected, true);
    });
    record('scratch / existing 两档仍在', () => {
      assert.ok(modes.session.some(m => m.mode === 'scratch'));
      assert.ok(modes.session.some(m => m.mode === 'existing'));
    });

    console.log('\n=== H. 主进程无未捕获错误 ===');
    const logLines = typeof hub.log === 'function' ? hub.log() : [];
    record('主进程日志无 Unhandled / TypeError / ReferenceError', () => {
      const bad = logLines.filter(l =>
        /Unhandled|TypeError|ReferenceError|is not a function/.test(String(l)));
      assert.equal(bad.length, 0, bad.slice(0, 3).join(' | '));
    });
  } finally {
    if (page) { try { await page.close(); } catch {} }
    try { await gracefulQuit(hub); } catch {}
    try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'ALL PASSED'}`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(failures.length ? 1 : 0);
})().catch(error => {
  console.error('E2E crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
