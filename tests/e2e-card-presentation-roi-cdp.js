'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-presentation-roi-${RUN_ID}`);
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-presentation-roi');
const BASELINE = process.env.HUB_ROI_BASELINE === '1';
const RESULT_PATH = path.join(ARTIFACT_DIR, `${BASELINE ? 'baseline' : 'candidate'}-${RUN_ID}.json`);
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `${BASELINE ? 'baseline' : 'candidate'}-${RUN_ID}.png`);
const DELIVERY_ARTIFACT_PATH = path.join(TEMP_ROOT, 'artifacts', '20260903-roi-delivery-proof.html');
const DELIVERY_CHANGED_PATH = path.join(TEMP_ROOT, 'src', 'roi-feature.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { lastError = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DELIVERY_ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(DELIVERY_ARTIFACT_PATH, '<!doctype html><title>ROI proof</title>', 'utf8');
  fs.mkdirSync(path.dirname(DELIVERY_CHANGED_PATH), { recursive: true });
  fs.writeFileSync(DELIVERY_CHANGED_PATH, 'module.exports = true;\n', 'utf8');
  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, baseline: BASELINE, port };
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'data'),
      port,
      label: BASELINE ? 'card-presentation-baseline' : 'card-presentation-candidate',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'home'),
        AI_HUB_WORKSPACE_ROOT: path.join(TEMP_ROOT, 'workspaces'),
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''),
    );
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor('Hub card APIs', () => client.eval('!!(window.__hubE2E && window._mountSessionTurnCard)'));

    result.presentationPatch = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const sid = 'roi-card-session';
      window.__hubE2E.addFakeSession({
        id: sid,
        kind: 'claude',
        title: '卡片 ROI A/B',
        status: 'running',
        cwd: ${JSON.stringify(ROOT)},
        createdAt: Date.now(),
        lastMessageTime: Date.now(),
      });
      await window.__hubE2E.selectSession(sid, { forceScrollBottom: true });
      applyViewMode('card');
      // Let the normal empty-history hydration settle before the A/B mutation.
      // Otherwise that unrelated async lane can clear a valid browser selection
      // after the patch and make the renderer comparison non-deterministic.
      await wait(350);
      const overlay = document.getElementById('msg-overlay');
      overlay.replaceChildren();
      window._sessionTurns.clear();

      const firstTurn = {
        id: 'roi-assistant-turn',
        role: 'assistant',
        kind: 'claude',
        model: 'claude-opus-test',
        ts: Date.now() - 1000,
        text: '第一段可选择文字',
        thinking: '正在检查基线',
        toolCalls: [{
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'npm test' },
          result: '1 test passed',
          status: 'completed',
        }],
      };
      const first = window._mountSessionTurnCard(sid, firstTurn, { kind: 'claude' });
      first.__roiIdentity = 'preserve-me';
      const thinking = first.querySelector('.turn-thinking');
      const cluster = first.querySelector('.tc-cluster');
      const toolResult = first.querySelector('.tc-row-with-result');
      if (thinking) thinking.open = true;
      if (cluster) cluster.open = true;
      if (toolResult) toolResult.open = true;

      const body = first.querySelector('.turn-body');
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      const textNode = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(4, textNode.textContent.length));
      selection.addRange(range);
      const selectedBeforePatch = selection.toString();

      let removedRootCount = 0;
      const observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.removedNodes) {
            if (node === first) removedRootCount += 1;
          }
        }
      });
      observer.observe(overlay, { childList: true });

      window._mountSessionTurnCard(sid, {
        ...firstTurn,
        text: '第一段可选择文字\\n\\n第二段新增内容\\n\\n绝对路径：${DELIVERY_ARTIFACT_PATH.replace(/\\/g, '\\\\')}',
        thinking: '正在检查基线\\n\\n继续推进',
        stopReason: 'end_turn',
        toolCalls: [{
          ...firstTurn.toolCalls[0],
          result: '2 tests passed',
          durationMs: 850,
        }, {
          id: 'tool-edit',
          name: 'Edit',
          input: { file_path: '${DELIVERY_CHANGED_PATH.replace(/\\/g, '\\\\')}' },
          result: 'updated',
          status: 'completed',
        }],
      }, { kind: 'claude' });
      await wait(80);
      const selectedAfterPatch = window.getSelection()?.toString() || '';
      observer.disconnect();
      const second = overlay.querySelector('[data-turn-id="roi-assistant-turn"]');
      window._mountSessionTurnCard(sid, {
        id: 'roi-live-turn',
        role: 'assistant',
        kind: 'claude',
        model: 'claude-opus-test',
        ts: Date.now(),
        text: '',
        thinking: '准备构建',
        toolCalls: [],
      }, { kind: 'claude' });
      const promptAt = Date.now();
      require('electron').ipcRenderer.emit('hook-event', {}, {
        event: 'prompt', eventAt: promptAt, sessionId: sid,
        latestUserMessage: '当前真实 prompt',
      });
      require('electron').ipcRenderer.emit('hook-event', {}, {
        event: 'tool-start',
        eventAt: promptAt + 1,
        sessionId: sid,
        turnId: 'claude-turn-live',
        toolCallId: 'tool-live',
        toolName: 'Bash',
        toolInput: { command: 'npm run build' },
      });
      await wait(50);
      const runtimeDetail = document.querySelector('.terminal-header .terminal-status-detail');
      const runtimeDetailText = runtimeDetail?.textContent || '';
      require('electron').ipcRenderer.emit('hook-event', {}, {
        event: 'tool-complete', eventAt: Date.now() + 10,
        sessionId: sid, turnId: 'claude-turn-live', toolCallId: 'tool-live',
        toolName: 'Bash', toolResult: 'build completed',
      });
      require('electron').ipcRenderer.emit('hook-event', {}, {
        event: 'tool-start', eventAt: Date.now() + 20,
        sessionId: sid, turnId: 'claude-turn-live', toolCallId: 'tool-live',
        toolName: 'Bash', toolInput: { command: 'npm run build' },
      });
      const outOfOrderActivity = sessions.get(sid)?.liveToolActivities?.find(item => item.id === 'tool-live');
      require('electron').ipcRenderer.emit('hook-event', {}, {
        event: 'prompt', eventAt: promptAt - 1000, sessionId: sid,
        latestUserMessage: '过期 prompt 不得清空当前活动',
      });
      await wait(30);
      return {
        sameRoot: first === second,
        identityPreserved: second && second.__roiIdentity === 'preserve-me',
        removedRootCount,
        thinkingOpen: !!second?.querySelector('.turn-thinking')?.open,
        clusterOpen: !!second?.querySelector('.tc-cluster')?.open,
        toolResultOpen: !!second?.querySelector('.tc-row-with-result')?.open,
        selectedBeforePatch,
        selectedAfterPatch,
        selectedText: window.getSelection()?.toString() || '',
        selectionMetrics: window.__cardRenderMetrics?.lastSelection || null,
        bodyText: second?.querySelector('.turn-body')?.innerText || '',
        rootPatchCount: Number(second?.dataset.patchCount || 0),
        deliverySummaryCount: second?.querySelectorAll('.turn-delivery-summary').length || 0,
        deliveryFileCount: second?.querySelectorAll('.turn-delivery-file').length || 0,
        deliveryArtifactCount: second?.querySelectorAll('.turn-delivery-artifact').length || 0,
        deliveryCheckCount: second?.querySelectorAll('.turn-delivery-check').length || 0,
        deterministicDelivery: second?.querySelector('.turn-delivery-summary')?.dataset.summarySource || null,
        activityStatusCount: overlay.querySelectorAll('.turn-activity-status').length,
        liveActivityCount: overlay.querySelectorAll('[data-turn-id="roi-live-turn"] .turn-activity-item').length,
        liveActivityAfterStalePrompt: sessions.get(sid)?.liveToolActivities?.length || 0,
        asyncOutOfOrderStatus: outOfOrderActivity?.status || null,
        asyncOutOfOrderDetail: outOfOrderActivity?.input?.command || '',
        runtimeDetailText,
      };
    })()`);

    const shot = await client.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshot = SCREENSHOT_PATH;
    result.resultPath = RESULT_PATH;

    if (!BASELINE) {
      assert.equal(result.presentationPatch.sameRoot, true, 'streaming update must preserve the card root');
      assert.equal(result.presentationPatch.identityPreserved, true, 'card-local state must survive a patch');
      assert.equal(result.presentationPatch.removedRootCount, 0, 'streaming update must not remove the card root');
      assert.equal(result.presentationPatch.thinkingOpen, true, 'thinking disclosure state must survive');
      assert.equal(result.presentationPatch.clusterOpen, true, 'activity disclosure state must survive');
      assert.equal(result.presentationPatch.toolResultOpen, true, 'tool result disclosure state must survive');
      assert.equal(result.presentationPatch.selectedText, '第一段可', 'text selection must survive a streaming patch');
      assert.match(result.presentationPatch.bodyText, /第二段新增内容/);
      assert.ok(result.presentationPatch.rootPatchCount >= 1, 'candidate must report an in-place patch');
      assert.equal(result.presentationPatch.deliverySummaryCount, 1, 'completed turn needs one delivery summary');
      assert.equal(result.presentationPatch.deliveryFileCount, 1, 'delivery summary needs the changed file');
      assert.equal(result.presentationPatch.deliveryArtifactCount, 1, 'delivery summary needs the detected artifact');
      assert.equal(result.presentationPatch.deliveryCheckCount, 1, 'delivery summary needs the verification command');
      assert.equal(result.presentationPatch.deterministicDelivery, 'deterministic', 'delivery summary must not use another AI call');
      assert.ok(result.presentationPatch.activityStatusCount >= 3, 'tool activities need visible lifecycle status');
      assert.equal(result.presentationPatch.liveActivityCount, 1, 'live tool needs one activity row');
      assert.equal(result.presentationPatch.liveActivityAfterStalePrompt, 1, 'a rejected stale prompt must not clear live activity');
      assert.equal(result.presentationPatch.asyncOutOfOrderStatus, 'completed', 'late async start must not regress a completed tool');
      assert.equal(result.presentationPatch.asyncOutOfOrderDetail, 'npm run build', 'completion without input must retain the start command');
      assert.match(result.presentationPatch.runtimeDetailText, /npm run build/, 'status truth needs the active tool detail');
    }

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) { try { client.ws.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-card-presentation-roi-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
