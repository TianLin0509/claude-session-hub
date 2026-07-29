'use strict';
// P1-2 / P1-3 真实 E2E（隔离 Hub + CDP）。
//
// P1-2：独立会话 header 上的 📁 路径（.metric-cwd）在有归档建议时要点亮提示态，
//       点击它才打开归档框 —— 以前这套只在 AI 群聊侧存在，独立会话的建议进了
//       没人读的 Map，用户永远看不到提示。
// P1-3：归档过程中的降级（codex rollout 搬不动等）过去只 console.warn，桌面图标
//       启动的 Hub 没有终端窗口 = 用户看不见。现在必须在归档框里摆出来。
//
// 跑法：node tests/e2e-archive-session-chip-cdp.js
// 截图落在 output/playwright/archive-session-chip/。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 从 Claude Code 会话里 spawn 测试 Hub 必须先剥离嵌套 env，否则测试 Hub spawn 的
// CLI 会自认嵌套子会话（CLAUDE.md「硬性规则 0」）。launchIsolatedHub 直接 spread
// process.env，所以要在这里就摘干净。
for (const key of [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID',
]) delete process.env[key];

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), 'Temp', 'hub-test-archive');
const CDP_PORT = Number(process.env.HUB_E2E_CDP_PORT || 9234);
const WORKSPACE_ROOT = path.join(DATA_DIR, 'workspaces');
const FAKE_BIN = path.join(DATA_DIR, 'fake-bin');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'archive-session-chip');

const SHOTS = {
  idle: path.join(ARTIFACT_DIR, `01-header-idle-${RUN_ID}.png`),
  hint: path.join(ARTIFACT_DIR, `02-header-archive-hint-${RUN_ID}.png`),
  modal: path.join(ARTIFACT_DIR, `03-archive-modal-from-chip-${RUN_ID}.png`),
  warnings: path.join(ARTIFACT_DIR, `04-archive-warnings-${RUN_ID}.png`),
};

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function pointFor(client, selector) {
  return client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { selector: ${JSON.stringify(selector)}, found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      selector: ${JSON.stringify(selector)}, found: true, x, y,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
    };
  })()`);
}

async function clickPoint(client, point) {
  assert.equal(point.found, true, `${point.selector} should exist`);
  assert.equal(point.visible, true, `${point.selector} should be visible`);
  assert.equal(point.topmost, true, `${point.selector} should be topmost (真的可点，不是被别的层盖住)`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

function writeFixtures() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'Tools'), { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fake = path.join(FAKE_BIN, 'fake-cli.js');
  fs.writeFileSync(fake, `'use strict';
process.stdout.write('FAKE_CLI_READY ' + process.argv[2] + '\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${provider}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`, 'utf8');
  }
}

async function main() {
  writeFixtures();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, dataDir: DATA_DIR, port: CDP_PORT, screenshots: SHOTS };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'archive-session-chip',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        HUB_WORKSPACE_E2E_ALLOW_FALLBACK_RESUME: '1',
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    await _waitMs(1200);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.eval(`(() => {
      window.__archiveE2eErrors = [];
      window.addEventListener('error', e => window.__archiveE2eErrors.push(String(e.error || e.message)));
      window.addEventListener('unhandledrejection', e => window.__archiveE2eErrors.push(String(e.reason)));
      return true;
    })()`);

    // --- 建一个普通会话（临时 workspace） ---
    await clickPoint(client, await pointFor(client, '#btn-new'));
    await waitFor('new session modal', () => client.eval(
      `(() => { const m = document.querySelector('#new-session-menu'); return m && m.style.display !== 'none'; })()`));
    await clickPoint(client, await pointFor(client, '#new-session-submit'));

    const session = await waitFor('session created', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const list = await ipcRenderer.invoke('get-sessions');
      const s = list.find(item => !item.meetingId);
      return s && s.cwd ? s : null;
    })()`), 30000);
    assert.ok(session.cwd.includes('_scratch'), `session must land in _scratch, got ${session.cwd}`);
    result.session = { id: session.id, cwd: session.cwd };

    await waitFor('header cwd chip', () => client.eval(
      `!!document.querySelector('.terminal-metrics-row .metric-cwd')`));
    await _waitMs(500);

    // --- 归档建议到达之前：chip 是普通态 ---
    result.beforeHint = await client.eval(`(() => {
      const chip = document.querySelector('.terminal-metrics-row .metric-cwd');
      const modal = document.querySelector('#workspace-archive-modal');
      return {
        text: chip.textContent,
        hasHint: chip.classList.contains('has-archive-hint'),
        title: chip.title,
        modalOpen: !!modal && modal.style.display !== 'none',
      };
    })()`);
    assert.equal(result.beforeHint.hasHint, false, '还没有建议时不该有提示态');
    assert.equal(result.beforeHint.modalOpen, false);
    await screenshot(client, SHOTS.idle);

    // --- 触发首轮结束那条真实链路（turn-complete-event 调的就是这个） ---
    await client.eval(`window.WorkspaceController.maybePromptSessionArchive(${JSON.stringify(session.id)})`);

    result.hint = await waitFor('archive hint on session header', () => client.eval(`(() => {
      const chip = document.querySelector('.terminal-metrics-row .metric-cwd');
      if (!chip || !chip.classList.contains('has-archive-hint')) return null;
      const modal = document.querySelector('#workspace-archive-modal');
      const style = getComputedStyle(chip);
      return {
        text: chip.textContent,
        title: chip.title,
        borderColor: style.borderColor,
        backgroundImage: style.backgroundImage,
        modalOpen: !!modal && modal.style.display !== 'none',
      };
    })()`), 20000);
    assert.equal(result.hint.modalOpen, false, '建议到达不许自动弹全局模态');
    assert.match(result.hint.title, /点击归档/, 'chip 要说明点了会发生什么');
    assert.ok(/210,\s*153,\s*34/.test(result.hint.borderColor), `提示态要有琥珀色描边，实际 ${result.hint.borderColor}`);
    assert.match(result.hint.backgroundImage, /radial-gradient/, '提示态要有末尾小圆点');
    await screenshot(client, SHOTS.hint);

    // --- 点击 header 上的 📁 路径 → 归档框 ---
    await clickPoint(client, await pointFor(client, '.terminal-metrics-row .metric-cwd'));
    result.modal = await waitFor('archive modal opened from session chip', () => client.eval(`(() => {
      const modal = document.querySelector('#workspace-archive-modal');
      if (!modal || modal.style.display === 'none') return null;
      return {
        source: modal.querySelector('#workspace-archive-source').title,
        categories: modal.querySelectorAll('.workspace-archive-categories button').length,
        chipHintCleared: !document.querySelector('.terminal-metrics-row .metric-cwd').classList.contains('has-archive-hint'),
      };
    })()`), 15000);
    assert.equal(result.modal.source, session.cwd, '归档框指的必须是这个会话的临时目录');
    assert.ok(result.modal.categories >= 1, '至少要有一个归档分类可选');
    assert.equal(result.modal.chipHintCleared, true, '点开后提示态收起');
    await screenshot(client, SHOTS.modal);

    // --- P1-3：塞一个 rollout 必然找不到的休眠 codex，逼出真实降级 ---
    await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const list = await ipcRenderer.invoke('get-sessions');
      const persisted = list.map(s => ({ hubId: s.id, kind: s.kind, title: s.title, cwd: s.cwd }));
      persisted.push({
        hubId: 'e2e-dormant-codex',
        kind: 'codex',
        title: 'E2E 休眠 Codex',
        cwd: ${JSON.stringify(session.cwd)},
        codexSid: '99999999-9999-4999-8999-999999999999',
        codexSessionsRoot: ${JSON.stringify(path.join(DATA_DIR, 'empty-codex-sessions'))},
      });
      ipcRenderer.send('persist-sessions', persisted, []);
      return true;
    })()`);
    await _waitMs(600);

    await clickPoint(client, await pointFor(client, '.workspace-archive-categories button'));
    await clickPoint(client, await pointFor(client, '#workspace-archive-submit'));

    result.warnings = await waitFor('archive degradation surfaced in UI', () => client.eval(`(() => {
      const modal = document.querySelector('#workspace-archive-modal');
      if (!modal || modal.style.display === 'none') return null;
      const box = modal.querySelector('#workspace-archive-warnings');
      if (!box || box.hidden) return null;
      const submit = modal.querySelector('#workspace-archive-submit');
      return {
        text: box.textContent,
        items: box.querySelectorAll('li').length,
        submitLabel: submit.textContent,
        errorShown: !modal.querySelector('#workspace-archive-error').hidden,
      };
    })()`), 60000);
    assert.ok(result.warnings.items >= 1, '至少要摆出一条降级');
    assert.match(result.warnings.text, /codex rollout|Codex/i, '降级原文必须可见');
    assert.equal(result.warnings.submitLabel, '知道了');
    assert.equal(result.warnings.errorShown, false, '归档本身成功，不该显示成红色错误');
    await screenshot(client, SHOTS.warnings);

    // --- 「知道了」才关闭 ---
    await clickPoint(client, await pointFor(client, '#workspace-archive-submit'));
    result.closed = await waitFor('modal closed after acknowledging', () => client.eval(`(() => {
      const modal = document.querySelector('#workspace-archive-modal');
      return modal && modal.style.display === 'none' ? true : null;
    })()`), 10000);

    result.archived = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const s = (await ipcRenderer.invoke('get-sessions')).find(item => item.id === ${JSON.stringify(session.id)});
      return s ? s.cwd : null;
    })()`);
    assert.ok(result.archived && !result.archived.includes('_scratch'),
      `归档后 cwd 应该离开 _scratch，实际 ${result.archived}`);

    result.rendererErrors = await client.eval(`window.__archiveE2eErrors || []`);
    assert.deepEqual(result.rendererErrors, [], `renderer errors: ${result.rendererErrors.join(' | ')}`);

    fs.writeFileSync(path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    if (hub) console.error('[hub log tail]\n' + hub.log().slice(-25).join('\n'));
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error((error && error.stack) || error);
  process.exitCode = 1;
});
