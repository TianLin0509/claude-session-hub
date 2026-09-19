'use strict';

// Real isolated Hub, controlled protocol/IPC timing. No production sessions or
// model requests. Hold dormant metadata while native initialize completes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const out = path.resolve(process.env.BOOTSTRAP_EVIDENCE_DIR || 'artifacts/native-session-bootstrap');

async function scenario(activeBeforeList) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-bootstrap-'));
  const gate = path.join(root, 'initialize-ready');
  const nativeId = randomUUID();
  const transcript = path.join(root, nativeId + '.jsonl');
  fs.writeFileSync(transcript, j({type:'user',uuid:randomUUID(),sessionId:nativeId,
    message:{role:'user',content:'isolated resume history'}}) + '\n');
  const name = activeBeforeList ? 'active-snapshot-overwrite' : 'early-ready-event';
  const evidence = { name, passed: false };
  let hub, c;
  const until = async (expression, label = expression) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await c.eval(expression) === true) return;
      await pause(50);
    }
    throw new Error('Timeout: ' + label);
  };
  const state = id => `(() => {
    const s = sessions.get(${j(id)});
    const bar = [...document.querySelectorAll('.floating-input-bar')].find(b => b.dataset.sessionId === ${j(id)});
    return { runtime: s?.nativeRuntime, active: activeSessionId === ${j(id)},
      text: bar?.querySelector('.composer-status')?.textContent,
      composerState: bar?.querySelector('.composer')?.dataset.state };
  })()`;
  try {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port; server.close(() => resolve(port));
      });
    });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, windowMode: 'hidden', extraEnv: {
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(__dirname, 'fixtures/claude-stream.js'),
      CLAUDE_HUB_FIXTURE_INIT_GATE: gate,
    } });
    c = await connectFirstPage(hub);
    await until('!!window.__hubE2E');
    const create = () => c.eval(`ipcRenderer.invoke('resume-session', ${j({
      hubId:randomUUID(),kind:'claude',ccSessionId:nativeId,transcriptPath:transcript,
      cwd:root,title:'Claude 恢复状态回归',mcpProfile:'none',
    })})`);
    let session = activeBeforeList ? null : await create();
    await c.send('Page.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const ipc = require('electron').ipcRenderer, invoke = ipc.invoke.bind(ipc);
      window.__bootEvents = [];
      ipc.on('session-updated', (_event, {session}) => __bootEvents.push({id:session.id, runtime:session.nativeRuntime}));
      ipc.invoke = async (channel, ...args) => {
        if (channel === 'get-sessions' && ${activeBeforeList}) {
          await new Promise(resolve => window.__releaseList = resolve);
        }
        const result = await invoke(channel, ...args);
        if (channel === 'get-sessions') window.__initialRows = result;
        if (channel === 'get-dormant-sessions') {
          await new Promise(resolve => window.__releaseMetadata = resolve);
        }
        return result;
      };
    })()` });
    await c.send('Page.reload');
    await until('typeof window.__releaseMetadata === "function" && typeof sessions !== "undefined"');
    if (activeBeforeList) {
      await until('typeof window.__releaseList === "function"');
      session = await create();
      await until(`sessions.has(${j(session.id)}) && activeSessionId === ${j(session.id)}`);
      await c.eval('__releaseList()');
    }
    await until('Array.isArray(window.__initialRows)');
    const initial = await c.eval(`__initialRows.find(s => s.id === ${j(session.id)})?.nativeRuntime`);
    assert.equal(initial.connection, 'connecting', 'initial list must contain the old connecting state');
    evidence.initial = initial;
    if (!activeBeforeList) assert.equal(await c.eval('sessions.size'), 0);

    fs.writeFileSync(gate, 'ready');
    await until(`__bootEvents.some(e => e.id === ${j(session.id)} && e.runtime?.connection === 'connected')`);
    if (activeBeforeList) {
      await until(`sessions.get(${j(session.id)})?.nativeRuntime?.connection === 'connected'`);
      evidence.beforeMetadata = await c.eval(state(session.id));
      assert(!/连接|载入/.test(evidence.beforeMetadata.text), 'visible composer becomes ready');
    }
    // Drain initialize's context-usage update too, so a late fresh event cannot
    // accidentally heal the stale-list bug and make this regression pass.
    await pause(800);
    await c.eval('__releaseMetadata()');
    await until(`sessions.has(${j(session.id)}) && !nativeSessionBootstrap.removed(${j(session.id)})`);
    await pause(1200); // include the existing once-per-second composer repaint
    evidence.restored = await c.eval(state(session.id));
    evidence.events = await c.eval('__bootEvents');
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
    assert.equal(evidence.restored.runtime.connection, 'connected', 'initial list must not replace ready with connecting');
    if (activeBeforeList) {
      assert.equal(evidence.restored.active, true);
      assert(evidence.restored.text && !/连接|载入/.test(evidence.restored.text), 'active composer must stay ready');
    } else {
      await c.eval(`selectSession(${j(session.id)})`);
      await until(`document.querySelector('.floating-input-bar[data-session-id="${session.id}"] .composer-status') !== null`);
      evidence.selected = await c.eval(state(session.id));
      assert(!/连接|载入/.test(evidence.selected.text), 'selection immediately uses the confirmed state');
    }
    evidence.passed = true;
    console.log('PASS ' + name);
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    if (c) await c.close();
    if (hub) {
      fs.writeFileSync(path.join(out, name + '.log'), hub.log().join('\n'));
      evidence.exit = await gracefulQuit(hub);
    }
    fs.writeFileSync(path.join(out, name + '.json'), j(evidence, null, 2));
  }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  await scenario(true);
  await scenario(false);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
