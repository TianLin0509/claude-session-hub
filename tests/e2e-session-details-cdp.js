'use strict';
// Real Hub + real JSONL watching/IPC/persistence. The records are controlled
// fixtures, not a billed model run. No renderer usage events are fabricated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
delete process.env.ELECTRON_RUN_AS_NODE;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-details-'));
const data = path.join(root, 'data');
const out = path.resolve(__dirname, '../artifacts/session-details');
const runId = `${Date.now()}-${process.pid}`;
fs.mkdirSync(data); fs.mkdirSync(out, { recursive: true });
const codexPath = path.join(root, 'codex.jsonl');
const claudePath = path.join(root, 'claude.jsonl');
const codex = (total = 1280000, output = 64000) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - output, output_tokens: output, total_tokens: total, cached_input_tokens: 800000, reasoning_output_tokens: 16000 }, last_token_usage: { total_tokens: 123 } } } });
const claude = (id, output = 32000) => ({ type: 'assistant', message: { id, model: 'claude-opus-4-6', usage: { input_tokens: 40000, cache_read_input_tokens: 300000, cache_creation_input_tokens: 28000, output_tokens: output }, content: [{ type: 'text', text: '用量验证' }] } });
fs.writeFileSync(codexPath, JSON.stringify(codex()) + '\n');
fs.writeFileSync(claudePath, [claude('m1'), claude('m1'), claude('m2')].map(JSON.stringify).join('\n') + '\n');
const now = Date.now();
const session = (hubId, kind, title, transcriptPath, more = {}) => ({ hubId, kind, title, cwd: root, transcriptPath, currentModel: kind === 'codex' ? { id: 'gpt-6-astra', displayName: 'Astra' } : { id: 'claude-opus-4-6', displayName: 'Opus 4.6' }, effort: 'high', contextPct: 42, lastMessageTime: now, pinned: true, status: 'dormant', ...more });
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, sessions: [
  session('single-codex', 'codex', '修复运行状态 · Codex', codexPath),
  session('single-claude', 'claude', '文档整理 · Claude', claudePath),
  session('unknown', 'codex', '尚未取得用量', null),
  session('member-codex', 'codex', '实现位 Codex', codexPath, { meetingId: null, pinned: false }),
  session('member-claude', 'claude', '审查位 Claude', claudePath, { meetingId: 'details-group', pinned: false }),
], meetings: [{ id: 'details-group', title: '侧栏详情 · 开发群聊', groupChat: true, status: 'dormant', scene: 'dev', subSessions: ['member-codex', 'member-claude'], participants: [0, 1], pinned: true, createdAt: now, lastMessageTime: now }], immersiveByMeeting: {} }));

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function until(cdp, expression, timeout = 20000) { const start = Date.now(); while (!await cdp.eval(`(async()=>Boolean(await (${expression})))()`)) { if (Date.now() - start > timeout) throw new Error('timeout: ' + expression); await _waitMs(100); } }
async function click(cdp, selector) {
  const p = await cdp.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, ...(type === 'mouseMoved' ? {} : { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) });
}
async function shot(cdp, suffix) {
  // Hidden Electron windows may retain a stale compositor frame after hover.
  // Invalidate the surface via viewport resize before capturing real pixels.
  for (const height of [961, 960]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false });
    await _waitMs(150);
  }
  const file = path.join(out, `${runId}-${suffix}.png`);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64')); return file;
}

async function main() {
  let hub, cdp;
  const result = { root, runId, checks: [], screenshots: [], geometry: [], errors: [] };
  const start = async () => {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'session-details', windowMode: 'hidden', extraEnv: { CLAUDE_HUB_E2E: '1', CODEX_HOME: path.join(root, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js') } });
    result.pid = hub.pid;
    cdp = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url));
    cdp.ws.on('message', bytes => { const event = JSON.parse(String(bytes)); if (event.method === 'Runtime.exceptionThrown') result.errors.push(event.params.exceptionDetails); });
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until(cdp, `document.querySelector('[data-session-id="single-codex"]')`);
  };
  try {
    await start();
    assert.equal(await cdp.eval(`document.querySelectorAll('.sl-details').length`), 0);
    assert.equal(await cdp.eval(`document.querySelector('[data-session-id="member-codex"]').classList.contains('child')`), true);
    assert.equal(await cdp.eval(`document.querySelectorAll('#session-list [data-session-id="member-codex"]').length`), 1);
    assert.equal(await cdp.eval(`document.querySelector('[data-session-id="member-codex"]').getBoundingClientRect().height`), 0);
    const groupPoint = await cdp.eval(`(()=>{const r=document.querySelector('[data-meeting-id="details-group"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...groupPoint });
    await until(cdp, `document.querySelector('[data-session-id="member-codex"]').getBoundingClientRect().height > 0`);
    await _waitMs(1200);
    assert.ok(await cdp.eval(`document.querySelector('[data-session-id="member-codex"]').getBoundingClientRect().height > 0`), 'stationary hover survives sidebar refresh');
    const memberPoint = await cdp.eval(`(()=>{const r=document.querySelector('[data-session-id="member-codex"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...memberPoint });
    await _waitMs(250);
    assert.ok(await cdp.eval(`document.querySelector('[data-session-id="member-claude"]').getBoundingClientRect().height > 0`), 'moving into members keeps group expanded');
    result.screenshots.push(await shot(cdp, 'compact-hover'));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500 });
    await until(cdp, `document.querySelector('[data-session-id="member-codex"]').getBoundingClientRect().height === 0`);
    result.checks.push('compact group is one line; hover reveals members; missing meetingId repaired; no duplicate top-level row');
    result.screenshots.push(await shot(cdp, 'compact'));
    await click(cdp, '#btn-session-details');
    await until(cdp, `document.querySelector('[data-usage-id="single-codex"]')?.textContent.includes('1.28M/64k')`);
    await until(cdp, `document.querySelector('[data-usage-id="single-claude"]')?.textContent.includes('800k/64k')`);
    await until(cdp, `document.querySelector('[data-usage-id="member-codex"]')?.textContent.includes('1.28M/64k')`);
    assert.equal(await cdp.eval(`document.querySelectorAll('.child.has-details').length`), 2);
    assert.match(await cdp.eval(`document.querySelector('[data-session-id="single-codex"] .sl-detail-model').textContent`), /Astra High/);
    assert.match(await cdp.eval(`document.querySelector('[data-usage-id="unknown"]').textContent`), /—\/—/);
    result.checks.push('real transcript -> main -> IPC -> ordinary and indented member rows; unknown placeholder');
    const selectionBeforeUsage = await cdp.eval(`activeSessionId`);
    for (const id of ['single-codex', 'member-codex']) {
      await click(cdp, `[data-usage-id="${id}"]`);
      assert.equal(await cdp.eval(`!!document.querySelector('#session-usage-dialog')?.open`), false, 'usage click must not open a modal');
      assert.equal(await cdp.eval(`activeSessionId`), selectionBeforeUsage, 'usage click must not navigate');
      assert.match(await cdp.eval(`document.querySelector('[data-usage-id="${id}"]').title`), /1,280,000/);
    }
    result.checks.push('ordinary/member usage keeps hover details; physical clicks neither open a modal nor navigate');
    await click(cdp, '[data-meeting-id="details-group"] .expand-arrow');
    await until(cdp, `document.querySelectorAll('.child.has-details').length === 0`);
    await _waitMs(450);
    await click(cdp, '[data-meeting-id="details-group"] .expand-arrow');
    await until(cdp, `document.querySelectorAll('.child.has-details').length === 2`);
    result.checks.push('group collapse/expand uses real pointer navigation');
    const { session: native } = await cdp.eval(`ipcRenderer.invoke('add-meeting-sub', {meetingId:'details-group',kind:'codex', opts:{cwd:${JSON.stringify(root)},model:'gpt-6-astra',effort:'high',mcpProfile:'none'}})`);
    assert.equal(native.meetingId, 'details-group');
    await until(cdp, `sessions.get(${JSON.stringify(native.id)})?.nativeRuntime?.state === 'idle'`);
    const receipt = await cdp.eval(`ipcRenderer.invoke('session:send-prompt', {sessionId:${JSON.stringify(native.id)},text:'fixture:usage'})`);
    result.nativeReceipt = receipt;
    await until(cdp, `document.querySelector('[data-usage-id="${native.id}"]')?.textContent.includes('250k/10k')`);
    assert.equal(await cdp.eval(`document.querySelectorAll('#session-list [data-session-id="${native.id}"]').length`), 1);
    assert.equal(await cdp.eval(`document.querySelector('[data-session-id="${native.id}"]').classList.contains('child')`), true);
    result.checks.push('new native Codex retains meetingId; actual app-server fixture event reaches sidebar total independently of context');
    for (const width of [280, 340, 380, 440]) {
      await cdp.eval(`document.documentElement.style.setProperty('--sidebar-width','${width}px'); document.querySelector('.session-sidebar').style.width='${width}px';document.querySelector('.session-sidebar').style.flex='0 0 ${width}px'`);
      await _waitMs(150);
      const geometry = await cdp.eval(`(() => {const rows=[...document.querySelectorAll('.sl-details')];return rows.map(el=>{const r=el.getBoundingClientRect();const first=el.previousElementSibling.getBoundingClientRect();const title=el.previousElementSibling.querySelector('.sl-title').getBoundingClientRect();const cells=[...el.children].map(c=>{const a=c.getBoundingClientRect();return {x:a.x,right:a.right,width:a.width,text:c.textContent}});return {text:el.textContent,client:el.clientWidth,scroll:el.scrollWidth,right:r.right,top:r.top,firstBottom:first.bottom,titleWidth:title.width,cells};});})()`);
      assert.ok(geometry.every(row => row.top >= row.firstBottom && row.titleWidth > 40), `first row overlaps details at ${width}`);
      assert.ok(geometry.every(row => row.scroll <= row.client + 1), `second line overflow at ${width}`);
      assert.ok(geometry.every(row => row.cells.every((cell, i) => i === 0 || cell.x >= row.cells[i - 1].right - 1)), `overlap at ${width}`);
      result.geometry.push({ width, rows: geometry });
      if (width === 340) result.screenshots.push(await shot(cdp, 'details-340'));
    }
    await click(cdp, '#btn-session-details');
    const compactPoint = await cdp.eval(`(()=>{const r=document.querySelector('[data-meeting-id="details-group"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...compactPoint });
    await until(cdp, `document.querySelector('[data-session-id="${native.id}"]').getBoundingClientRect().height > 0`);
    await click(cdp, '[data-session-id="' + native.id + '"] .sl-title');
    await until(cdp, `activeSessionId === ${JSON.stringify(native.id)}`);
    assert.equal(await cdp.eval(`document.querySelectorAll('#session-list [data-session-id="${native.id}"]').length`), 1);
    result.checks.push('physical click on hovered native group member opens that session without a duplicate ordinary row');
    await click(cdp, '#btn-session-details');
    fs.appendFileSync(codexPath, JSON.stringify(codex(1500000, 80000)) + '\n');
    fs.appendFileSync(claudePath, JSON.stringify(claude('m2')) + '\n');
    await until(cdp, `document.querySelector('[data-usage-id="member-codex"]')?.textContent.includes('1.5M/80k')`);
    assert.match(await cdp.eval(`document.querySelector('[data-usage-id="single-claude"]').textContent`), /800k\/64k/);
    await until(cdp, `(async()=>{const s=await ipcRenderer.invoke('get-dormant-sessions');return s.sessions.find(x=>x.hubId==='single-codex')?.sessionUsage?.total===1500000})()`);
    await _waitMs(800);
    result.checks.push('live append updates both Codex rows; Claude duplicate unchanged; main persistence contains latest total');
    await cdp.close(); cdp = null; await gracefulQuit(hub); hub = null;
    await start();
    await until(cdp, `document.querySelector('[data-usage-id="single-codex"]')?.textContent.includes('1.5M/80k')`);
    assert.equal(await cdp.eval(`document.getElementById('btn-session-details').getAttribute('aria-pressed')`), 'true');
    result.checks.push('full Hub restart preserves detail preference and cumulative consumption');
    result.screenshots.push(await shot(cdp, 'restarted'));
    assert.deepEqual(result.errors, []);
    result.ok = true;
  } catch (error) { result.error = error.stack; if(cdp) result.screenshots.push(await shot(cdp, 'failure').catch(()=>'')); throw error; }
  finally {
    if(cdp) await cdp.close(); if(hub) await gracefulQuit(hub);
    const file = path.join(out, `${runId}-evidence.json`); fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8'); console.log(file);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
