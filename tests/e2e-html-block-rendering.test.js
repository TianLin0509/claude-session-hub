'use strict';
// E2E: HTML 块 iframe 渲染 — 三场景验证（Phase B Task 4 / 2026-05-10）
//
// 场景 1: language-html 块 → iframe.rt-html-block 创建（含 sandbox + 高度桥）
// 场景 2: 恶意 <script> 在 sandbox 内无法 改 parent.location
// 场景 3: >64KB HTML 块降级为 .rt-html-too-large 提示，不渲染 iframe
//
// 必须用 CLAUDE_HUB_DATA_DIR 隔离启动；PID 白名单由 hub-launcher 内建。
// 不调用真实 AI（避免依赖 API key + 加快）；通过 window.__rtTesting._renderMarkdown 直接触发渲染管线。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

(async () => {
  const DATA_DIR = path.join(os.tmpdir(), 'hub-html-e2e-' + Date.now());
  const PORT = 9231;

  let hub, client;
  let scenario = 'setup';

  try {
    console.log('[setup] launching isolated Hub:', { DATA_DIR, PORT });
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: PORT, label: 'html-e2e' });
    console.log('[setup] hub PID =', hub.pid);

    client = await connectFirstPage(hub);
    console.log('[setup] CDP connected');

    // 等 renderer 加载完成（meeting-room.js IIFE 跑完）
    await _waitMs(3000);

    // 验证 testing hook 已暴露
    const hookCheck = await client.eval('typeof (window.__rtTesting && window.__rtTesting._renderMarkdown)');
    if (hookCheck !== 'function') {
      throw new Error(`_renderMarkdown 未暴露到 window.__rtTesting，got: ${hookCheck}`);
    }
    console.log('[setup] __rtTesting._renderMarkdown 已暴露');

    // ============================================================
    // 场景 1: 圆桌内联渲染验证
    // ============================================================
    scenario = 'scene1';
    console.log('\n[scene1] 渲染 ```html``` 块 → iframe.rt-html-block');

    const md1 = '```html\n<table style="border-collapse:collapse"><tr><td style="padding:4px;border:1px solid #ccc">cell-A</td><td style="padding:4px;border:1px solid #ccc">cell-B</td></tr></table>\n```';
    const r1 = await client.eval(`(async () => {
      const fn = window.__rtTesting._renderMarkdown;
      const html = fn(${JSON.stringify(md1)});
      const div = document.createElement('div');
      div.id = 'e2e-html-test-1';
      div.style.cssText = 'position:absolute;top:-9999px;left:0;width:600px';
      div.innerHTML = html;
      document.body.appendChild(div);
      await new Promise(r => setTimeout(r, 1200));  // 等 iframe srcdoc 加载 + 高度桥触发
      const iframe = div.querySelector('iframe.rt-html-block');
      const result = {
        hasIframe: !!iframe,
        sandbox: iframe ? iframe.getAttribute('sandbox') : null,
        className: iframe ? iframe.className : null,
        clientHeight: iframe ? iframe.clientHeight : 0,
        styleHeight: iframe ? iframe.style.height : null,
        srcdocLen: iframe ? (iframe.srcdoc || '').length : 0,
      };
      // 不立即移除，留着等截图
      return result;
    })()`);
    console.log('[scene1] result:', r1);
    if (!r1.hasIframe) throw new Error('Scene 1: iframe.rt-html-block 未创建');
    if (r1.sandbox !== 'allow-scripts') throw new Error(`Scene 1: sandbox=${r1.sandbox}（应为 allow-scripts）`);
    if (r1.className !== 'rt-html-block') throw new Error(`Scene 1: class=${r1.className}`);
    if (r1.clientHeight < 50) {
      console.warn(`[scene1] WARN: iframe clientHeight=${r1.clientHeight}px（< 50，桥脚本可能 1.2s 内未触发；下面截图可看）`);
    }

    // ============================================================
    // 场景 2: 沙箱越权拦截
    // ============================================================
    scenario = 'scene2';
    console.log('\n[scene2] 恶意 <script> 不应改主页 location');

    const beforeHref = await client.eval('location.href');
    const evilHtml = '<script>try{parent.location="https://evil.example.com"}catch(e){window.__sandboxBlocked=true}</script><b>evil block</b>';
    const md2 = '```html\n' + evilHtml + '\n```';
    const r2 = await client.eval(`(async () => {
      const fn = window.__rtTesting._renderMarkdown;
      const html = fn(${JSON.stringify(md2)});
      const div = document.createElement('div');
      div.id = 'e2e-html-test-2';
      div.style.cssText = 'position:absolute;top:-9999px;left:0';
      div.innerHTML = html;
      document.body.appendChild(div);
      await new Promise(r => setTimeout(r, 1500));
      const result = {
        currentHref: location.href,
        // sandbox 跨域 → window.__sandboxBlocked 不会从 iframe 传到 parent，但 parent.location 也不会被改
      };
      div.remove();
      return result;
    })()`);
    console.log('[scene2] result:', r2);
    if (r2.currentHref !== beforeHref) {
      throw new Error(`Scene 2: parent location 被改，从 ${beforeHref} 到 ${r2.currentHref}`);
    }

    // ============================================================
    // 场景 3: 大块降级
    // ============================================================
    scenario = 'scene3';
    console.log('\n[scene3] >64KB HTML → .rt-html-too-large 提示');

    const md3 = '```html\n<div>' + 'x'.repeat(70000) + '</div>\n```';
    const r3 = await client.eval(`(() => {
      const fn = window.__rtTesting._renderMarkdown;
      const html = fn(${JSON.stringify(md3)});
      const div = document.createElement('div');
      div.id = 'e2e-html-test-3';
      div.style.cssText = 'position:absolute;top:-9999px;left:0';
      div.innerHTML = html;
      document.body.appendChild(div);
      const note = div.querySelector('.rt-html-too-large');
      const iframe = div.querySelector('iframe.rt-html-block');
      const result = {
        hasNote: !!note,
        hasIframe: !!iframe,
        noteText: note ? note.textContent : null,
      };
      div.remove();
      return result;
    })()`);
    console.log('[scene3] result:', r3);
    if (!r3.hasNote) throw new Error('Scene 3: .rt-html-too-large 提示未创建');
    if (r3.hasIframe) throw new Error('Scene 3: 超大 HTML 仍渲染了 iframe');
    if (!r3.noteText || !r3.noteText.includes('过大')) {
      throw new Error(`Scene 3: 提示文本异常: ${r3.noteText}`);
    }

    // ============================================================
    // 截图（通过 CDP Page.captureScreenshot）
    // ============================================================
    const shotDir = path.join(__dirname, '..', 'tmp');
    fs.mkdirSync(shotDir, { recursive: true });
    const shotPath = path.join(shotDir, 'e2e-html-block-' + Date.now() + '.png');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('\n[screenshot] 截图保存到:', shotPath);

    console.log('\n✅ E2E 三场景全过');
  } catch (e) {
    console.error(`\n❌ [scenario=${scenario}] ${e.message}`);
    if (hub) {
      console.error('--- Hub log tail (最近 30 行) ---');
      console.error(hub.log().slice(-30).join('\n'));
    }
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    console.log('[teardown] cleanup done');
  }
})();
