'use strict';
// 诊断脚本（非测试）：在隔离 Hub 里测 xterm cols 与实际可视宽度是否一致。
// 用户报告 PTY 右侧被截断 / 命令行在边缘断词，怀疑 FitAddon 算出的 cols 偏大。
//   node tests/diag-pty-fit.js

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-pty-fit-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await _waitMs(150);
  }
  throw new Error(`timeout waiting ${label}${last ? `: ${last.message}` : ''}`);
}

// 假 claude：只回显一行超长文本，用来观察换行位置。
function writeFakeBin() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const ruler = 'X'.repeat(400);
  fs.writeFileSync(path.join(FAKE_BIN, 'claude.cmd'),
    `@echo off\r\necho FAKE_CLI_READY\r\necho ${ruler}\r\n:loop\r\nset /p _x=\r\ngoto loop\r\n`, 'utf8');
}

async function main() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  writeFakeBin();
  const port = await reservePort();
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port,
    label: 'pty-fit',
    extraEnv: {
      AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
      PATH: `${FAKE_BIN};${process.env.PATH}`,
      CLAUDE_HUB_NO_EFFORT_MAX: '1',
    },
  });

  let client = null;
  try {
    client = await connectFirstPage(hub);
    await waitFor('sidebar', () => client.eval('!!document.getElementById("btn-new")'));

    await client.eval(`(async () => {
      const ws = await window.WorkspaceController.createScratch('pty-fit');
      await window.WorkspaceController.createSession('claude', { workspace: ws });
      return true;
    })()`);

    await waitFor('xterm screen', () => client.eval(
      '!!document.querySelector(".terminal-container .xterm-screen")'));
    await _waitMs(2500);

    const probe = await client.eval(`(() => {
      const panel = document.querySelector('#terminal-panel');
      const wrap = document.querySelector('.terminal-container .xterm');
      const screen = document.querySelector('.terminal-container .xterm-screen');
      const viewport = document.querySelector('.terminal-container .xterm-viewport');
      const host = wrap && wrap.parentElement;
      const cs = host ? getComputedStyle(host) : null;
      const rowEl = document.querySelector('.terminal-container .xterm-rows > div');
      return {
        panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
        hostWidth: host ? Math.round(host.getBoundingClientRect().width) : null,
        hostPadLeft: cs ? cs.paddingLeft : null,
        hostPadRight: cs ? cs.paddingRight : null,
        xtermWidth: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
        screenWidth: screen ? Math.round(screen.getBoundingClientRect().width) : null,
        viewportClient: viewport ? viewport.clientWidth : null,
        viewportOffset: viewport ? viewport.offsetWidth : null,
        scrollbarWidth: viewport ? viewport.offsetWidth - viewport.clientWidth : null,
        rowScrollWidth: rowEl ? rowEl.scrollWidth : null,
      };
    })()`);

    // xterm 实例不在 window 上，从渲染出的行元素反推每列宽度。
    const metrics = await client.eval(`(() => {
      const screen = document.querySelector('.terminal-container .xterm-screen');
      const rows = document.querySelectorAll('.terminal-container .xterm-rows > div');
      let widest = 0, text = '';
      rows.forEach(r => { const t = r.textContent || ''; if (t.trimEnd().length > widest) { widest = t.trimEnd().length; text = t.trimEnd(); } });
      return {
        screenWidth: screen ? screen.getBoundingClientRect().width : null,
        widestRowChars: widest,
        sample: text.slice(0, 24),
        rowCount: rows.length,
      };
    })()`);

    console.log(JSON.stringify({ probe, metrics }, null, 2));
    const visible = probe.viewportClient;
    if (probe.screenWidth != null && visible != null) {
      console.log(`\nxterm-screen 宽度 = ${probe.screenWidth}px, viewport 可视 = ${visible}px, 溢出 = ${probe.screenWidth - visible}px`);
      console.log(`滚动条占位 = ${probe.scrollbarWidth}px`);
    }
  } finally {
    if (client) await client.close().catch(() => {});
    await gracefulQuit(hub);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('diag failed:', err && err.message);
  if (err && err.logTail) console.error(err.logTail);
  process.exitCode = 1;
});
