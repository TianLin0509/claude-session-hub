'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-gui-'));
  const workspace = path.join(root, '中文 workspace'); const home = path.join(root, 'codex');
  const output = path.resolve(__dirname, '../output/playwright/file-manager-actions', String(Date.now()));
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(workspace); fs.mkdirSync(home);
  fs.mkdirSync(path.join(workspace, 'docs')); fs.mkdirSync(path.join(workspace, 'output'));
  fs.writeFileSync(path.join(workspace, 'report.md'), '# 中文文件管理\n\nUTF-8 preview.');
  fs.writeFileSync(path.join(workspace, 'large.json'), JSON.stringify({ value: 'x'.repeat(3000) }));
  fs.writeFileSync(path.join(workspace, 'docs', '未展开也可找到.md'), '# nested');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\n');
  const company = path.join(root, 'company-fixture.py');
  fs.writeFileSync(company, 'import json,sys\nprint(json.dumps({"ok":True,"data":{"size":12,"public_head":{"status":200,"content_length":12},"direct_url":"https://example.test/file","inbox_url":"https://example.test/inbox","skipped":[]}}))\n');
  const result = { output, checks: [], network: 'Company Drop protocol fixture; no external file upload', success: false };
  let hub, cdp;
  async function until(expression, label) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { if (await cdp.eval(expression)) return; await pause(120); }
    throw new Error(`timeout: ${label || expression}`);
  }
  async function click(expression, mouseButton = 'left') {
    const p = await cdp.eval(`(() => {const e=${expression}; if(!e) throw Error('missing click target'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: mouseButton, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: mouseButton, clickCount: 1 });
  }
  const file = name => `Array.from(document.querySelectorAll('[data-fm-node]')).find(e=>e.querySelector('.fm-node-name').textContent===${JSON.stringify(name)})`;
  const menu = id => `document.querySelector('[data-fm-action="${id}"]')`;
  async function capture(name) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  async function selectValue(label, value) { await cdp.eval(`(()=>{const s=document.querySelector('select[aria-label="${label}"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), label: 'file-manager-actions', windowMode: 'hidden', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      COMPANY_DROP_CLIENT: company,
    } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('!!window.FileManagerPanel');
    const session = await cdp.eval(`ipcRenderer.invoke('create-session', ${JSON.stringify({ kind: 'codex', opts: { cwd: workspace, model: 'gpt-6-astra', mcpProfile: 'none' } })})`);
    await until(`!!document.querySelector('.session-item[data-session-id="${session.id}"]')`);
    await click(`document.querySelector('.session-item[data-session-id="${session.id}"]')`);
    await until('!!document.querySelector(".floating-input-box")');
    await cdp.eval(`window.FileManagerPanel.open(${JSON.stringify({ cwd: workspace, label: '中文 workspace' })})`);
    await until('document.querySelectorAll(".fm-node-name").length === 4');
    assert.ok((await cdp.eval(`[...document.querySelectorAll('.fm-file-size')].map(e=>e.textContent)`)).includes('2.9 KB'));
    assert.ok(await cdp.eval(`Array.from(document.querySelectorAll('.fm-file-time')).every(e=>e.textContent!=='—')`));
    result.checks.push('real IPC lists sizes/timestamps');
    await click(file('report.md'), 'right'); await until('!!document.querySelector(".fm-context-menu")'); await capture('01-menu-narrow');
    await click(menu('copy-path'));
    await until(`require('electron').clipboard.readText()===${JSON.stringify(path.join(workspace, 'report.md'))}`);
    result.checks.push('right-click copy absolute path');
    await click(file('report.md'), 'right'); await click(menu('conversation'));
    await until(`document.querySelector('.floating-input-box').innerText.includes(${JSON.stringify(path.join(workspace, 'report.md'))})`);
    assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(session.id)}).nativeRuntime.turnId`), null);
    result.checks.push('add file to real native composer draft without sending');
    await click(file('report.md'), 'right'); await click(menu('copy-files'));
    await until(`document.getElementById('file-manager-status').textContent==='已复制'`);
    const clipboard = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-Clipboard -Format FileDropList).FullName | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
    assert.equal(JSON.parse(clipboard.trim()), path.join(workspace, 'report.md'));
    result.checks.push('native Windows FileDropList verified');
    await click(file('docs')); await until('document.querySelectorAll(".fm-node-name").length === 5');
    fs.writeFileSync(path.join(workspace, 'fresh.md'), '# new');
    await until(`[...document.querySelectorAll('.fm-node-name')].some(e=>e.textContent==='fresh.md')`, 'auto refresh');
    assert.ok(await cdp.eval(`[...document.querySelectorAll('.fm-node-name')].some(e=>e.textContent==='未展开也可找到.md')`));
    result.checks.push('auto refresh preserves expanded directory');
    await click(file('report.md'), 'right'); await click(menu('rename')); await until('!!document.querySelector(".fm-dialog")');
    await cdp.eval(`document.querySelector('.fm-dialog input').value='renamed.md'`); await click(`document.querySelector('.fm-dialog button[type=submit]')`);
    await until(`[...document.querySelectorAll('.fm-node-name')].some(e=>e.textContent==='renamed.md')`);
    assert.ok(fs.existsSync(path.join(workspace, 'renamed.md'))); result.checks.push('rename through dialog updates disk and tree');
    await click(file('renamed.md'), 'right'); await click(menu('copy'));
    await until('!!document.querySelector(".fm-dialog input")');
    await cdp.eval(`document.querySelector('.fm-dialog input').value=${JSON.stringify(path.join(workspace, 'output'))}`);
    await click(`document.querySelector('.fm-dialog button[type=submit]')`);
    await until(`document.getElementById('file-manager-status').textContent==='操作完成'`);
    assert.ok(fs.existsSync(path.join(workspace, 'output', 'renamed.md'))); result.checks.push('copy-to dialog writes real destination file');
    await click(`${file('large.json')}.parentElement.querySelector('.fm-select')`);
    await click(file('renamed.md'), 'right'); await click(menu('copy-files'));
    await until(`document.getElementById('file-manager-status').textContent==='已复制'`);
    const multi = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-Clipboard -Format FileDropList).FullName | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
    assert.equal(JSON.parse(multi.trim()).length, 2); result.checks.push('checkbox multiselect produces two native clipboard files');
    await selectValue('浏览范围', 'recent');
    await until('document.querySelectorAll(".fm-relative").length >= 4');
    assert.equal(await cdp.eval('document.querySelector("select[aria-label=排序]").value'), 'mtime');
    result.checks.push('recent view sorts scanned files by modification time');
    await selectValue('浏览范围', 'search');
    await cdp.eval(`(()=>{const input=document.getElementById('file-manager-filter');input.value='未展开';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until('document.querySelectorAll(".fm-node-name").length === 1');
    assert.equal(await cdp.eval('document.querySelector(".fm-node-name").textContent'), '未展开也可找到.md'); result.checks.push('project search reaches nested files');
    await cdp.eval(`(()=>{const input=document.getElementById('file-manager-filter');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await selectValue('浏览范围', 'tree');
    await click(file('renamed.md'));
    await until(`document.getElementById('preview-panel').style.display==='flex'`);
    await click('document.getElementById("preview-close")');
    await click(file('renamed.md'), 'right'); await click(menu('company')); await until('!!document.querySelector(".fm-dialog")');
    await click(`document.querySelector('.fm-dialog button[type=submit]')`);
    await until('!!document.querySelector(".fm-job[data-state=completed]")'); result.checks.push('actual subprocess protocol fixture -> verified company transfer UI');
    // Resize via pointer input, not by forcing styles.
    const resize = await cdp.eval(`(()=>{const r=document.querySelector('.fm-resize-handle').getBoundingClientRect();return {x:r.x+2,y:r.y+100};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...resize, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resize.x - 300, y: resize.y, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resize.x - 300, y: resize.y, button: 'left', clickCount: 1 });
    assert.ok(await cdp.eval('document.getElementById("file-manager-panel").classList.contains("fm-wide")'));
    await capture('02-wide-transfers'); result.checks.push('pointer resize enters wide metadata layout');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await capture('03-small-window');
    assert.ok(await cdp.eval(`document.getElementById('file-manager-panel').getBoundingClientRect().right<=window.innerWidth+1`));
    result.checks.push('800px viewport keeps panel inside window'); result.success = true;
  } catch (error) { result.error = error.stack; if (cdp) await capture('failure').catch(() => {}); throw error; }
  finally {
    if (hub) fs.writeFileSync(path.join(output, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close(); if (hub) result.exit = await gracefulQuit(hub);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
