'use strict';
// Real selected-account Codex TUI, isolated auth/config/history, no model request.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, click, key, waitFor } = require('./helpers/usage-refresh-fixture');
const { resolveWindowsCodex } = require('../main/codex-windows-command');
const account = require('../core/codex-global-account');
const selected = account.resolveAccount(account.currentConfig(), {});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-real-cli-'));
const home = path.join(root, 'codex'), bin = path.join(root, 'bin'), data = path.join(root, 'data'), cwd = path.join(root, 'workspace');
for (const dir of [home, bin, data, cwd]) fs.mkdirSync(dir);
for (const file of ['auth.json', 'models_cache.json']) fs.copyFileSync(path.join(selected.home, file), path.join(home, file));
fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6.1-sol"\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n[tui.model_availability_nux]\n"gpt-6.1-sol"=4\n');
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ providers: { codex: { backend: 'subscription', subscription_profile: selected.id, subscription_profiles: [{ id: selected.id, label: 'Isolated UI test', home }] } } }));
fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n"' + resolveWindowsCodex().command + '" --no-daemon %*\r\n');
for (const name of ['NO_COLOR', 'FORCE_COLOR', 'TERM', 'COLORTERM', 'WT_SESSION', 'TERM_PROGRAM']) delete process.env[name];
const pathKey = Object.keys(process.env).find(name => name.toLowerCase() === 'path');
const output = path.resolve('artifacts/session-immersive');
fs.mkdirSync(output, { recursive: true });
let hub, c, sid;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function shot(name) { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(r.data, 'base64')); }
const state = () => c.eval(`(() => {const t=terminalCache.get(${JSON.stringify(sid)}).terminal,b=t.buffer.active,host=document.querySelector('#terminal-panel .terminal-container'),nav=host.querySelector('.prompt-nav-buttons');const n=nav?.getBoundingClientRect(),r=host.getBoundingClientRect();return {rows:t.rows,cols:t.cols,font:t.options.fontSize,lineHeight:t.options.lineHeight,text:Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n'),padding:getComputedStyle(host).paddingTop,headings:host.querySelectorAll('.pty-output-heading').length,metrics:document.querySelectorAll('#terminal-panel>.terminal-metrics').length,nav:n?{top:n.top,bottom:n.bottom,hostBottom:r.bottom}:null}})()`);
(async () => {
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await getFreePort(), label: 'session-compact-real-cli', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_E2E: '1', [pathKey]: bin + path.delimiter + process.env[pathKey],
    } });
    c = await connectFirstPage(hub);
    await waitFor(c, '!!window.LaunchCenter');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 0, mobile: false });
    const session = await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${JSON.stringify(cwd)},model:'gpt-6.1-sol',effort:'low',mcpProfile:'none'}})`);
    sid = session.id;
    await waitFor(c, `!!document.querySelector('.session-item[data-session-id="${sid}"]')`);
    await click(c, `.session-item[data-session-id="${sid}"]`);
    await waitFor(c, `terminalCache.get(${JSON.stringify(sid)})?._hydrated===true`);
    await click(c, '#btn-backstage');
    for (let i = 0; i < 180; i++) { if (/for shortcuts/i.test((await state()).text)) break; if (i === 179) throw new Error('Actual Codex TUI did not initialize'); await sleep(150); }
    const compact = await state();
    assert.match(compact.text, /for shortcuts/);
    assert.equal(compact.lineHeight, 1.04);
    assert.equal(compact.headings, 0); assert.equal(compact.metrics, 0);
    assert.ok(compact.nav && compact.nav.hostBottom - compact.nav.bottom < 20, JSON.stringify(compact.nav));
    await shot('real-cli-compact');
    // Geometry comparison only: restore the previous header/padding/line height
    // temporarily on this same TUI. This does not rewrite terminal output.
    await c.eval(`(() => {const host=document.querySelector('#terminal-panel .terminal-container');window.__compactOriginalStyle=host.getAttribute('style');const h=document.createElement('div');h.className='comparison-old-heading';h.textContent='输出记录 · 终端';h.style.cssText='position:absolute;top:0;left:0;height:40px;padding:12px 22px;font-size:12px';host.append(h);host.style.padding='56px 24px 18px';terminalCache.get(${JSON.stringify(sid)}).terminal.options.lineHeight=1.18;fitAndResizeTerminal(${JSON.stringify(sid)},terminalCache.get(${JSON.stringify(sid)}),{force:true});})()`);
    await sleep(350);
    const formerGeometry = await state();
    await shot('real-cli-former-geometry-comparison');
    assert.ok(compact.rows > formerGeometry.rows, JSON.stringify({ compact, formerGeometry }));
    await c.eval(`(() => {const host=document.querySelector('#terminal-panel .terminal-container');host.querySelector('.comparison-old-heading').remove();if(window.__compactOriginalStyle===null)host.removeAttribute('style');else host.setAttribute('style',window.__compactOriginalStyle);terminalCache.get(${JSON.stringify(sid)}).terminal.options.lineHeight=1.04;fitAndResizeTerminal(${JSON.stringify(sid)},terminalCache.get(${JSON.stringify(sid)}),{force:true});})()`);
    await sleep(300);
    await click(c, '#btn-session-immersive');
    await waitFor(c, `document.body.classList.contains('session-immersive-active')`);
    await sleep(250);
    const immersed = await state();
    assert.ok(immersed.rows >= compact.rows);
    await c.send('Input.insertText', { text: '未发送的沉浸草稿😀' });
    await sleep(200);
    assert.match((await state()).text, /未发送的沉浸草稿/);
    await shot('real-cli-immersive');
    await key(c, 'Escape', 'Escape', 27);
    await waitFor(c, `!document.body.classList.contains('session-immersive-active')`);
    assert.match((await state()).text, /未发送的沉浸草稿/);
    const result = { passed: true, selectedAccount: selected.id, rows: { formerGeometry: formerGeometry.rows, compact: compact.rows, immersed: immersed.rows }, cols: { formerGeometry: formerGeometry.cols, compact: compact.cols, immersed: immersed.cols }, nativeShortcutFooterRetained: /for shortcuts/i.test(compact.text), unsentNativeDraftRetained: true, boundary: 'Actual selected-account CLI startup; no prompt submitted. Former comparison reconstructs old display geometry on the same running TUI, not an old binary.' };
    fs.writeFileSync(path.join(output, 'real-cli-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (hub) fs.writeFileSync(path.join(output, 'real-cli-failure.log'), hub.log().join('\n'));
    if (c) await shot('real-cli-failure').catch(() => {});
    throw error;
  } finally { if (c) await c.close(); if (hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error); process.exitCode = 1; });
