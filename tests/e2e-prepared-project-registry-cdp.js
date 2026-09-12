'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-formal-project-gui-'));
const data = path.join(temp, 'data'), work = path.join(temp, 'work');
const output = path.join(ROOT, 'output/playwright/prepared-project-registry');
for (const dir of [data, work, output]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(work, '.aiwork-root'), '');
function seed(leaf, name) {
  const dir = path.join(work, leaf);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents'));
  fs.writeFileSync(path.join(dir, '.agents/project.json'), JSON.stringify({ name, trunk: 'master' }));
  return dir;
}
const main = seed('main', 'AI HUB'), clone = seed('review-copy', 'AI HUB');
function register(dir) {
  return JSON.parse(cp.execFileSync(process.execPath, [path.join(ROOT, 'scripts/prepared-projects.js'), 'register', dir, '--data-dir', data], { encoding: 'utf8', windowsHide: true }));
}
register(main);
async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function wait(label, fn) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { if (await fn()) return; await _waitMs(160); }
  throw new Error('Timeout: ' + label);
}
let hub, client;
const result = { checks: [], data, main, clone };
async function click(selector) {
  await client.send('Page.bringToFront');
  const point = await client.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('missing element'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}; })()`);
  assert(point.w > 0 && point.h > 0, 'visible ' + selector);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await _waitMs(200);
}
async function shot(name) {
  const img = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(img.data, 'base64'));
}
const query = (selector, attr) => client.eval(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e=>${attr ? `e.getAttribute(${JSON.stringify(attr)})` : 'e.textContent'})`);
const norm = p => p.replace(/\\/g, '/').toLowerCase();
async function catalogs(expected, tag) {
  await client.eval('document.querySelector("#session-project-filter").blur();document.querySelector("#session-project-filter").focus()');
  await wait('sidebar loaded', () => client.eval('!document.querySelector("#session-project-filter").hasAttribute("aria-busy")'));
  const sidebar = (await query('#session-project-filter option', 'value')).filter(v => !['all', 'random'].includes(v));
  assert.deepEqual(sidebar.sort(), expected.map(norm).sort()); await shot(tag + '-sidebar');
  await click('#home-create-session');
  await wait('session library', async () => (await query('#new-session-project-library [data-project-path]', 'data-project-path')).length === expected.length);
  assert.deepEqual((await query('#new-session-project-library [data-project-path]', 'data-project-path')).sort(), [...expected].sort());
  await shot(tag + '-session');
  await click('[data-launch-intent="group"]');
  await wait('group slots', () => client.eval('!!document.querySelector("[data-mcm-scene=dev]")'));
  await click('[data-mcm-scene="dev"]');
  if (await client.eval('document.querySelector("#mcm-project-library").hidden')) await click('#mcm-project-library-button');
  await wait('group catalog', async () => (await query('#mcm-project-library [data-mcm-project-path]', 'data-mcm-project-path')).length === expected.length);
  assert.deepEqual((await query('#mcm-project-library [data-mcm-project-path]', 'data-mcm-project-path')).sort(), [...expected].sort());
  await shot(tag + '-group'); await click('#new-session-close');
  await click('#btn-global-search');
  await wait('search modal', () => client.eval('document.querySelector("#search-modal").style.display!=="none"'));
  await wait('search catalog', () => client.eval('!document.querySelector("#session-search-project").hasAttribute("aria-busy")'));
  const search = (await query('#session-search-project option', 'value')).filter(Boolean);
  assert.deepEqual(search.map(norm).sort(), expected.map(norm).sort());
  await shot(tag + '-search'); await click('#search-modal-close');
  result.checks.push(tag + ': sidebar, session, group and search all show the same formal roots');
}
async function run() {
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'formal-project-registry', windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, CLAUDE_CONFIG_DIR: path.join(temp, 'claude'), CODEX_HOME: path.join(temp, 'codex'),
    } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 1050, deviceScaleFactor: 1, mobile: false });
    await wait('ready', () => client.eval('!!window.LaunchCenter && !!window.WorkspaceController'));
    if (!process.argv.includes('--errors-only')) {
    await catalogs([main], 'initial');
    const next = seed('new-project', '新登记项目'); register(next);
    await catalogs([main, next], 'registered');
    await client.send('Page.reload'); await wait('reload ready', () => client.eval('!!window.LaunchCenter'));
    await catalogs([main, next], 'reload');
    }
    // Exercise invalid cached selection and visible read failure through the real IPC.
    await client.eval(`localStorage.setItem('hubSidebarProjectFilter',${JSON.stringify(norm(clone))})`);
    await client.send('Page.reload'); await wait('stale selection', () => client.eval('Array.from(document.querySelectorAll("#session-project-filter option")).some(e=>e.disabled && e.textContent.includes("不可用"))'));
    await shot('stale-selection');
    const file = path.join(data, 'prepared-projects.json'), backup = fs.readFileSync(file);
    await wait('sidebar idle', () => client.eval('!document.querySelector("#session-project-filter").hasAttribute("aria-busy")'));
    fs.writeFileSync(file, '{broken');
    await click('#session-project-filter');
    await client.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',windowsVirtualKeyCode:27});
    await client.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',windowsVirtualKeyCode:27});
    await client.eval('document.querySelector("#session-project-filter").blur();document.querySelector("#session-project-filter").focus()');
    result.errorDiagnostic = await client.eval(`(async()=>{let response;try{response=await require('electron').ipcRenderer.invoke('workspace:prepared-projects')}catch(e){response={error:e.message}}return {response,active:document.activeElement?.id,note:document.querySelector('#session-project-filter-note')?.outerHTML,select:document.querySelector('#session-project-filter')?.outerHTML}})()`);
    await wait('visible registry error', () => client.eval('!document.querySelector("#session-project-filter-note").hidden'));
    await shot('read-error');
    assert(!(await query('#session-project-filter option', 'value')).includes(norm(main)), 'no stale catalog on read failure');
    await click('#home-create-session');
    await wait('session read error', () => client.eval('document.querySelector("#new-session-project-library").textContent.includes("读取失败")'));
    await shot('session-read-error');
    await click('[data-launch-intent="group"]'); await click('[data-mcm-scene="dev"]');
    if (await client.eval('document.querySelector("#mcm-project-library").hidden')) await click('#mcm-project-library-button');
    await wait('group read error', () => client.eval('document.querySelector("#mcm-project-library").textContent.includes("读取失败")'));
    await shot('group-read-error'); await click('#new-session-close');
    await click('#btn-global-search');
    await wait('search read error', () => client.eval('document.querySelector("#session-search-project-note").textContent.includes("读取失败")'));
    await shot('search-read-error'); await click('#search-modal-close');
    fs.writeFileSync(file, backup);
    await client.eval('localStorage.removeItem("hubSidebarProjectFilter")');
    const prompt = await client.eval(`require('../core/dev-file-workflow').common({workspace:${JSON.stringify(work)},serialWorkflow:{workRoot:true,projectLocator:'OLD_CLONE_MARKER'}},'task')`);
    assert(!prompt.includes('OLD_CLONE_MARKER')); assert(!prompt.includes(clone)); assert(prompt.includes(main));
    result.checks.push('invalid cached selection disabled, damaged registry visibly fails closed, dispatch snapshot rereads formal registry');
    result.passed = true;
  } finally {
    if (client) { if (!result.passed) await shot('failure'); await client.close(); }
    if (hub) { fs.writeFileSync(path.join(output, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
}
run().then(() => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
