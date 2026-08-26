'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
const REVIEW_SCREENSHOT = path.join(ARTIFACT_DIR, 'hub-workbench-review-cockpit.png');
const RESULT_PATH = path.join(ARTIFACT_DIR, 'hub-workbench-e2e-result.json');
const SAMPLE_ARTIFACT = path.join(TEMP_ROOT, 'sample-workbench-report.html');
const REVIEW_REPO = path.join(TEMP_ROOT, 'review-repo');
const RESTORE_ROOT = path.join(TEMP_ROOT, 'restores');
const CDP_PORT = Number(process.env.HUB_HOME_WORKBENCH_E2E_PORT || (10080 + (process.pid % 180)));

async function capture(client, filePath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

function git(args) {
  return execFileSync('git', args, { cwd: REVIEW_REPO, encoding: 'utf8', windowsHide: true }).trim();
}

async function startMetricsServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.url === '/health') response.end(JSON.stringify({ status: 'ok' }));
    else if (request.url === '/metrics') response.end(JSON.stringify({
      status: 'ok',
      cpuPct: 22,
      memoryPct: 31,
      storage: { mount: '/data', totalBytes: 1_000_000_000, usedBytes: 750_000_000 },
    }));
    else { response.statusCode = 404; response.end(JSON.stringify({ status: 'missing' })); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(REVIEW_REPO, { recursive: true });
  fs.mkdirSync(RESTORE_ROOT, { recursive: true });
  const workspaceRoot = path.join(DATA_DIR, 'workspaces', 'user');
  for (const category of ['AI', 'Wireless', 'Stock']) fs.mkdirSync(path.join(workspaceRoot, category), { recursive: true });
  fs.writeFileSync(SAMPLE_ARTIFACT, '<!doctype html><meta charset="utf-8"><title>Workbench artifact</title><h1>最近产物测试</h1>', 'utf8');
  git(['init']);
  git(['config', 'user.name', 'Hub E2E']);
  git(['config', 'user.email', 'hub-e2e@example.invalid']);
  fs.mkdirSync(path.join(REVIEW_REPO, 'core'), { recursive: true });
  fs.writeFileSync(path.join(REVIEW_REPO, 'core', 'review-engine.js'), 'function review(value) {\n  return value;\n}\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'initial review fixture']);
  fs.writeFileSync(path.join(REVIEW_REPO, 'core', 'review-engine.js'), 'function review(value) {\n  const normalized = String(value).trim();\n  return normalized;\n}\n', 'utf8');
  fs.mkdirSync(path.join(REVIEW_REPO, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(REVIEW_REPO, 'tests', 'review-engine.test.js'), 'assert(review(" x ") === "x");\n', 'utf8');
  const metricsFixture = await startMetricsServer();
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    operations: {
      aliyun_monitor: {
        enabled: true,
        label: '阿里云 E2E',
        health_url: `http://127.0.0.1:${metricsFixture.port}/health`,
        metrics_url: `http://127.0.0.1:${metricsFixture.port}/metrics`,
      },
      restore_root: RESTORE_ROOT,
    },
  }, null, 2), 'utf8');
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
      windowMode: 'hidden',
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
      window.addEventListener('unhandledrejection', event => window.__homeWorkbenchErrors.push(String(event.reason && (event.reason.stack || event.reason.message) || event.reason || 'unhandled rejection')));
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
        { id:'home-run', kind:'claude', title:'AI Hub 主页实现', cwd:${JSON.stringify(REVIEW_REPO)}, status:'running', contextPct:93, runStartedAt:now - 22 * 60_000, _lastOutputTs:now - 8 * 60_000, lastOutputPreview:'正在验证 HUB 工作台', lastMessageTime:now - 8 * 60_000 },
        { id:'home-done', kind:'kimi', title:'无线仿真结果复核', status:'idle', unreadCount:1, lastOutputPreview:'门 2 已通过，结论可交付', lastMessageTime:nightCompletion, lastCompletedAt:nightCompletion, lastRunDurationMs:18 * 60_000, recentArtifacts:[{path:${JSON.stringify(SAMPLE_ARTIFACT)},timestamp:nightCompletion}] },
        { id:'home-sleep', kind:'gemini', title:'历史资料整理', status:'dormant', lastMessageTime:now - 2 * 86400_000 }
      ]);
      document.getElementById('home-refresh').click();
      const operationsDeadline = Date.now() + 12000;
      while (document.getElementById('home-review-files').textContent !== '2' && Date.now() < operationsDeadline) {
        await new Promise(resolve => setTimeout(resolve, 60));
      }
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
        review: {
          repos: document.getElementById('home-review-repos').textContent,
          files: document.getElementById('home-review-files').textContent,
          cards: document.querySelectorAll('#home-review-list .home-review-item').length,
          text: document.getElementById('home-review-list').textContent.replace(/\\s+/g, ' ').trim(),
        },
        researchVisible: research.width > 0 && research.height > 0,
        notificationInHeader: document.getElementById('completion-notification-toggle').parentElement.id === 'home-notification-slot',
        viewToggleHidden: getComputedStyle(document.querySelector('.view-toggle')).display === 'none',
        respondPillHidden: getComputedStyle(document.getElementById('respond-pill')).display === 'none',
        providerTitle: document.getElementById('home-provider-title').textContent.trim(),
        providerRows: Array.from(document.querySelectorAll('#home-provider-health .home-provider-row')).map(row => row.textContent.replace(/\\s+/g, ' ').trim()),
        deepseekBalance: Array.from(document.querySelectorAll('.home-provider-row')).find(row => row.textContent.includes('DeepSeek API'))?.textContent.replace(/\\s+/g, ' ').trim() || '',
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
          recentGitFiles: document.querySelectorAll('#home-artifact-list .home-file-source.git').length,
          recentArtifacts: document.querySelectorAll('#home-artifact-list .home-file-source.artifact').length,
          pipelineAbsent: !document.getElementById('home-flow-columns') && !document.body.textContent.includes('Session 流水线'),
        },
        system: {
          cpu: document.getElementById('home-system-cpu').textContent,
          gpu: document.getElementById('home-system-gpu').textContent,
          memory: document.getElementById('home-system-memory').textContent,
          disk: document.getElementById('home-system-disk').textContent,
          server: document.getElementById('home-server-status').textContent.replace(/\\s+/g, ' ').trim(),
          serverClass: document.getElementById('home-server-status').className,
        },
        fontSizes: {
          title: parseFloat(getComputedStyle(document.getElementById('home-workbench-title')).fontSize),
          section: parseFloat(getComputedStyle(document.getElementById('home-review-title')).fontSize),
          review: parseFloat(getComputedStyle(document.querySelector('.home-review-item strong')).fontSize),
        },
        replacementChars: (document.body.innerText.match(/\uFFFD/g) || []).length,
      };
    })()`);

    assert.equal(result.desktop.title, 'HUB 工作台');
    assert.equal(result.desktop.topButton, '主页');
    assert.deepStrictEqual(result.desktop.metrics, { active: '3', waiting: '1', unread: '2', dormant: '1' });
    assert.deepStrictEqual(result.desktop.review.repos, '1');
    assert.deepStrictEqual(result.desktop.review.files, '2');
    assert.equal(result.desktop.review.cards, 1);
    assert.match(result.desktop.review.text, /review-repo/);
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
    assert.equal(result.desktop.operational.artifacts, 3);
    assert.ok(result.desktop.operational.workspaces >= 3);
    assert.equal(result.desktop.operational.nightCompleted, '1');
    assert.equal(result.desktop.operational.usageWindows, 6);
    assert.equal(result.desktop.operational.usageRefreshTimes, 6);
    assert.equal(result.desktop.operational.updatedLabels, 4);
    assert.equal(result.desktop.operational.snapshotElements, 0);
    assert.equal(result.desktop.operational.recentGitFiles, 2);
    assert.equal(result.desktop.operational.recentArtifacts, 1);
    assert.equal(result.desktop.operational.pipelineAbsent, true);
    assert.match(result.desktop.system.memory, /^\d+%$/);
    assert.match(result.desktop.system.disk, /^\d+%$/);
    assert.match(result.desktop.system.server, /阿里云 E2E.*在线.*75%/);
    assert.match(result.desktop.system.server, /远端 CPU 22% · 内存 31%/);
    assert.match(result.desktop.system.serverClass, /online/);
    assert.ok(result.desktop.fontSizes.title >= 25);
    assert.ok(result.desktop.fontSizes.section >= 14);
    assert.ok(result.desktop.fontSizes.review >= 12);
    assert.equal(result.desktop.replacementChars, 0);
    await capture(client, DESKTOP_SCREENSHOT);

    result.actions = await client.eval(`(async () => {
      const artifact = Array.from(document.querySelectorAll('#home-artifact-list .home-artifact-item'))
        .find(item => item.dataset.artifactPath === ${JSON.stringify(SAMPLE_ARTIFACT)});
      artifact.click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const artifactPreviewVisible = getComputedStyle(document.getElementById('preview-panel')).display !== 'none';
      const artifactPreviewFullscreen = document.getElementById('preview-layout-full').getAttribute('aria-pressed') === 'true'
        && getComputedStyle(document.getElementById('terminal-panel')).display === 'none';
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
        artifactPreviewFullscreen,
        expectedWorkspace,
        newSessionMenuVisible,
        newSessionSummary,
        copiedHasRoles: copied.includes('我：') && copied.includes('AI（Claude）：'),
        copiedHasThreeRounds: copied.includes('第 3 轮'),
      };
    })()`);
    assert.equal(result.actions.artifactPreviewVisible, true);
    assert.equal(result.actions.artifactPreviewFullscreen, true);
    assert.equal(result.actions.newSessionMenuVisible, true);
    assert.match(result.actions.newSessionSummary, /Claude Code/);
    assert.equal(result.actions.copiedHasRoles, true);
    assert.equal(result.actions.copiedHasThreeRounds, true);

    result.serverSettings = await client.eval(`(async () => {
      document.querySelector('[data-home-action="open-server-settings"]').click();
      const deadline = Date.now() + 5000;
      while (document.getElementById('config-modal').classList.contains('hidden') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const result = {
        visible: !document.getElementById('config-modal').classList.contains('hidden'),
        enabled: document.getElementById('cfg-aliyun-enabled').checked,
        label: document.getElementById('cfg-aliyun-label').value,
        healthUrl: document.getElementById('cfg-aliyun-health-url').value,
        restoreRoot: document.getElementById('cfg-operations-restore-root').value,
      };
      document.getElementById('config-close').click();
      return result;
    })()`);
    assert.equal(result.serverSettings.visible, true);
    assert.equal(result.serverSettings.enabled, true);
    assert.equal(result.serverSettings.label, '阿里云 E2E');
    assert.match(result.serverSettings.healthUrl, /\/health$/);
    assert.equal(path.resolve(result.serverSettings.restoreRoot), path.resolve(RESTORE_ROOT));

    result.review = await client.eval(`(async () => {
      window.confirm = () => true;
      document.getElementById('home-open-review').click();
      const modal = document.getElementById('operations-review-modal');
      const diffDeadline = Date.now() + 10000;
      while ((!document.querySelector('.ops-hunk') || modal.classList.contains('hidden')) && Date.now() < diffDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const initial = {
        visible: !modal.classList.contains('hidden'),
        repos: document.querySelectorAll('#ops-repo-list .ops-repo-item').length,
        files: document.querySelectorAll('#ops-file-list .ops-file-item').length,
        hunks: document.querySelectorAll('.ops-hunk').length,
      };
      document.querySelector('.ops-code-line.add:not([disabled])')?.click();
      const provenanceDeadline = Date.now() + 5000;
      while (!document.getElementById('ops-proof-panel').textContent.includes('为什么是这一行') && Date.now() < provenanceDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const provenanceText = document.getElementById('ops-proof-panel').textContent.replace(/\\s+/g, ' ').trim();
      document.querySelector('.ops-review-action.accepted')?.click();
      const decisionDeadline = Date.now() + 5000;
      while (!document.querySelector('.ops-review-action.accepted.active') && Date.now() < decisionDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const accepted = !!document.querySelector('.ops-review-action.accepted.active');
      document.getElementById('ops-create-checkpoint').click();
      const checkpointDeadline = Date.now() + 20000;
      while (!document.querySelector('.ops-checkpoint-card') && Date.now() < checkpointDeadline) {
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      const checkpoints = document.querySelectorAll('.ops-checkpoint-card').length;
      const checkpointText = document.querySelector('.ops-checkpoint-card')?.textContent.replace(/\\s+/g, ' ').trim() || '';
      document.querySelector('.ops-checkpoint-card [data-ops-action="restore-checkpoint"]')?.click();
      const restoreDeadline = Date.now() + 20000;
      while (!document.querySelector('[data-ops-action="open-restore"]') && Date.now() < restoreDeadline) {
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      const restorePath = document.querySelector('.ops-proof-card small')?.textContent || '';
      const restoreText = document.getElementById('ops-proof-panel').textContent.replace(/\\s+/g, ' ').trim();
      document.getElementById('ops-close').click();
      return { initial, provenanceText, accepted, checkpoints, checkpointText, restorePath, restoreText, closed: modal.classList.contains('hidden') };
    })()`);
    assert.deepStrictEqual(result.review.initial, { visible: true, repos: 1, files: 2, hunks: 1 });
    assert.match(result.review.provenanceText, /尚未提交|缺少因果证据/);
    assert.equal(result.review.accepted, true);
    assert.equal(result.review.checkpoints, 1);
    assert.match(result.review.checkpointText, /1 条审阅决策/);
    assert.match(result.review.restoreText, /最近恢复/);
    assert.equal(fs.existsSync(result.review.restorePath), true);
    assert.equal(result.review.closed, true);
    assert.equal(git(['diff', '--cached', '--name-only']), '', 'review and checkpoint must keep the real Git index clean');
    await client.eval(`(async () => {
      document.getElementById('home-open-review').click();
      const deadline = Date.now() + 5000;
      while (document.getElementById('operations-review-modal').classList.contains('hidden') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      document.querySelector('[data-ops-view="review"]').click();
      const diffDeadline = Date.now() + 5000;
      while (!document.querySelector('.ops-hunk') && Date.now() < diffDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })()`);
    await capture(client, REVIEW_SCREENSHOT);
    await client.eval(`document.getElementById('ops-close').click()`);

    await client.eval(`(async () => {
      await window.openPreviewPanel(${JSON.stringify(SAMPLE_ARTIFACT)});
      document.getElementById('home-open-review').click();
      const modal = document.getElementById('operations-review-modal');
      const deadline = Date.now() + 5000;
      while (modal.classList.contains('hidden') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, modifiers: 2,
    });
    await _waitMs(100);
    result.modalShortcutIsolation = await client.eval(`(() => ({
      operationsOpen: !document.getElementById('operations-review-modal').classList.contains('hidden'),
      previewVisible: getComputedStyle(document.getElementById('preview-panel')).display === 'flex',
      quickOpenVisible: getComputedStyle(document.getElementById('preview-quick-open')).display === 'flex',
    }))()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await _waitMs(100);
    result.modalEscapeIsolation = await client.eval(`(() => ({
      operationsClosed: document.getElementById('operations-review-modal').classList.contains('hidden'),
      previewStillVisible: getComputedStyle(document.getElementById('preview-panel')).display === 'flex',
      quickOpenVisible: getComputedStyle(document.getElementById('preview-quick-open')).display === 'flex',
    }))()`);
    assert.deepStrictEqual(result.modalShortcutIsolation, {
      operationsOpen: true, previewVisible: true, quickOpenVisible: false,
    });
    assert.deepStrictEqual(result.modalEscapeIsolation, {
      operationsClosed: true, previewStillVisible: true, quickOpenVisible: false,
    });
    await client.eval(`document.getElementById('preview-close').click()`);

    result.searchModalIsolation = await client.eval(`(async () => {
      await window.openPreviewPanel(${JSON.stringify(SAMPLE_ARTIFACT)});
      document.getElementById('btn-global-search').click();
      const search = document.getElementById('search-modal');
      const deadline = Date.now() + 5000;
      while (search.style.display !== 'flex' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return {
        searchOpen: search.style.display === 'flex',
        previewVisible: getComputedStyle(document.getElementById('preview-panel')).display === 'flex',
      };
    })()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 2,
    });
    await _waitMs(80);
    result.searchShortcutIsolation = await client.eval(`(() => ({
      searchStillOpen: document.getElementById('search-modal').style.display === 'flex',
      previewStillVisible: getComputedStyle(document.getElementById('preview-panel')).display === 'flex',
    }))()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
    await _waitMs(80);
    result.searchEscapeIsolation = await client.eval(`(() => ({
      searchClosed: document.getElementById('search-modal').style.display !== 'flex',
      previewStillVisible: getComputedStyle(document.getElementById('preview-panel')).display === 'flex',
    }))()`);
    assert.deepStrictEqual(result.searchModalIsolation, { searchOpen: true, previewVisible: true });
    assert.deepStrictEqual(result.searchShortcutIsolation, { searchStillOpen: true, previewStillVisible: true });
    assert.deepStrictEqual(result.searchEscapeIsolation, { searchClosed: true, previewStillVisible: true });
    await client.eval(`document.getElementById('preview-close').click()`);

    result.commandPaletteToggle = [];
    for (let index = 0; index < 3; index += 1) {
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2,
      });
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2,
      });
      await _waitMs(60);
      result.commandPaletteToggle.push(await client.eval(`getComputedStyle(document.getElementById('hub-cmdk-overlay')).display === 'flex'`));
    }
    assert.deepStrictEqual(result.commandPaletteToggle, [true, false, true]);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2,
    });

    result.navigation = await client.eval(`(async () => {
      const sidebarTarget = Array.from(document.querySelectorAll('#session-list .session-item'))
        .find(item => item.textContent.includes('Codex 提交范围确认'));
      sidebarTarget.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const sessionTitle = document.querySelector('.terminal-title');
      const sessionOpened = !!sessionTitle && sessionTitle.textContent === 'Codex 提交范围确认';
      document.getElementById('btn-home').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const homeVisibleAfterSession = document.getElementById('empty-state').isConnected
        && document.getElementById('empty-state').style.display !== 'none';
      document.getElementById('home-open-review').click();
      const reviewDeadline = Date.now() + 5000;
      while (document.getElementById('operations-review-modal').classList.contains('hidden') && Date.now() < reviewDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const reviewReopenedAfterSession = !document.getElementById('operations-review-modal').classList.contains('hidden');
      document.getElementById('ops-close').click();
      document.getElementById('btn-chuxin').click();
      await new Promise(resolve => setTimeout(resolve, 120));
      const chuxinVisible = getComputedStyle(document.getElementById('chuxin-panel')).display === 'grid';
      document.getElementById('btn-home').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        sessionOpened,
        homeVisibleAfterSession,
        reviewReopenedAfterSession,
        chuxinVisible,
        homeVisibleAfterResearch: getComputedStyle(document.getElementById('empty-state')).display !== 'none',
        chuxinHiddenAfterHome: getComputedStyle(document.getElementById('chuxin-panel')).display === 'none',
        errors: window.__homeWorkbenchErrors.slice(),
      };
    })()`);
    assert.equal(result.navigation.sessionOpened, true);
    assert.equal(result.navigation.homeVisibleAfterSession, true);
    assert.equal(result.navigation.reviewReopenedAfterSession, true);
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
      const reviewSummary = document.querySelector('.home-review-summary');
      const metrics = document.querySelector('.home-metrics').getBoundingClientRect();
      const notification = document.getElementById('completion-notification-toggle').getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
        pulseColumns: getComputedStyle(grid).gridTemplateColumns,
        reviewColumns: getComputedStyle(reviewSummary).gridTemplateColumns,
        notificationBottom: Math.round(notification.bottom),
        metricsTop: Math.round(metrics.top),
      };
    })()`);
    assert.equal(result.narrow.viewportWidth, 760);
    assert.equal(result.narrow.horizontalOverflow, false);
    assert.match(result.narrow.reviewColumns, /px .*px/);
    assert.ok(result.narrow.notificationBottom <= result.narrow.metricsTop,
      `home header controls must not overlap metrics (${result.narrow.notificationBottom} > ${result.narrow.metricsTop})`);
    await capture(client, NARROW_SCREENSHOT);

    result.desktopScreenshot = DESKTOP_SCREENSHOT;
    result.narrowScreenshot = NARROW_SCREENSHOT;
    result.reviewScreenshot = REVIEW_SCREENSHOT;
    result.mainErrorLines = hub.log().filter(line => /UnhandledPromiseRejection|uncaught|TypeError|ReferenceError|\[workbench-operations\].*failed/i.test(line));
    assert.deepStrictEqual(result.mainErrorLines, []);
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    await new Promise(resolve => metricsFixture.server.close(resolve));
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
