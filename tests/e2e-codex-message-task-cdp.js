'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-message-task-'));
  const data = path.join(root, 'data'), profile = path.join(root, 'codex'), bin = path.join(root, 'bin'), work = path.join(root, 'work');
  for (const dir of [data, profile, bin, work]) fs.mkdirSync(dir);
  const gate = path.join(root, 'receipt-gate');
  const out = path.resolve('artifacts/20261002-codex-status-codex1-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), j({ providers: { codex: { backend: 'subscription', subscription_profile: 'status-test',
    subscription_profiles: [{ id: 'status-test', label: 'Status test', home: profile }] } } }));
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n"' + process.execPath + '" "' + path.join(__dirname, 'fixtures/codex-message-task-cli.js') + '" %*\r\n');
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'Path';
  const result = { mode: 'real isolated Hub and PTY with offline CLI event fixture', root, out, checks: [], passed: false };
  let hub, c;
  const until = async (expression, label, ms = 40000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await c.eval(expression); if (value) return value; await sleep(150); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    await c.eval(`(()=>{const el=document.querySelector(${j(selector)});if(!el)throw Error('missing '+${j(selector)});el.focus();el.click();})()`);
  };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
      AI_HUB_WORKSPACE_ROOT: work, HUB_CODEX_PROFILE: 'status-test', HUB_STATUS_RECEIPT_GATE: gate,
      [pathKey]: bin + path.delimiter + process.env[pathKey] } });
    c = await connectFirstPage(hub);
    console.log('[status-ui] isolated Hub ready');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__hubE2E && !!window.LaunchCenter', 'new session UI initialized');
    await click('#btn-new');
    await until('document.getElementById("new-session-menu").style.display === "flex"', 'new session modal');
    console.log('[status-ui] launcher open');
    await until('document.querySelector(".new-session-option[data-kind=codex]").getBoundingClientRect().width>0', 'visible Codex option');
    await click('.new-session-option[data-kind="codex"]');
    await click('#new-session-submit');
    const sid = await until('[...sessions.values()].find(s=>s.kind==="codex")?.id || null', 'Codex session');
    console.log('[status-ui] Codex session created');
    const row = '.session-item[data-session-id="' + sid + '"]';
    await until(`!!document.querySelector(${j(row)})`, 'sidebar row rendered');
    await click(row);
    await until(`sessions.get(${j(sid)})?.codexSid === '019effff-0159-7000-8000-000000000159'`, 'exact hook binding');
    const box = '.floating-input-bar[data-session-id="' + sid + '"] .floating-input-box';
    await until(`!!document.querySelector(${j(box)})`, 'composer');
    await click(box); await c.send('Input.insertText', { text: '验证消息出现后继续工作，收到结束凭证才完成。' });
    await click('.floating-input-bar[data-session-id="' + sid + '"] .floating-input-send');
    await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state === 'running'`, 'running');
    console.log('[status-ui] running');
    await c.eval('applyViewMode("card")');
    await until('document.querySelector("#msg-overlay")?.innerText.includes("补充手机型号")', 'intermediate card');
    await sleep(2000);
    const snapshot = () => c.eval(`(()=>{const s=sessions.get(${j(sid)});let n=document.querySelector(${j(row)});while(n&&!n.classList.contains('session-sec-header'))n=n.previousElementSibling;return {state:getSessionRuntimeTruth(s).state,unread:s.unreadCount||0,section:n?.className||'',text:document.querySelector('.floating-input-bar[data-session-id="${sid}"]')?.innerText||''};})()`);
    result.beforeRead = await snapshot(); assert.equal(result.beforeRead.state, 'running'); assert.equal(result.beforeRead.unread, 0);
    await click(row); await sleep(600);
    result.afterRead = await snapshot(); assert.equal(result.afterRead.state, 'running');
    const sidebar = await c.eval(`require('../core/session-sidebar-state').partitionSidebarSessions([...sessions.values()],{sessionMap:sessions}).states.get(${j(sid)})`);
    assert.equal(sidebar, 'run');
    const parsed = await c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)},opts:{limit:10}})`);
    assert.equal(parsed.turns.filter(t => t.role === 'assistant').at(-1).nativeOutcome, null);
    result.checks.push('界面点击已读后仍运行，侧栏归入活跃，卡片未提前完成');
    await shot('01-read-still-running');
    fs.writeFileSync(gate, 'complete');
    await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state === 'completed'`, 'task receipt completion');
    await until('document.querySelector("#msg-overlay")?.innerText.includes("完整方案已交付")', 'final card');
    result.completed = await snapshot(); result.checks.push('task_complete 到达后才进入完成并显示最终交付');
    await shot('02-task-completed'); result.passed = true;
    console.log(j({ passed: true, out, checks: result.checks }));
  } catch (error) {
    result.error = error.stack; console.error(error.stack);
    if (c) { result.diagnostics = await c.eval('({launchReady:!!window.LaunchCenter,e2eReady:!!window.__hubE2E,menu:document.getElementById("new-session-menu")?.style.display,sessions:[...sessions.values()].map(s=>({id:s.id,kind:s.kind,state:getSessionRuntimeTruth(s),transcript:s.transcriptPath}))})').catch(() => null); await shot('failure').catch(() => {}); }
    process.exitCode = 1;
  } finally {
    if (c) await c.close(); if (hub) { result.log = hub.log().slice(-35); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, '20261002-codex-status-codex1.json'), j(result), 'utf8');
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
