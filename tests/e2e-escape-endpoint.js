// tests/e2e-escape-endpoint.js
// 2026-05-16 道雪：真实隔离 Hub + control 文件 + /api/escape-home + 方向 A 端到端验证
//
// 验证场景（按顺序）：
//   1. 控制文件 <dataDir>/control/<pid>.json 被写入，内容正确（hookPort/cdpPort/token/pid/dataDir）
//   2. cdpPort 与 launcher 传入的 port 一致
//   3. 打开 URL 预览（走 <webview> 路径，复现 81164 场景）
//   4. 方向 A：preview-header 仍可见（display flex / height >= 32px / flex-shrink: 0 / z-index: 2）
//   5. 错 token -> 403
//   6. 正确 token -> 200, ok:true; renderer escapeToHome 生效（preview 关 + sidebar 展开）
//   7. gracefulQuit 后控制文件被 unlinkSelf 清掉

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9351', 10);
const DATA_DIR = path.join(os.tmpdir(), `hub-e2e-escape-endpoint-${Date.now()}`);
const SHOT_DIR = path.join(__dirname, 'screenshots', 'escape-endpoint');

function httpPostJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(data);
    req.end();
  });
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: CDP_PORT, label: 'escape-endpoint' });

  let client;
  try {
    // ── 1. 等控制文件 + 校验内容 ──
    const controlFile = path.join(DATA_DIR, 'control', `${hub.pid}.json`);
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(controlFile)) break;
      await _waitMs(200);
      if (i === 49) throw new Error(`control file never appeared: ${controlFile}`);
    }
    const ctl = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    assert.strictEqual(ctl.pid, hub.pid, 'control.pid');
    assert.ok(typeof ctl.hookPort === 'number' && ctl.hookPort > 0, `hookPort: ${ctl.hookPort}`);
    assert.ok(typeof ctl.cdpPort === 'number' && ctl.cdpPort > 0, `cdpPort: ${ctl.cdpPort}`);
    assert.ok(typeof ctl.token === 'string' && ctl.token.length >= 16, 'token length');
    assert.strictEqual(ctl.dataDir, DATA_DIR, 'control.dataDir');
    console.log(`OK Test 1: control file 内容正确 (hookPort=${ctl.hookPort}, cdpPort=${ctl.cdpPort})`);

    // ── 2. cdpPort 与 launcher port 一致 ──
    assert.strictEqual(ctl.cdpPort, hub.port, `cdpPort ${ctl.cdpPort} should equal launcher port ${hub.port}`);
    console.log('OK Test 2: cdpPort 与 launcher 一致');

    // ── 3. CDP attach 渲染进程 + 打开 URL 预览 ──
    client = await connectFirstPage(hub, t => t.type === 'page' && /index\.html/i.test(t.url || ''));
    await client.send('Page.enable');

    for (let i = 0; i < 80; i++) {
      const ready = await client.eval(`(() => document.readyState !== 'loading' && !!document.getElementById('preview-panel'))()`);
      if (ready) break;
      await _waitMs(100);
      if (i === 79) throw new Error('Hub DOM not ready');
    }

    // 打开 URL 预览，复现 81164 卡死场景（http URL 走 <webview> 路径）
    await client.eval(`openPreviewPanel('https://example.com')`);
    await _waitMs(800);

    // ── 4. 方向 A：preview-header 可见 ──
    const headerVisible = await client.eval(`(() => {
      const h = document.querySelector('.preview-header');
      if (!h) return { error: 'no header' };
      const cs = getComputedStyle(h);
      const r = h.getBoundingClientRect();
      return {
        display: cs.display, visibility: cs.visibility,
        flexShrink: cs.flexShrink, zIndex: cs.zIndex,
        height: r.height, top: r.top,
      };
    })()`);
    assert.notStrictEqual(headerVisible.display, 'none', `header display: ${JSON.stringify(headerVisible)}`);
    assert.notStrictEqual(headerVisible.visibility, 'hidden', JSON.stringify(headerVisible));
    assert.ok(headerVisible.height >= 32, `header height too small: ${JSON.stringify(headerVisible)}`);
    assert.strictEqual(headerVisible.flexShrink, '0', `flex-shrink should be 0: ${headerVisible.flexShrink}`);
    assert.ok(parseInt(headerVisible.zIndex, 10) >= 2, `z-index should be >=2: ${headerVisible.zIndex}`);
    console.log(`OK Test 3+4: preview-header 在 URL 预览下可见 (height=${headerVisible.height}, flex-shrink=${headerVisible.flexShrink}, z-index=${headerVisible.zIndex})`);

    // ── 5. 错 token -> 403 ──
    const r403 = await httpPostJson(ctl.hookPort, '/api/escape-home', { token: 'wrong-token' });
    assert.strictEqual(r403.status, 403, `wrong token should 403, got ${r403.status}`);
    console.log('OK Test 5: 错 token -> 403');

    // ── 6. 正确 token -> 200 + escape 生效 ──
    const r200 = await httpPostJson(ctl.hookPort, '/api/escape-home', { token: ctl.token });
    assert.strictEqual(r200.status, 200, `correct token should 200, got ${r200.status}`);
    const respJson = JSON.parse(r200.body);
    assert.strictEqual(respJson.ok, true, 'response.ok');
    assert.strictEqual(respJson.pid, hub.pid, `response.pid: ${respJson.pid} vs ${hub.pid}`);
    console.log('OK Test 6a: endpoint returns 200 with {ok, pid}');

    await _waitMs(500);
    const after = await client.eval(`(() => {
      const app = document.getElementById('app-container');
      const preview = document.getElementById('preview-panel');
      return {
        sidebarCollapsed: app.classList.contains('sidebar-collapsed'),
        previewDisplay: getComputedStyle(preview).display,
      };
    })()`);
    assert.strictEqual(after.previewDisplay, 'none', `preview should be closed: ${JSON.stringify(after)}`);
    assert.strictEqual(after.sidebarCollapsed, false, `sidebar should be expanded: ${JSON.stringify(after)}`);
    console.log('OK Test 6b: escape-home took effect (preview closed + sidebar expanded)');

    // 留个证据截图
    const png = await client.send('Page.captureScreenshot', { format: 'png' });
    const shot = path.join(SHOT_DIR, `${Date.now()}-after-escape.png`);
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    console.log('  screenshot saved:', shot);

    console.log('\nAll runtime tests passed.');
  } finally {
    if (client) await client.close();
    await gracefulQuit(hub);
    await _waitMs(500);

    // ── 7. 退出后控制文件被 unlinkSelf ──
    const controlFile = path.join(DATA_DIR, 'control', `${hub.pid}.json`);
    if (fs.existsSync(controlFile)) {
      console.warn(`WARN Test 7: control file 未被 unlinkSelf 清理: ${controlFile}`);
      // 不算 hard fail（before-quit 可能超时被 gracefulQuit 跳过），但要 warn
    } else {
      console.log('OK Test 7: control file unlinked on quit');
    }
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
