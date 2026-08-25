'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${process.pid}-${Date.now()}`;
const DATA_DIR = path.join(os.tmpdir(), `hub-codex-task-started-e2e-${RUN_ID}`);
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'codex-task-started-running');
const SCREENSHOT = path.join(ARTIFACT_DIR, 'codex-task-started-running.png');
const COMPACT_SCREENSHOT = path.join(ARTIFACT_DIR, 'home-empty-lanes-compact.png');
const CDP_PORT = Number(process.env.HUB_CODEX_TASK_STARTED_E2E_PORT || (18460 + (process.pid % 120)));

async function capture(client, filePath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'codex-task-started-running',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(DATA_DIR, 'fake-home'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''),
    );
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const result = await client.eval(`(async () => {
      const deadline = Date.now() + 6000;
      while ((!window.__hubE2E || !document.getElementById('empty-state').dataset.homeReady) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const id = 'goal-continuation-running';
      const now = Date.now();
      window.__hubE2E.clearSessions();
      window.__hubE2E.addFakeSession({
        id,
        kind: 'codex',
        title: 'Goal 自动续跑',
        status: 'idle',
        cwd: 'C:\\\\Vibe\\\\_scratch\\\\goal-running',
        lastMessageTime: now - 3 * 60_000,
        lastOutputPreview: '持续验证高价值实验方向',
      });

      ipcRenderer.emit('turn-started-event', {}, {
        hubSessionId: id,
        kind: 'codex',
        startedAt: now,
        turnId: 'goal-turn-1',
        signalSource: 'task_started',
      });
      await new Promise(resolve => setTimeout(resolve, 220));

      const sidebarRow = Array.from(document.querySelectorAll('#session-list .session-item'))
        .find(row => row.textContent.includes('Goal 自动续跑'));
      const sidebarHeader = Array.from(document.querySelectorAll('#session-list .session-sec-header'))
        .find(row => row.textContent.includes('运行中'));
      const session = sessions.get(id);
      const sidebar = {
        status: session && session.status,
        source: session && session.cardWorkingSource,
        hasRunDot: !!(sidebarRow && sidebarRow.querySelector('.sl-ring-dot.run')),
        section: sidebarHeader ? sidebarHeader.textContent.replace(/\\s+/g, ' ').trim() : '',
      };

      escapeToHome();
      await new Promise(resolve => setTimeout(resolve, 180));
      const home = {
        activeCount: document.getElementById('home-metric-active').textContent,
        pipelineAbsent: !document.getElementById('home-flow-columns') && !document.body.textContent.includes('Session 流水线'),
        sidebarStillRunning: !!Array.from(document.querySelectorAll('#session-list .session-item'))
          .find(row => row.textContent.includes('Goal 自动续跑') && row.querySelector('.sl-ring-dot.run')),
      };

      return { sidebar, home };
    })()`);

    assert.deepEqual(result.sidebar, {
      status: 'running',
      source: 'rollout_task_started',
      hasRunDot: true,
      section: '运行中1',
    });
    assert.equal(result.home.activeCount, '1');
    assert.equal(result.home.pipelineAbsent, true);
    assert.equal(result.home.sidebarStillRunning, true);
    await capture(client, SCREENSHOT);

    result.abort = await client.eval(`(async () => {
      const id = 'goal-continuation-running';
      ipcRenderer.emit('turn-aborted-event', {}, {
        hubSessionId: id,
        kind: 'codex',
        abortedAt: Date.now(),
        turnId: 'goal-turn-1',
        signalSource: 'turn_aborted',
      });
      await new Promise(resolve => setTimeout(resolve, 220));
      const session = sessions.get(id);
      return {
        status: session && session.status,
        source: session && (session.cardWorkingSource || null),
        attention: session && session.attentionState,
        runningSections: Array.from(document.querySelectorAll('#session-list .session-sec-header'))
          .filter(row => row.textContent.includes('运行中')).length,
      };
    })()`);
    assert.deepEqual(result.abort, {
      status: 'idle',
      source: null,
      attention: 'none',
      runningSections: 0,
    });

    result.compact = await client.eval(`(async () => {
      const now = Date.now();
      window.__hubE2E.clearSessions();
      window.__hubE2E.addFakeSessions([1, 2, 3, 4].map(index => ({
        id: 'recent-' + index,
        kind: index % 2 ? 'codex' : 'claude',
        title: '最近完成任务 ' + index,
        status: 'idle',
        lastMessageTime: now - index * 60_000,
        lastCompletedAt: now - index * 60_000,
        lastOutputPreview: '第 ' + index + ' 项结果已经可以查看',
      })));
      escapeToHome();
      await new Promise(resolve => setTimeout(resolve, 180));

      return {
        activeCount: document.getElementById('home-metric-active').textContent,
        pipelineAbsent: !document.getElementById('home-flow-columns'),
        completedSidebarRows: Array.from(document.querySelectorAll('#session-list .session-item'))
          .filter(row => row.textContent.includes('最近完成任务')).length,
      };
    })()`);
    assert.equal(result.compact.activeCount, '4');
    assert.equal(result.compact.pipelineAbsent, true);
    assert.equal(result.compact.completedSidebarRows, 4);
    await capture(client, COMPACT_SCREENSHOT);

    console.log(JSON.stringify({
      ok: true,
      pid: hub.pid,
      port: CDP_PORT,
      screenshots: [SCREENSHOT, COMPACT_SCREENSHOT],
      result,
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-80).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(DATA_DIR);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-codex-task-started-e2e-')) {
      await fs.promises.rm(resolved, { recursive: true, force: true });
    }
  }
})();
