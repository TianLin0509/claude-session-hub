'use strict';
// Two actual isolated Hub windows, production relay source bound to localhost,
// synthetic images only. Agent sessions are fixtures: no model or company calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { generatedPng } = require('./helpers/bridge-image-fixture');
const { HomeBridge } = require('../core/company-bridge/home');
const { CompanyBridge } = require('../core/company-bridge/company');
const delay = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const json = value => JSON.stringify(value, null, 2);

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-image-text-'));
  const out = path.resolve('artifacts/20261017-image-text-codex1-evidence', 'e2e-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const source = process.env.HUB_E2E_RELAY || 'C:/Users/lintian/company-drop/server/relay_server.py';
  const python = process.env.HUB_E2E_PYTHON || 'python';
  if (!fs.existsSync(source)) throw new Error('Set HUB_E2E_RELAY to relay_server.py to verify the real relay contract');
  const network = [], hubs = [], report = { passed: false, root, out, scope: '真实 Hub + 真实本机中转服务 + Chromium 编解码；问答线程为夹具，不调用 AI 或公司通道', relaySourceSha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
  let relay, proxy;
  try {
    const port = await freePort();
    relay = spawn(python, ['-X', 'utf8', source, '--host', '127.0.0.1', '--port', String(port), '--root', path.join(root, 'relay')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let relayLog = ''; relay.stdout.on('data', d => { relayLog += d; }); relay.stderr.on('data', d => { relayLog += d; });
    for (let n = 0; ; n++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/bridge/${'a'.repeat(32)}/msg?to=home&after=0`); if (r.ok) break; } catch {}
      if (n >= 60) throw Error('relay startup failed: ' + relayLog); await delay(200);
    }
    proxy = http.createServer((req, res) => {
      const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (!req.url.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
        let entry;
        if (body.length) { const p = JSON.parse(body); if (p.blob?.startsWith('IMG1=')) { entry = { to: p.to, mid: p.mid, bytes: body.length, ascii: body.every(x => x < 128), method: req.method, contentType: req.headers['content-type'] }; network.push(entry); } }
        const upstream = http.request({ host: '127.0.0.1', port, path: req.url.slice(4), method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', 'content-length': body.length } }, r => { if (entry) entry.httpStatus = r.statusCode; res.writeHead(r.statusCode, r.headers); r.pipe(res); });
        upstream.on('error', e => { res.writeHead(502); res.end(e.message); }); upstream.end(body);
      });
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${proxy.address().port}/api`;
    const hdata = path.join(root, 'home'), cdata = path.join(root, 'company');
    const deps = { noTimer: true, fetchImpl: fetch, getSession: () => null, getSessionMetadata: () => null, isAgentTurnActive: () => false };
    const home = new HomeBridge({ ...deps, dataDir: hdata, bridgeApiUrl: () => api });
    const company = new CompanyBridge({ ...deps, dataDir: cdata });
    try {
      const { code } = home.createPairing(); await company.pair(code);
      for (let n = 0; n < 3; n++) { await home.checkNow(); await company.checkNow(); }
      if (!home.link.paired() || !company.link.paired()) throw Error('real local relay pairing failed');
      company.store.set('featureUnlock', { at: Date.now(), via: 'isolated-fixture' });
      company.store.set('settings', { enabled: false });
      const base = { gen: home.link.gen(), title: '本机合成图验证', createdAt: Date.now(), rounds: [{ round: 1, question: '仅本机合成图片测试', reply: '初始化测试线程', delivered: true, status: 'replied' }] };
      home.saveThread({ ...base, id: 'Q-1017-01', sessionId: 'fixture-home' });
      company.saveThread({ ...base, id: 'Q-1017-01', sessionId: 'fixture-company' });
      company.askHome.saveThread({ ...base, id: 'H-1017-01', sessionId: 'fixture-company' });
      home.consult.saveThread({ ...base, id: 'H-1017-01', sessionId: 'fixture-home' });
    } finally { home.close(); company.close(); }
    const sample = path.join(out, 'synthetic-noise-100.png'); fs.writeFileSync(sample, generatedPng());
    const dense = path.join(out, 'synthetic-noise-1600.png'); fs.writeFileSync(dense, generatedPng(1600, 1000));
    const common = { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_BRIDGE_TIMER: '0', CLAUDE_HUB_WIRELESS_TIMER: '0', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), CODEX_SQLITE_HOME: '' };
    for (const [role, dataDir] of [['home', hdata], ['company', cdata]]) {
      const hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'image-' + role, windowMode: 'background', extraEnv: { ...common,
        CLAUDE_HUB_BRIDGE_ROLE: role, CLAUDE_HUB_BRIDGE_API_URL: api, CODEX_HOME: path.join(dataDir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude') } });
      hubs.push(hub); console.log(role + ' isolated Hub PID=' + hub.pid);
    }
    const args = { home: hubs[0].cdpHttpBase, company: hubs[1].cdpHttpBase, out, sample, dense };
    const config = path.join(root, 'ui-arguments.json'); fs.writeFileSync(config, json(args));
    const ui = spawn(python, ['-X', 'utf8', path.join(__dirname, 'helpers/bridge-images-ui.py'), config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let uiLog = ''; for (const stream of [ui.stdout, ui.stderr]) stream.on('data', d => { uiLog += d; process.stdout.write(d); });
    const exit = await new Promise((resolve, reject) => { ui.once('error', reject); ui.once('exit', resolve); });
    fs.writeFileSync(path.join(out, 'ui.log'), uiLog);
    if (exit !== 0) throw Error('UI scenario failed: ' + exit);
    if (network.length < 4 || network.some(x => x.bytes >= 60000 || !x.ascii || x.httpStatus !== 200)) throw Error('wire format validation failed');
    report.ui = JSON.parse(fs.readFileSync(path.join(out, 'ui-results.json'), 'utf8')); report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
  finally {
    for (const hub of hubs) { fs.writeFileSync(path.join(out, hub.label + '.log'), hub.log().join('\n')); try { await gracefulQuit(hub); } catch (error) { report.shutdownError = error.message; report.passed = false; process.exitCode = 1; } }
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    relay?.kill();
    report.network = network; fs.writeFileSync(path.join(out, 'results.json'), json(report)); console.log('EVIDENCE ' + out + ' passed=' + report.passed);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
