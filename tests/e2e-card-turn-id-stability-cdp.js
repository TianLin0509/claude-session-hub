'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-stable-id-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const CLAUDE_PATH = path.join(TEMP_ROOT, 'claude-transcript.jsonl');
const CODEX_PATH = path.join(TEMP_ROOT, 'codex-rollout.jsonl');
const KIMI_PATH = path.join(TEMP_ROOT, 'kimi-wire.jsonl');
const OLD_KIMI_PATH = path.join(TEMP_ROOT, 'kimi-wire-old.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-turn-id-stability');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `card-turn-id-stability-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function jsonl(value) {
  return JSON.stringify(value) + '\n';
}

function writeFixtures() {
  fs.writeFileSync(CLAUDE_PATH, [
    jsonl({ type: 'ignored-padding', payload: 'c'.repeat(9 * 1024 * 1024) }),
    jsonl({ type: 'user', uuid: 'claude-user-stable', timestamp: '2026-07-31T06:00:00.000Z', message: { content: 'Claude resume 稳定性问题' } }),
    jsonl({ type: 'assistant', uuid: 'claude-assistant-stable', timestamp: '2026-07-31T06:00:01.000Z', message: {
      model: 'claude-opus-4-7', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude resume 最终答案' }],
    } }),
  ].join(''), 'utf8');

  const codexTurnId = '019fb6d2-f9fc-7241-aeaa-4018501e1d76';
  fs.writeFileSync(CODEX_PATH, [
    jsonl({ type: 'session_meta', payload: { id: 'codex-e2e-sid', cwd: TEMP_ROOT } }),
    jsonl({ type: 'ignored-padding', payload: 'x'.repeat(9 * 1024 * 1024) }),
    jsonl({ timestamp: '2026-07-31T06:18:27.714Z', type: 'event_msg', payload: { type: 'task_started', turn_id: codexTurnId } }),
    jsonl({ timestamp: '2026-07-31T06:18:28.201Z', type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 稳定 ID 问题' }],
      internal_chat_message_metadata_passthrough: { turn_id: codexTurnId },
    } }),
    jsonl({ timestamp: '2026-07-31T06:18:28.201Z', type: 'event_msg', payload: { type: 'user_message', message: 'Codex 稳定 ID 问题' } }),
    jsonl({ timestamp: '2026-07-31T06:18:37.684Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Codex 正在处理', phase: 'commentary' } }),
  ].join(''), 'utf8');

  fs.writeFileSync(KIMI_PATH, [
    jsonl({ type: 'ignored-padding', payload: 'k'.repeat(9 * 1024 * 1024) }),
    jsonl({ type: 'turn.prompt', input: [{ type: 'text', text: 'Kimi 稳定 ID 问题' }], origin: { kind: 'user' }, time: 1785431086567 }),
    jsonl({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-a', turnId: '17', step: 1 }, time: 1785431086579 }),
    jsonl({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-a', turnId: '17', step: 1, stepUuid: 'step-a', part: { type: 'text', text: 'Kimi 最终答案' } }, time: 1785431086580 }),
    jsonl({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-a', turnId: '17', step: 1, finishReason: 'stop' }, time: 1785431086581 }),
  ].join(''), 'utf8');
  fs.writeFileSync(OLD_KIMI_PATH, [
    jsonl({ type: 'turn.prompt', input: [{ type: 'text', text: '旧绑定问题' }], origin: { kind: 'user' }, time: 1785000000000 }),
    jsonl({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'old-step', turnId: '1', step: 1 }, time: 1785000000001 }),
    jsonl({ type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'old-step', turnId: '1', part: { type: 'text', text: '错误的旧 transcript' } }, time: 1785000000002 }),
    jsonl({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'old-step', turnId: '1', step: 1, finishReason: 'stop' }, time: 1785000000003 }),
  ].join(''), 'utf8');
}

function appendClaudeGrowth() {
  fs.appendFileSync(CLAUDE_PATH, jsonl({ type: 'ignored-growth', payload: 'r'.repeat(512 * 1024) }), 'utf8');
}

function appendCodexCompletion() {
  const turnId = '019fb6d2-f9fc-7241-aeaa-4018501e1d76';
  fs.appendFileSync(CODEX_PATH, [
    jsonl({ type: 'ignored-growth', payload: 'y'.repeat(512 * 1024) }),
    jsonl({ timestamp: '2026-07-31T06:23:53.251Z', type: 'event_msg', payload: {
      type: 'task_complete', turn_id: turnId, last_agent_message: 'Codex 最终答案', duration_ms: 325537,
    } }),
  ].join(''), 'utf8');
}

function appendKimiGrowth() {
  fs.appendFileSync(KIMI_PATH, jsonl({ type: 'ignored-growth', payload: 'q'.repeat(512 * 1024) }), 'utf8');
}

function freePort(preferred) {
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
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function inspectCards(client, sid, kind, transcriptPath) {
  return client.eval(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sid = ${JSON.stringify(sid)};
    const api = window.__hubE2E;
    api.addFakeSession({
      id: sid,
      kind: ${JSON.stringify(kind)},
      title: ${JSON.stringify(kind + ' ID 稳定性')},
      status: 'idle',
      cwd: ${JSON.stringify(TEMP_ROOT)},
      transcriptPath: ${JSON.stringify(transcriptPath)},
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
    });
    applyViewMode('card');
    await api.selectSession(sid, { forceScrollBottom: true });
    const overlay = document.getElementById('msg-overlay');
    for (let attempt = 0; attempt < 60 && overlay.querySelectorAll(':scope > .turn-card').length < 2; attempt += 1) {
      await wait(100);
    }
    const snapshot = () => [...overlay.querySelectorAll(':scope > .turn-card')].map(card => ({
      id: card.dataset.turnId,
      role: card.classList.contains('user') ? 'user' : 'assistant',
      text: (card.querySelector('.turn-body')?.innerText || '').trim(),
    }));
    return { before: snapshot() };
  })()`);
}

async function reloadAndInspect(client, sid, parseOpts) {
  return client.eval(`(async () => {
    await window._loadSessionHistoryToOverlay(${JSON.stringify(sid)}, {
      incremental: true,
      parseOpts: ${JSON.stringify(parseOpts)},
    });
    const overlay = document.getElementById('msg-overlay');
    return [...overlay.querySelectorAll(':scope > .turn-card')].map(card => ({
      id: card.dataset.turnId,
      role: card.classList.contains('user') ? 'user' : 'assistant',
      text: (card.querySelector('.turn-body')?.innerText || '').trim(),
    }));
  })()`);
}

async function simulateDormantResumeRebind(client) {
  return client.eval(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sid = 'resume-rebind-kimi';
    window.__hubE2E.addFakeSession({
      id: sid,
      kind: 'kimi-resume',
      title: 'Kimi stale binding',
      status: 'dormant',
      cwd: ${JSON.stringify(TEMP_ROOT)},
      transcriptPath: ${JSON.stringify(OLD_KIMI_PATH)},
      kimiSid: 'session-rebind',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
    });
    applyViewMode('card');
    require('electron').ipcRenderer.emit('session-created', {}, { session: {
      id: sid,
      kind: 'kimi-resume',
      title: 'Kimi corrected binding',
      status: 'idle',
      cwd: ${JSON.stringify(TEMP_ROOT)},
      transcriptPath: ${JSON.stringify(KIMI_PATH)},
      kimiSid: 'session-rebind',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
    } });
    for (let attempt = 0; attempt < 60 && document.querySelectorAll('#msg-overlay > .turn-card').length < 2; attempt += 1) {
      await wait(100);
    }
    return [...document.querySelectorAll('#msg-overlay > .turn-card')].map(card => ({
      id: card.dataset.turnId,
      text: (card.querySelector('.turn-body')?.innerText || '').trim(),
    }));
  })()`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFixtures();
  const port = await freePort(Number(process.env.HUB_CARD_STABLE_ID_E2E_PORT || 19720));
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'card-turn-id-stability',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await waitForEval(client, 'window.__hubE2E && window._loadSessionHistoryToOverlay', 'Hub E2E card APIs');

    result.claudeResume = await inspectCards(client, 'stable-claude-resume', 'claude-resume', CLAUDE_PATH);
    assert.equal(result.claudeResume.before.length, 2, JSON.stringify(result.claudeResume.before));
    appendClaudeGrowth();
    result.claudeResume.afterTailGrowth = await reloadAndInspect(client, 'stable-claude-resume', { limit: 2, fromTail: true });
    result.claudeResume.afterFullRead = await reloadAndInspect(client, 'stable-claude-resume', { limit: 50, fromTail: false });
    assert.deepEqual(result.claudeResume.afterTailGrowth, result.claudeResume.before);
    assert.deepEqual(result.claudeResume.afterFullRead, result.claudeResume.before);

    result.codex = await inspectCards(client, 'stable-codex', 'codex-resume', CODEX_PATH);
    assert.equal(result.codex.before.length, 2, JSON.stringify(result.codex.before));
    appendCodexCompletion();
    result.codex.afterTailGrowth = await reloadAndInspect(client, 'stable-codex', { limit: 2, fromTail: true });
    result.codex.afterFullRead = await reloadAndInspect(client, 'stable-codex', { limit: 50, fromTail: false });
    assert.equal(result.codex.afterTailGrowth.length, 2, JSON.stringify(result.codex));
    assert.deepEqual(result.codex.afterTailGrowth.map(card => card.id), result.codex.before.map(card => card.id));
    assert.deepEqual(result.codex.afterFullRead.map(card => card.id), result.codex.before.map(card => card.id));
    assert.match(result.codex.afterTailGrowth[1].text, /Codex 最终答案/);

    result.kimi = await inspectCards(client, 'stable-kimi', 'kimi-resume', KIMI_PATH);
    assert.equal(result.kimi.before.length, 2, JSON.stringify(result.kimi.before));
    appendKimiGrowth();
    result.kimi.afterTailGrowth = await reloadAndInspect(client, 'stable-kimi', { limit: 2, fromTail: true });
    result.kimi.afterFullRead = await reloadAndInspect(client, 'stable-kimi', { limit: 50, fromTail: false });
    assert.equal(result.kimi.afterTailGrowth.length, 2, JSON.stringify(result.kimi));
    assert.deepEqual(result.kimi.afterTailGrowth.map(card => card.id), result.kimi.before.map(card => card.id));
    assert.deepEqual(result.kimi.afterFullRead.map(card => card.id), result.kimi.before.map(card => card.id));

    result.resumeRebind = await simulateDormantResumeRebind(client);
    assert.equal(result.resumeRebind.length, 2, JSON.stringify(result.resumeRebind));
    assert.match(result.resumeRebind[1].text, /Kimi 最终答案/);
    assert.doesNotMatch(result.resumeRebind[1].text, /错误的旧 transcript/);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshot = SCREENSHOT_PATH;
    result.status = 'passed';
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) { try { await client.close(); } catch {} }
    if (hub) await gracefulQuit(hub, 5000);
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
