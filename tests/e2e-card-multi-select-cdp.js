'use strict';

// 卡片多选复制的真实验收：隔离 Hub + 真 CDP + 真剪贴板。
// 单测里的 DOM 替身证明不了「小圆圈真的画出来了」「点击真的被多选拦下来了」
// 这两件只有真实 CSS / 事件传播才能回答的事。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-multi-select-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const TRANSCRIPT_PATH = path.join(TEMP_ROOT, 'card-multi-select.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-multi-select');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `card-multi-select-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function jsonl(value) {
  return JSON.stringify(value) + '\n';
}

function writeTranscript() {
  const lines = [];
  const base = Date.now() - 60000;
  for (let i = 1; i <= 4; i += 1) {
    lines.push(jsonl({
      type: 'user', uuid: `multi-u-${i}`, timestamp: new Date(base + i * 2000).toISOString(),
      message: { content: `多选问题 ${i}` },
    }));
    lines.push(jsonl({
      type: 'assistant', uuid: `multi-a-${i}`, timestamp: new Date(base + i * 2000 + 900).toISOString(),
      message: {
        model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: `多选回答 ${i}` }],
      },
    }));
  }
  fs.writeFileSync(TRANSCRIPT_PATH, lines.join(''), 'utf8');
}

function availablePort(preferred) {
  return new Promise((resolve, reject) => {
    const tryPort = port => {
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    try { tryPort(preferred); } catch (error) { reject(error); }
  });
}

async function waitForEval(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeTranscript();
  const port = await availablePort(Number(process.env.HUB_CARD_MULTI_SELECT_E2E_PORT || 19860));
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'card-multi-select',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 940, deviceScaleFactor: 1, mobile: false,
    });
    await waitForEval(client, 'window.__hubE2E && window._loadSessionHistoryToOverlay', 'Hub E2E card APIs');

    result.run = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      // 和「复制对话」一样只有 Electron 原生这一个剪贴板写入方，直接校验真剪贴板。
      const { clipboard: __clip } = require('electron');
      const backup = __clip.readText();
      __clip.writeText('');

      const sid = 'card-multi-select-session';
      window.__hubE2E.addFakeSession({
        id: sid,
        kind: 'claude',
        title: '卡片多选复制验收',
        status: 'idle',
        transcriptPath: ${JSON.stringify(TRANSCRIPT_PATH)},
        createdAt: Date.now(),
        lastMessageTime: Date.now(),
      });
      await window.__hubE2E.selectSession(sid, { forceScrollBottom: true });
      applyViewMode('card');
      const overlay = document.getElementById('msg-overlay');
      const cards = () => Array.from(overlay.querySelectorAll(':scope > .turn-card'));
      for (let i = 0; i < 80 && cards().length < 8; i += 1) await wait(100);

      const bar = document.getElementById('card-multi-select-bar');
      const countEl = document.getElementById('card-multi-select-count');
      const allBtn = document.getElementById('card-multi-select-all');
      const copyBtn = document.getElementById('card-multi-select-copy');
      const exitBtn = document.getElementById('card-multi-select-exit');
      const out = { cardCount: cards().length, barHiddenBefore: bar.hidden };

      // 入口：卡片头部那一行的「多选」按钮。
      const entryBtn = cards()[0].querySelector('[data-action="multi-select"]');
      out.entryLabel = entryBtn ? entryBtn.textContent.trim() : null;
      out.entryInHeader = !!(entryBtn && entryBtn.closest('.turn-actions'));
      entryBtn.click();
      await wait(60);

      out.barVisibleAfterEnter = !bar.hidden && bar.getBoundingClientRect().height > 0;
      out.countAfterEnter = countEl.textContent;
      out.overlayActive = overlay.classList.contains('multi-select-active');
      // 小圆圈是真画出来的（伪元素），不是只加了个 class。
      const circle = getComputedStyle(cards()[1], '::before');
      out.circle = { width: circle.width, height: circle.height, borderRadius: circle.borderRadius, content: circle.content };
      // 用户气泡整行是 row-reverse：不给 order 的话圆圈会跑到最右边，不在「卡片前面」。
      out.userCircleOrder = getComputedStyle(cards()[0], '::before').order;
      out.aiCircleOrder = getComputedStyle(cards()[1], '::before').order;
      out.actionsHidden = getComputedStyle(cards()[0].querySelector('.turn-actions')).display === 'none';

      // 多选态下点卡片正文 = 勾选，而不是触发卡片原有的按钮/链接行为。
      cards()[2].querySelector('.turn-body').click();
      await wait(40);
      out.countAfterSecond = countEl.textContent;
      out.selectedClasses = cards().map(c => c.classList.contains('multi-selected'));
      out.ariaChecked = cards().map(c => c.getAttribute('aria-checked'));
      out.ariaRole = cards()[0].getAttribute('role');

      __clip.writeText('');
      copyBtn.click();
      for (let i = 0; i < 40 && !__clip.readText(); i += 1) await wait(50);
      await wait(50);
      out.copied = __clip.readText();
      out.copyButtonText = copyBtn.textContent;

      // 全选 / 取消全选
      allBtn.click();
      await wait(40);
      out.countAfterAll = countEl.textContent;
      out.allBtnTextWhenAll = allBtn.textContent;
      allBtn.click();
      await wait(40);
      out.countAfterClear = countEl.textContent;
      out.copyDisabledWhenEmpty = copyBtn.disabled;

      // Esc 退出
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(60);
      out.barHiddenAfterEsc = bar.hidden;
      out.overlayActiveAfterEsc = overlay.classList.contains('multi-select-active');
      out.anySelectedAfterEsc = cards().some(c => c.classList.contains('multi-selected'));
      out.actionsBackAfterEsc = getComputedStyle(cards()[0].querySelector('.turn-actions')).display !== 'none';

      // 退出按钮同样有效；切到 PTY 视图必须自动退出多选。
      cards()[0].querySelector('[data-action="multi-select"]').click();
      await wait(40);
      exitBtn.click();
      await wait(40);
      out.barHiddenAfterExitBtn = bar.hidden;

      cards()[0].querySelector('[data-action="multi-select"]').click();
      await wait(40);
      applyViewMode('pty');
      await wait(60);
      out.barHiddenInPty = bar.hidden;
      applyViewMode('card');
      await wait(60);
      out.barHiddenBackInCard = bar.hidden;

      // 截图留一张「多选中」的现场
      cards()[0].querySelector('[data-action="multi-select"]').click();
      await wait(40);
      cards()[2].click();
      await wait(80);

      try { __clip.writeText(backup || ''); } catch {}
      return out;
    })()`);

    const r = result.run;
    assert.equal(r.cardCount, 8, JSON.stringify(r));
    assert.equal(r.barHiddenBefore, true, '没进多选时操作条必须是隐藏的');
    assert.equal(r.entryLabel, '多选', `入口按钮文案必须是中文「多选」，实际 ${r.entryLabel}`);
    assert.equal(r.entryInHeader, true, '入口按钮必须落在卡片头部操作行里');
    assert.equal(r.barVisibleAfterEnter, true, JSON.stringify(r));
    assert.equal(r.countAfterEnter, '已选 1 条', '进入多选时起点卡片应已勾上');
    assert.equal(r.overlayActive, true);
    assert.equal(r.circle.width, '18px', `小圆圈没画出来：${JSON.stringify(r.circle)}`);
    assert.equal(r.circle.height, '18px', JSON.stringify(r.circle));
    assert.equal(r.circle.borderRadius, '50%', JSON.stringify(r.circle));
    // 勾的字形一旦写错（比如 CSS 转义没写对）会静默变成别的字符，肉眼在 18px 上看不出来。
    assert.match(r.circle.content, /✓/, `圆圈里的勾字形不对：${r.circle.content}`);
    assert.equal(r.userCircleOrder, '1', '用户气泡（row-reverse）的圆圈必须靠 order 挪到最左');
    assert.equal(r.aiCircleOrder, '0', JSON.stringify(r));
    assert.equal(r.actionsHidden, true, '多选态下卡片原有操作按钮要让位');
    assert.equal(r.countAfterSecond, '已选 2 条', '点卡片正文应该是勾选，不是触发正文里的行为');
    assert.deepEqual(r.selectedClasses.slice(0, 4), [true, false, true, false], JSON.stringify(r.selectedClasses));
    assert.deepEqual(r.ariaChecked.slice(0, 3), ['true', 'false', 'true'], JSON.stringify(r.ariaChecked));
    assert.equal(r.ariaRole, 'checkbox', 'aria-checked 必须配 role 才被读屏软件承认');

    assert.match(r.copyButtonText, /已复制 2 条/);
    assert.match(r.copied, /^===== 转发 2 条消息 =====/);
    assert.match(r.copied, /【1】我 · [\s\S]*多选问题 1/);
    assert.match(r.copied, /【2】我 · [\s\S]*多选问题 2/);
    assert.doesNotMatch(r.copied, /多选回答/, '没勾的卡片不许混进来');
    assert.doesNotMatch(r.copied, /===== 第 \d+ 轮 =====/, '多选是逐条转发，不是按轮分组');
    assert.doesNotMatch(r.copied, /复制对话|一键复制|全选|📋/, '按钮文案不许被当成正文复制进去');

    assert.equal(r.countAfterAll, '已选 8 条');
    assert.equal(r.allBtnTextWhenAll, '取消全选');
    assert.equal(r.countAfterClear, '已选 0 条');
    assert.equal(r.copyDisabledWhenEmpty, true, '没勾任何一条时复制按钮应禁用');

    assert.equal(r.barHiddenAfterEsc, true, 'Esc 必须退出多选');
    assert.equal(r.overlayActiveAfterEsc, false);
    assert.equal(r.anySelectedAfterEsc, false);
    assert.equal(r.actionsBackAfterEsc, true, '退出后卡片操作按钮要回来');
    assert.equal(r.barHiddenAfterExitBtn, true, '「退出多选」按钮必须有效');
    assert.equal(r.barHiddenInPty, true, '切到 PTY 视图必须自动退出多选');
    assert.equal(r.barHiddenBackInCard, true, '切回卡片视图不应自动重新进入多选');

    await screenshot(client, SCREENSHOT_PATH);
    result.screenshot = SCREENSHOT_PATH;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    const tempBase = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(tempBase) && path.basename(resolved).startsWith('hub-card-multi-select-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
