'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-home-workbench-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'fake-home');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'home-workbench');
const DESKTOP_SCREENSHOT = path.join(ARTIFACT_DIR, 'hub-workbench-desktop.png');
const NARROW_SCREENSHOT = path.join(ARTIFACT_DIR, 'hub-workbench-narrow.png');
const RESULT_PATH = path.join(ARTIFACT_DIR, 'hub-workbench-e2e-result.json');
const SAMPLE_ARTIFACT = path.join(TEMP_ROOT, 'sample-workbench-report.html');
const CDP_PORT = Number(process.env.HUB_HOME_WORKBENCH_E2E_PORT || (10080 + (process.pid % 180)));

async function capture(client, filePath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const workspaceRoot = path.join(DATA_DIR, 'workspaces', 'user');
  for (const category of ['AI', 'Wireless', 'Stock']) fs.mkdirSync(path.join(workspaceRoot, category), { recursive: true });
  fs.writeFileSync(SAMPLE_ARTIFACT, '<!doctype html><meta charset="utf-8"><title>Workbench artifact</title><h1>最近产物测试</h1>', 'utf8');
  const observedAt = Date.now();
  const reset5h = observedAt + 3 * 60 * 60_000;
  const reset7d = observedAt + 5 * 24 * 60 * 60_000;
  fs.writeFileSync(path.join(DATA_DIR, 'usage-cache.json'), JSON.stringify({
    claude: { usage5h: { pct: 34, resetsAt: reset5h }, usage7d: { pct: 47, resetsAt: reset7d }, observedAt },
    codex: { usage5h: { pct: 42, resetsAt: reset5h }, usage7d: { pct: 51, resetsAt: reset7d }, observedAt },
    kimi: { usage5h: { pct: 18, resetsAt: reset5h }, usage7d: { pct: 26, resetsAt: reset7d }, observedAt },
    deepseek: {
      available: true,
      currency: 'CNY',
      totalBalance: 39.47,
      toppedUpBalance: 39.47,
      grantedBalance: 0,
      observedAt,
      source: 'deepseek-balance-api',
    },
  }), 'utf8');
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, cdpPort: CDP_PORT };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'hub-workbench',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    await _waitMs(900);
    client = await connectFirstPage(hub, (target) => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    result.desktop = await client.eval(`(async () => {
      const deadline = Date.now() + 5000;
      while ((!window.__hubE2E || !document.getElementById('empty-state').dataset.homeReady) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      window.__homeWorkbenchErrors = [];
      window.addEventListener('error', event => window.__homeWorkbenchErrors.push(String(event.message || event.error || 'error')));
      const now = Date.now();
      const nightCompletionDate = new Date(now);
      if (nightCompletionDate.getHours() >= 8 && nightCompletionDate.getHours() < 20) {
        nightCompletionDate.setHours(7, 0, 0, 0);
      } else {
        nightCompletionDate.setTime(now - 10 * 60_000);
      }
      const nightCompletion = nightCompletionDate.getTime();
      window.__hubE2E.clearSessions();
      window.__hubE2E.addFakeSessions([
        { id:'home-wait', kind:'codex', title:'Codex 提交范围确认', status:'idle', isWaiting:true, unreadCount:1, waitingText:'需要确认本次提交范围', lastMessageTime:now - 60_000 },
        { id:'home-run', kind:'claude', title:'AI Hub 主页实现', status:'running', contextPct:93, runStartedAt:now - 22 * 60_000, _lastOutputTs:now - 8 * 60_000, lastOutputPreview:'正在验证 HUB 工作台', lastMessageTime:now - 8 * 60_000 },
        { id:'home-done', kind:'kimi', title:'无线仿真结果复核', status:'idle', unreadCount:1, lastOutputPreview:'门 2 已通过，结论可交付', lastMessageTime:nightCompletion, lastCompletedAt:nightCompletion, lastRunDurationMs:18 * 60_000, recentArtifacts:[{path:${JSON.stringify(SAMPLE_ARTIFACT)},timestamp:nightCompletion}] },
        { id:'home-sleep', kind:'gemini', title:'历史资料整理', status:'dormant', lastMessageTime:now - 2 * 86400_000 }
      ]);
      await new Promise(resolve => setTimeout(resolve, 220));
      const research = document.getElementById('btn-chuxin').getBoundingClientRect();
      return {
        title: document.getElementById('home-workbench-title').textContent,
        topButton: document.querySelector('#btn-home .btn-label').textContent,
        metrics: {
          active: document.getElementById('home-metric-active').textContent,
          waiting: document.getElementById('home-metric-waiting').textContent,
          unread: document.getElementById('home-metric-unread').textContent,
          dormant: document.getElementById('home-metric-dormant').textContent,
        },
        lanes: {
          waiting: Array.from(document.querySelectorAll('#home-lane-waiting .home-flow-item')).map(el => el.textContent.trim()),
          running: Array.from(document.querySelectorAll('#home-lane-running .home-flow-item')).map(el => el.textContent.trim()),
          delivered: Array.from(document.querySelectorAll('#home-lane-delivered .home-flow-item')).map(el => el.textContent.trim()),
        },
        researchVisible: research.width > 0 && research.height > 0,
        notificationInHeader: document.getElementById('completion-notification-toggle').parentElement.id === 'home-notification-slot',
        viewToggleHidden: getComputedStyle(document.querySelector('.view-toggle')).display === 'none',
        respondPillHidden: getComputedStyle(document.getElementById('respond-pill')).display === 'none',
        providerTitle: document.getElementById('home-provider-title').textContent.trim(),
        providerRows: Array.from(document.querySelectorAll('#home-provider-health .home-provider-row')).map(row => row.textContent.replace(/\s+/g, ' ').trim()),
        deepseekBalance: Array.from(document.querySelectorAll('.home-provider-row')).find(row => row.textContent.includes('DeepSeek API'))?.textContent.replace(/\s+/g, ' ').trim() || '',
        operational: {
          exceptions: document.querySelectorAll('#home-exception-list .home-insight-row').length,
          contextRisks: document.querySelectorAll('#home-context-risk .home-insight-row').length,
          artifacts: document.querySelectorAll('#home-artifact-list .home-artifact-item').length,
          workspaces: document.querySelectorAll('#home-workspace-launch .home-workspace-item').length,
          nightCompleted: document.getElementById('home-night-completed').textContent,
          usageWindows: document.querySelectorAll('#home-provider-health .home-usage-window').length,
          usageRefreshTimes: document.querySelectorAll('#home-provider-health .home-usage-reset').length,
          updatedLabels: document.querySelectorAll('#home-provider-health [data-usage-updated="true"]').length,
          snapshotElements: document.querySelectorAll('#home-provider-health .home-trend-row, #home-provider-health .home-trend-spark').length,
          runningText: document.getElementById('home-lane-running').textContent.replace(/\s+/g, ' ').trim(),
        },
        fontSizes: {
          title: parseFloat(getComputedStyle(document.getElementById('home-workbench-title')).fontSize),
          section: parseFloat(getComputedStyle(document.getElementById('home-flow-title')).fontSize),
          lane: parseFloat(getComputedStyle(document.getElementById('home-waiting-title')).fontSize),
        },
        replacementChars: (document.body.innerText.match(/\uFFFD/g) || []).length,
      };
    })()`);

    assert.equal(result.desktop.title, 'HUB 工作台');
    assert.equal(result.desktop.topButton, '主页');
    assert.deepStrictEqual(result.desktop.metrics, { active: '3', waiting: '1', unread: '2', dormant: '1' });
    assert.match(result.desktop.lanes.waiting[0], /Codex 提交范围确认/);
    assert.match(result.desktop.lanes.running[0], /AI Hub 主页实现/);
    assert.match(result.desktop.lanes.delivered[0], /无线仿真结果复核/);
    assert.equal(result.desktop.researchVisible, true);
    assert.equal(result.desktop.notificationInHeader, true);
    assert.equal(result.desktop.viewToggleHidden, true);
    assert.equal(result.desktop.respondPillHidden, true);
    assert.equal(result.desktop.providerTitle, '四模型用量');
    assert.equal(result.desktop.providerRows.length, 4);
    for (const [index, provider] of ['Claude', 'Codex', 'Kimi'].entries()) {
      assert.match(result.desktop.providerRows[index], new RegExp(`${provider}.*更新于.*5h.*7d`));
      assert.match(result.desktop.providerRows[index], /(?:后刷新|刷新时间未知)/);
    }
    assert.match(result.desktop.deepseekBalance, /余额 ¥39\.47 · 可用/);
    assert.match(result.desktop.deepseekBalance, /更新于/);
    assert.ok(result.desktop.operational.exceptions >= 2);
    assert.equal(result.desktop.operational.contextRisks, 1);
    assert.equal(result.desktop.operational.artifacts, 1);
    assert.ok(result.desktop.operational.workspaces >= 3);
    assert.equal(result.desktop.operational.nightCompleted, '1');
    assert.equal(result.desktop.operational.usageWindows, 6);
    assert.equal(result.desktop.operational.usageRefreshTimes, 6);
    assert.equal(result.desktop.operational.updatedLabels, 4);
    assert.equal(result.desktop.operational.snapshotElements, 0);
    assert.match(result.desktop.operational.runningText, /长任务 · 已运行 22 分钟/);
    assert.ok(result.desktop.fontSizes.title >= 25);
    assert.ok(result.desktop.fontSizes.section >= 14);
    assert.ok(result.desktop.fontSizes.lane >= 12);
    assert.equal(result.desktop.replacementChars, 0);
    await capture(client, DESKTOP_SCREENSHOT);

    result.actions = await client.eval(`(async () => {
      const artifact = document.querySelector('#home-artifact-list .home-artifact-item');
      artifact.click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const artifactPreviewVisible = getComputedStyle(document.getElementById('preview-panel')).display !== 'none';
      document.getElementById('preview-close').click();

      const workspace = document.querySelector('#home-workspace-launch .home-workspace-item');
      const expectedWorkspace = workspace.title;
      workspace.click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const newSessionMenuVisible = getComputedStyle(document.getElementById('new-session-menu')).display === 'flex';
      const newSessionSummary = document.getElementById('new-session-summary').textContent;
      document.getElementById('new-session-close').click();

      let copied = '';
      const originalInvoke = ipcRenderer.invoke;
      ipcRenderer.invoke = function(channel, payload) {
        if (channel === 'parse-session-transcript') {
          return Promise.resolve({ turns: [
            { role:'user', text:'第一问' }, { role:'assistant', text:'第一答', kind:'claude' },
            { role:'user', text:'第二问' }, { role:'assistant', text:'第二答', kind:'claude' },
            { role:'user', text:'第三问' }, { role:'assistant', text:'第三答', kind:'claude' },
          ] });
        }
        return originalInvoke.call(this, channel, payload);
      };
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText: async value => { copied = String(value); } } });
      } catch {}
      document.querySelector('#home-context-risk [data-home-action="copy-turns"]').click();
      await new Promise(resolve => setTimeout(resolve, 160));
      ipcRenderer.invoke = originalInvoke;
      return {
        artifactPreviewVisible,
        expectedWorkspace,
        newSessionMenuVisible,
        newSessionSummary,
        copiedHasRoles: copied.includes('我：') && copied.includes('AI（Claude）：'),
        copiedHasThreeRounds: copied.includes('第 3 轮'),
      };
    })()`);
    assert.equal(result.actions.artifactPreviewVisible, true);
    assert.equal(result.actions.newSessionMenuVisible, true);
    assert.match(result.actions.newSessionSummary, /Claude Code/);
    assert.equal(result.actions.copiedHasRoles, true);
    assert.equal(result.actions.copiedHasThreeRounds, true);

    result.navigation = await client.eval(`(async () => {
      document.querySelector('[data-home-id="home-wait"]').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const sessionTitle = document.querySelector('.terminal-title');
      const sessionOpened = !!sessionTitle && sessionTitle.textContent === 'Codex 提交范围确认';
      document.getElementById('btn-home').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const homeVisibleAfterSession = document.getElementById('empty-state').isConnected
        && document.getElementById('empty-state').style.display !== 'none';
      document.getElementById('btn-chuxin').click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const chuxinVisible = getComputedStyle(document.getElementById('chuxin-panel')).display === 'grid';
      document.getElementById('btn-home').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        sessionOpened,
        homeVisibleAfterSession,
        chuxinVisible,
        homeVisibleAfterResearch: getComputedStyle(document.getElementById('empty-state')).display !== 'none',
        chuxinHiddenAfterHome: getComputedStyle(document.getElementById('chuxin-panel')).display === 'none',
        errors: window.__homeWorkbenchErrors.slice(),
      };
    })()`);
    assert.equal(result.navigation.sessionOpened, true);
    assert.equal(result.navigation.homeVisibleAfterSession, true);
    assert.equal(result.navigation.chuxinVisible, true);
    assert.equal(result.navigation.homeVisibleAfterResearch, true);
    assert.equal(result.navigation.chuxinHiddenAfterHome, true);
    assert.deepStrictEqual(result.navigation.errors, []);

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 760,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await _waitMs(120);
    result.narrow = await client.eval(`(() => {
      const root = document.getElementById('empty-state');
      const grid = document.querySelector('.home-pulse-grid');
      const columns = document.querySelector('.home-flow-columns');
      const metrics = document.querySelector('.home-metrics').getBoundingClientRect();
      const notification = document.getElementById('completion-notification-toggle').getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
        pulseColumns: getComputedStyle(grid).gridTemplateColumns,
        flowColumns: getComputedStyle(columns).gridTemplateColumns,
        notificationBottom: Math.round(notification.bottom),
        metricsTop: Math.round(metrics.top),
      };
    })()`);
    assert.equal(result.narrow.viewportWidth, 760);
    assert.equal(result.narrow.horizontalOverflow, false);
    assert.ok(result.narrow.notificationBottom <= result.narrow.metricsTop,
      `home header controls must not overlap metrics (${result.narrow.notificationBottom} > ${result.narrow.metricsTop})`);
    await capture(client, NARROW_SCREENSHOT);

    result.desktopScreenshot = DESKTOP_SCREENSHOT;
    result.narrowScreenshot = NARROW_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
