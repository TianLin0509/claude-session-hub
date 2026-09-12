'use strict';
// Real-engine check of what a user sees during a silent native Claude turn:
// which live signals reach the renderer (hook tool events, native items) and
// what the composer says while tools run. Isolated Hub, one small tool turn.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-live-progress-real-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });

async function waitFor(label, fn, timeout = 240000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(250); }
  throw new Error('Timeout: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  let hub, client;
  const workspace = path.join(TEMP, 'workspace');
  const claudeHome = path.join(TEMP, 'claude');
  for (const directory of [workspace, claudeHome]) fs.mkdirSync(directory, { recursive: true });
  const credentials = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credentials)) fs.copyFileSync(credentials, path.join(claudeHome, '.credentials.json'));
  for (let i = 1; i <= 4; i += 1) fs.writeFileSync(path.join(workspace, `part-${i}.txt`), `PART_${i}\n`, 'utf8');
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(),
      windowMode: 'hidden', label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP, DEEPSEEK_API_KEY: '' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'), 60000);
    const id = await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',effort:'low',mcpProfile:'lean',permissionMode:'bypassPermissions'}}).then(s=>s.id)`);
    const q = JSON.stringify(id);
    await client.eval(`window.__hubE2E.selectSession(${q}, {forceScrollBottom:true}); applyViewMode('card')`);
    await waitFor('connected', () => client.eval(`sessions.get(${q})?.nativeRuntime?.connection==='connected'`), 60000);
    // Count every live signal the renderer receives for this session.
    await client.eval(`(() => {
      window.__liveProbe = { hook: [], item: 0, samples: [] };
      ipcRenderer.on('hook-event', (_e, p) => { if (p.sessionId === ${q}) window.__liveProbe.hook.push(p.event); });
      ipcRenderer.on('native-agent-item', (_e, p) => { if (p.sessionId === ${q}) window.__liveProbe.item += 1; });
    })()`);
    await client.eval(`document.querySelector('.floating-input-box').focus()`);
    await client.send('Input.insertText', { text: '依次用 Read 读 part-1.txt 到 part-4.txt 四个文件，每次只读一个，读完后只回复四个标记连起来的结果。' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const samples = [];
    await waitFor('turn completed', async () => {
      const value = await client.eval(`(() => { const s=sessions.get(${q}); const bar=document.querySelector('.floating-input-bar');
        return { state: s?.nativeRuntime?.state, detail: s?.currentCardActivity?.label || '',
          composer: bar?.innerText.split('\\n').slice(0, 2).join(' | ') || '' }; })()`);
      samples.push({ at: Date.now(), ...value });
      return value.state === 'completed';
    });
    const probe = await client.eval('window.__liveProbe');
    const result = { hookEvents: probe.hook, itemEvents: probe.item,
      runningSamples: samples.filter(s => ['starting', 'running'].includes(s.state)).length,
      samplesWithDetail: samples.filter(s => s.detail).length,
      detailExamples: [...new Set(samples.map(s => s.detail).filter(Boolean))].slice(0, 6),
      composerExamples: [...new Set(samples.map(s => s.composer).filter(Boolean))].slice(0, 6) };
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ result, samples }, null, 2), 'utf8');
    console.log(JSON.stringify(result));
  } finally {
    if (client) try { await client.close(); } catch { /* already gone */ }
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
