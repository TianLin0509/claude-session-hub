'use strict';

// Credential-backed group-chat delivery diagnostic.
// It copies only Codex auth/config into a disposable profile, launches an
// isolated Hub/CDP instance, sends several 200+ line prompts through the real
// MeetingRoom composer, and closes only the explicitly launched PID.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const REPO = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const ROOT = path.join(os.tmpdir(), `hub-real-groupchat-long-${process.pid}-${Date.now()}`);
const SOURCE_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ISOLATED_CODEX_HOME = path.join(ROOT, 'codex-home');
const WORKSPACE = path.join(ROOT, 'workspace');
const EVIDENCE_DIR = path.join(REPO, 'output', 'playwright', 'groupchat-real-long-prompt');
const SCREENSHOT = path.join(EVIDENCE_DIR, `20260831-ai-hub-groupchat-real-long-prompt-codex1-${STAMP}.png`);
const RESULT_JSON = path.join(EVIDENCE_DIR, `20260831-ai-hub-groupchat-real-long-prompt-codex1-${STAMP}.json`);

function prepareCodexHome() {
  fs.mkdirSync(ISOLATED_CODEX_HOME, { recursive: true });
  const authPath = path.join(SOURCE_CODEX_HOME, 'auth.json');
  if (!fs.existsSync(authPath)) throw new Error(`Codex auth missing: ${authPath}`);
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    const source = path.join(SOURCE_CODEX_HOME, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(ISOLATED_CODEX_HOME, name));
  }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function longPrompt(marker, trial) {
  const lines = Array.from({ length: 220 }, (_value, index) =>
    `压力行 ${String(index + 1).padStart(3, '0')} / trial ${trial}：${'长提示完整性 '.repeat(6)}${index}`);
  return [
    `请不要调用工具。完整读取下面所有行后，只回复这一行：${marker}`,
    '不要解释，不要加 Markdown。',
    ...lines,
  ].join('\n');
}

async function main() {
  let hub = null;
  let client = null;
  const trials = Math.max(1, Math.min(5, Number(process.env.HUB_REAL_GROUPCHAT_TRIALS) || 3));
  const nonce = `${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    prepareCodexHome();
    const port = await reservePort();
    hub = await launchIsolatedHub({
      dataDir: path.join(ROOT, 'hub-data'),
      port,
      label: 'real-groupchat-long-prompt',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'fake-home'),
        CODEX_HOME: ISOLATED_CODEX_HOME,
        DEEPSEEK_API_KEY: '',
        HUB_GROUPCHAT_SEND_DIAGNOSTICS: '1',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await waitFor('renderer API', () => client.eval('!!(window.MeetingRoom && window.__hubE2E && window.WorkspaceController)'));

    const meeting = await client.eval(`require('electron').ipcRenderer.invoke('create-meeting', ${JSON.stringify({
      mode: 'general',
      scene: 'general',
      title: 'Real Codex long prompt diagnostic',
      groupChat: true,
      groupMode: 'deliberation',
      groupRecentRawN: 5,
      participants: [0],
      workspace: WORKSPACE,
      workspaceLabel: 'real-groupchat-long-prompt',
      workspaceDraft: true,
      slots: [{
        index: 0,
        kind: 'codex',
        model: process.env.HUB_DIAG_CODEX_MODEL || 'gpt-5.6-sol',
        effort: 'low',
        mcpProfile: 'none',
        codexSpeedTier: 'inherit',
      }],
    })})`);
    assert.ok(meeting && meeting.id && meeting.subSessions && meeting.subSessions.length === 1);
    const sid = meeting.subSessions[0];

    await waitFor('renderer session', () => client.eval(`sessions.has(${JSON.stringify(sid)})`), 30000);
    await client.eval(`(() => {
      const meeting = ${JSON.stringify(meeting)};
      meetings[meeting.id] = meeting;
      window.__realGroupchatDiag = { acks: [], stuck: [], starts: [], completes: [] };
      const ipc = require('electron').ipcRenderer;
      ipc.on('groupchat-send-ack', (_event, payload) => {
        if (payload && payload.meetingId === meeting.id) window.__realGroupchatDiag.acks.push(payload);
      });
      ipc.on('groupchat-send-stuck', (_event, payload) => {
        if (payload && payload.meetingId === meeting.id) window.__realGroupchatDiag.stuck.push(payload);
      });
      ipc.on('turn-started-event', (_event, payload) => {
        if (payload && payload.hubSessionId === ${JSON.stringify(sid)}) window.__realGroupchatDiag.starts.push(payload);
      });
      ipc.on('groupchat-turn-complete', (_event, payload) => {
        if (payload && payload.meetingId === meeting.id) window.__realGroupchatDiag.completes.push(payload);
      });
      window.MeetingRoom.openMeeting(meeting.id, meeting, { forceScrollBottom: true });
      return true;
    })()`);

    const ready = await waitFor('Codex group member ready', () => client.eval(
      `require('electron').ipcRenderer.invoke('cli-ready-status', ${JSON.stringify(sid)})`,
    ), 60000);
    assert.equal(ready, true);

    const results = [];
    for (let trial = 1; trial <= trials; trial += 1) {
      const marker = `GROUPCHAT_LONG_PROMPT_OK_${trial}_${nonce}`;
      const prompt = longPrompt(marker, trial);
      const startedAt = Date.now();
      await client.eval(`(() => {
        const box = document.getElementById('mr-input-box');
        if (!box) throw new Error('group composer missing');
        box.textContent = ${JSON.stringify(prompt)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('mr-send-btn').click();
        return true;
      })()`);

      const settled = await waitFor(`real group turn ${trial}`, () => client.eval(`(async () => {
        const state = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${JSON.stringify(meeting.id)} });
        const message = (state.messages || []).find(item => item && item.role === 'assistant' && String(item.content || '').includes(${JSON.stringify(marker)}));
        if (!message || state.currentMode !== 'idle') return null;
        return { currentTurn: state.currentTurn, message, mode: state.currentMode };
      })()`), 180000);
      const telemetry = await client.eval(`(() => ({
        acks: window.__realGroupchatDiag.acks.filter(item => item.turnNum === ${Number(trial)}),
        stuck: window.__realGroupchatDiag.stuck.slice(),
        starts: window.__realGroupchatDiag.starts.slice(),
        completes: window.__realGroupchatDiag.completes.filter(item => item.turnNum === ${Number(trial)}),
      }))()`);
      const ack = telemetry.acks.at(-1);
      assert.ok(ack, `missing send acknowledgement for trial ${trial}`);
      const semanticStart = telemetry.starts.find(event => Number(event.startedAt) >= startedAt - 1000) || null;
      assert.ok(ack.acknowledgementSource || semanticStart,
        `missing eventual semantic start evidence: ${JSON.stringify({ ack, telemetry })}`);
      assert.ok(ack.enterAttempts >= 1 && ack.enterAttempts <= 2, JSON.stringify(ack));
      assert.ok(['ok', 'auto_recovered'].includes(ack.sendStatus), JSON.stringify(ack));
      assert.ok(['completed', 'manual_extracted'].includes(settled.message.status), JSON.stringify(settled.message));
      results.push({
        trial,
        promptLines: prompt.split(/\r?\n/).length,
        promptChars: prompt.length,
        durationMs: Date.now() - startedAt,
        sendStatus: ack.sendStatus,
        acknowledgementSource: ack.acknowledgementSource,
        eventualStartSource: semanticStart && semanticStart.signalSource || null,
        eventualStartDelayMs: semanticStart ? Number(semanticStart.startedAt) - startedAt : null,
        enterAttempts: ack.enterAttempts,
        probeDiagnostics: ack.probeDiagnostics || null,
        answerChars: settled.message.content.length,
      });
      await _waitMs(600);
    }

    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    const eventSummary = await client.eval('window.__realGroupchatDiag');
    assert.equal(eventSummary.stuck.length, 0, JSON.stringify(eventSummary.stuck));
    const payload = {
      ok: true,
      trials,
      hubPid: hub.pid,
      port,
      meetingId: meeting.id,
      sid,
      results,
      stuckEvents: eventSummary.stuck.length,
      taskStartedEvents: eventSummary.starts.length,
      completedEvents: eventSummary.completes.length,
      screenshot: SCREENSHOT,
      screenshotBytes: fs.statSync(SCREENSHOT).size,
      resultJson: RESULT_JSON,
    };
    fs.writeFileSync(RESULT_JSON, JSON.stringify(payload, null, 2), 'utf8');
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) {
      await gracefulQuit(hub).catch(() => {});
      await _waitMs(1800);
    }
    const resolved = path.resolve(ROOT);
    if (process.env.HUB_DIAG_KEEP_TEMP === '1') {
      console.error(`[diag-real-groupchat-long-prompt] kept temp root: ${resolved}`);
    } else if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-real-groupchat-long-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exitCode = 1;
});
