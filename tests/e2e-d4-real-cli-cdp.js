'use strict';
// Isolated Electron with real Claude/Codex PTYs. One minimal prompt each.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(error => error ? reject(error) : resolve(port));
  });
});

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-d4-real-cli-'));
  const out = path.resolve('artifacts/d4-real-cli-' + Date.now());
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  const cwd = path.join(root, 'workspace');
  for (const dir of [out, claudeHome, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });

  const claudeSource = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const codexSource = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const sourceHashes = { claude: hash(claudeSource), codex: hash(codexSource) };
  const claudeCopy = path.join(claudeHome, '.credentials.json');
  const codexCopy = path.join(codexHome, 'auth.json');
  const claudeModel = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const codexModel = process.env.REAL_CODEX_MODEL || 'gpt-5.6-sol';
  const evidence = { candidate: process.env.HUB_CANDIDATE_SHA || '', root, out, claudeModel, codexModel, runs: [], passed: false };
  let hub, c;

  const until = async (expression, label, timeoutMs = 120000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await c.eval(expression)) return;
      await sleep(250);
    }
    throw new Error('timeout: ' + label);
  };
  const click = async selector => {
    const point = await c.eval(`(() => {
      const el = document.querySelector(${j(selector)});
      if (!el) throw new Error('missing ${selector}');
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (!r.width || !r.height || !el.contains(document.elementFromPoint(x, y))) throw new Error('covered ${selector}');
      return { x, y };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
  };
  const terminalText = sid => `(() => {
    const t = terminalCache.get(${j(sid)})?.terminal;
    if (!t) return '';
    const b = t.buffer.active, lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) || '');
    return lines.join('\\n');
  })()`;
  const screenshot = async name => {
    const result = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  };

  try {
    fs.copyFileSync(claudeSource, claudeCopy);
    fs.copyFileSync(codexSource, codexCopy);
    const modelCache = path.join(path.dirname(codexSource), 'models_cache.json');
    if (fs.existsSync(modelCache)) fs.copyFileSync(modelCache, path.join(codexHome, 'models_cache.json'));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = ${j(codexModel)}\nmodel_reasoning_effort = "low"\n`);
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }));
    const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
    ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.resolve(__dirname, '..', 'scripts'), logger: {} });
    hub = await launchIsolatedHub({
      dataDir: path.join(root, 'data'), port: await reservePort(), windowMode: 'hidden', label: 'D4 real CLI',
      extraEnv: {
        CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
        AI_HUB_WORKSPACE_ROOT: root, CLAUDE_HUB_AGENT_RUNTIME: 'pty', DEEPSEEK_API_KEY: '',
      },
    });
    c = await connectFirstPage(hub);
    // Keep a scaled xterm canvas while staying below Chromium's screenshot
    // texture limit on monitors whose native DPR exceeds 3.
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1672, height: 941, deviceScaleFactor: 2.25, mobile: false });
    await until('typeof sessions !== "undefined" && !!document.querySelector("#btn-home")', 'renderer ready');
    assert.equal(await c.eval('document.documentElement.dataset.theme'), 'dark');
    assert.equal(await c.eval('getComputedStyle(document.querySelector(".rail-logo img")).display'), 'block');

    for (const spec of [
      { kind: 'claude', model: claudeModel, marker: 'D4_CLAUDE_OK', ready: '/❯/' },
      { kind: 'codex', model: codexModel, marker: 'D4_CODEX_OK', ready: '/›|context left|Context/i' },
    ]) {
      const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: spec.kind, opts: {
        cwd, model: spec.model, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit',
      } })})`);
      const sid = created.id, q = j(sid);
      const record = { kind: spec.kind, model: spec.model, sessionId: sid };
      evidence.runs.push(record);
      await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, spec.kind + ' row', 30000);
      await click(`.session-item[data-session-id="${sid}"]`);
      await until('!!document.querySelector(".floating-input-box")', spec.kind + ' composer', 30000);
      await c.eval("applyViewMode('pty')");
      await until(`(${terminalText(sid)}).match(${spec.ready})`, spec.kind + ' real TUI', 120000);
      record.ready = true;
      const prompt = `请用两行回复。第一行只写 ${spec.marker}。第二行写“界面可用”。不要调用工具。`;
      await c.eval('document.querySelector(".floating-input-box").focus()');
      await c.send('Input.insertText', { text: prompt });
      await click('.floating-input-send');
      await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed'`, spec.kind + ' completed', 240000);
      await until(`(${terminalText(sid)}).includes(${j(spec.marker)})`, spec.kind + ' response in PTY', 30000);
      await sleep(700);
      record.runtimeState = await c.eval(`getSessionRuntimeTruth(sessions.get(${q})).state`);
      record.terminalMetrics = await c.eval(`(() => {
        const t = terminalCache.get(${q}).terminal;
        return { fontSize: t.options.fontSize, lineHeight: t.options.lineHeight, cols: t.cols, rows: t.rows,
          dpr: devicePixelRatio, width: t.element.getBoundingClientRect().width };
      })()`);
      assert.ok(record.terminalMetrics.fontSize >= 14 && record.terminalMetrics.width > 800);
      record.terminalTail = (await c.eval(terminalText(sid))).split('\n').filter(Boolean).slice(-22).join('\n');
      record.screenshot = await screenshot(spec.kind + '-terminal');
      assert.equal(await c.eval('!!document.querySelector(".fi-stuck")'), false);
    }
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack || String(error);
    if (c) {
      try { evidence.failureScreenshot = await screenshot('failure'); } catch {}
      try { evidence.visibleText = await c.eval('document.body.innerText.slice(-1200)'); } catch {}
    }
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(error => { evidence.quitError = error.message; });
    for (const file of [claudeCopy, codexCopy]) fs.rmSync(file, { force: true });
    evidence.credentialsUntouched = hash(claudeSource) === sourceHashes.claude && hash(codexSource) === sourceHashes.codex;
    fs.writeFileSync(path.join(out, 'result.json'), j(evidence, null, 2));
    console.log(j({ passed: evidence.passed, credentialsUntouched: evidence.credentialsUntouched, out, runs: evidence.runs.map(r => ({ kind: r.kind, model: r.model, ready: r.ready, runtimeState: r.runtimeState, terminalMetrics: r.terminalMetrics, screenshot: r.screenshot })), error: evidence.error }, null, 2));
  }
  if (!evidence.passed || !evidence.credentialsUntouched) process.exitCode = 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
