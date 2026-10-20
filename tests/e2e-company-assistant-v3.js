'use strict';
// Real isolated Electron UI + old signed secretary exe/new signed code + headless mock webpage.
// WeLink transport and PPT contents are fixtures. No real company booking or messages.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const original = process.env.MSZ_SOURCE || 'D:\\AIWork\\20261013-秘书终结者v2';
const python = path.join(original, '.venv', 'Scripts', 'python.exe');
const out = path.resolve(__dirname, '..', 'output');
const variant = process.env.HUB_V3_EXE ? '-packaged' : process.env.HUB_V3_ENTRY ? '-export' : '';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-v3-e2e-')), dataDir = path.join(root, 'data'), dir = path.join(dataDir, 'company-assistant'), room = path.join(root, 'mishu');
  for (const d of [out, dir, room]) fs.mkdirSync(d, { recursive: true });
  const result = { root, checks: [], shots: [], started: Date.now() }, errors = [];
  const state = path.join(root, 'welink-state'), log = path.join(root, 'welink.log');
  fs.writeFileSync(state, 'ok'); fs.writeFileSync(path.join(root, 'welink-exchange'), 'user001@example.com');
  const exe = path.join(room, 'MishuTerminator-2.1.0.exe');
  fs.copyFileSync(path.join(original, 'release', 'v2.1.0', 'MishuTerminator-2.1.0.exe'), exe);
  const build = spawnSync(python, [path.join(__dirname, 'fixtures', 'company-ppt-index.py'), path.join(root, 'ppt'), 'C:\\Users\\lintian\\pptx-finder'], { encoding: 'utf8', windowsHide: true });
  assert.equal(build.status, 0, build.stderr);
  const db = path.join(root, 'ppt', 'index.db'), dbHash = () => require('crypto').createHash('sha256').update(fs.readFileSync(db)).digest('hex'), beforeHash = dbHash();
  fs.writeFileSync(path.join(dir, 'settings.json'), j({ ppt: { db, python }, rooms: { exePath: exe, home: room, enabled: false } }));
  const day = new Date().toLocaleDateString('sv-SE'), now = Date.now();
  fs.writeFileSync(path.join(dir, `brief-${day}.json`), j({ day, by: 'rules', generatedAt: now, total: 1, sections: [{ key: 'meetings', title: '今天的会', items: [{ text: '14:00 算法讨论 · 准备 SRS 素材', source: 'fixture' }] }] }));
  fs.writeFileSync(path.join(dir, 'chat.json'), j([{ id: 'visual-fixture', q: '帮我找一下 SRS 信道估计的材料。', a: '可以从已有 PPT 素材库检索，再读完整页面，附上文件路径和页码。', state: 'done', askedAt: now, answeredAt: now }]));
  let hub, c, mock, secretaryPid;
  const until = async (fn, label, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(300); } throw Error('timeout: ' + label); };
  const ui = async (expr, label, timeout) => until(() => c.eval(expr), label, timeout);
  const shot = async name => { const file = path.join(out, `20261020-company-v3${variant}-${name}-codex2.png`); const p = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(p.data, 'base64')); result.shots.push(file); };
  const click = sel => c.eval(`document.querySelector(${j(sel)}).click()`);
  const value = (sel, value) => c.eval(`document.querySelector(${j(sel)}).value=${j(value)}`);
  try {
    mock = spawn(python, [path.join(__dirname, 'fixtures', 'company-room-mock.py'), room, original], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    mock.stderr.on('data', b => errors.push(b.toString()));
    await until(() => fs.existsSync(path.join(room, 'mock-ready.json')), 'mock site ready');
    const entry = process.env.HUB_V3_ENTRY;
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'company-v3',
      ...(entry ? { entryPath: entry, cwd: process.env.HUB_V3_EXE ? path.dirname(process.env.HUB_V3_EXE) : entry } : {}),
      ...(process.env.HUB_V3_EXE ? { executablePath: process.env.HUB_V3_EXE } : {}),
      extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures', 'welink-cli-standin.js'), WELINK_STANDIN_STATE: state, WELINK_STANDIN_LOG: log,
      QT_QPA_PLATFORM: 'offscreen', MSZ_HUB_TEST_INSTANCE: 'hub-v3-' + process.pid, MSZ_E2E_REPORT: path.join(room, 'runtime.json'),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await ui('!!document.getElementById("btn-company-assistant")', 'assistant button');
    await click('#btn-company-assistant');
    await ui('!!document.querySelector(".ca-message-row.user .ca-avatar")', 'user avatar');
    await ui('!!document.querySelector(".ca-message-row.assistant .ca-avatar")', 'assistant avatar');
    await ui('/自动维护|自动续期/.test(document.querySelector(".ca-status")?.innerText || "")', 'logged in');
    assert.equal(await c.eval('document.querySelector(".ca-sidebar").getBoundingClientRect().width'), 272);
    await shot('01-conversation-1440');
    await click('[data-ca="settings-tab:phone"]');
    await ui('!!document.querySelector("input[data-f=phone-group]")', 'manual group input');
    await value('[data-f="phone-group"]', 'g-phone'); await click('[data-x="phone-connect"]');
    await ui('/已接通/.test(document.querySelector("[data-slot=phone-live]")?.innerText || "")', 'welcome confirms connection');
    await shot('02-phone');
    result.checks.push('manual group ID -> welcome -> connected');
    await click('[data-ca="settings-tab:rooms"]');
    await ui('!!document.querySelector("[data-room-op=connect]")', 'room connect');
    await click('[data-room-op="connect"]');
    await ui('!!document.querySelector("[data-room=rooms]") && !document.querySelector("[data-room-op=start]").disabled', 'secretary connected', 60000);
    const live = JSON.parse(fs.readFileSync(path.join(room, 'hub-control', 'status.json')));
    secretaryPid = live.pid; assert.equal(live.version, '2.1.1');
    await value('[data-room="主题"]', 'Hub 控制链验收'); await value('[data-room="rooms"]', '练秋湖F12-3-13R');
    await value('[data-room="开始时间"]', '14:00'); await value('[data-room="duration"]', '2');
    await c.eval('document.querySelectorAll("[data-room-day]").forEach(x=>x.checked=true)');
    await click('[data-room-op="start"]');
    await ui('/正在守护/.test(document.querySelector(".ca-tab-body")?.innerText || "")', 'daemon started', 30000);
    await shot('03-rooms');
    await until(() => fs.existsSync(path.join(room, 'runtime.json')), 'old exe new code runtime');
    const runtime = JSON.parse(fs.readFileSync(path.join(room, 'runtime.json')));
    assert.equal(runtime.exe_version, '2.1.0'); assert.equal(runtime.version, '2.1.1');
    await click('[data-ca="settings-tab:ppt"]');
    await ui('!!document.querySelector("[data-f=ppt-query]") && !document.querySelector("[data-x=ppt-search] button").disabled', 'PPT library ready');
    await value('[data-f="ppt-query"]', 'SRS 信道估计');
    await c.eval('document.querySelector("[data-x=ppt-search]").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
    await ui('!!document.querySelector("[data-ppt-read]")', 'search result');
    await click('[data-ppt-read]');
    await ui('/通过导频观测/.test(document.querySelector(".ca-ppt-result")?.innerText || "")', 'read complete text');
    await shot('04-ppt');
    assert.equal(dbHash(), beforeHash); result.checks.push('actual Doctor-built synthetic index search/read; DB hash unchanged');
    const mockState = JSON.parse(fs.readFileSync(path.join(room, 'mock-ready.json')));
    let booked;
    await until(async () => { booked = await (await fetch(`http://127.0.0.1:${mockState.port}/__state`)).json(); return booked.length; }, 'real engine submits mock booking', 150000);
    assert.equal(booked.length, 1); assert.equal(booked[0].start, '14:00'); assert.equal(Number(booked[0].h), 2); assert.equal(Number(booked[0].m), 0);
    assert.equal(booked[0].topic, 'Hub 控制链验收');
    await until(() => { const f = path.join(dir, 'state.json'); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f)).roomEvents?.length; }, 'room result card source');
    const group = path.join(root, 'welink-phone-group.jsonl');
    await until(() => fs.existsSync(group) && /会议室成功/.test(fs.readFileSync(group, 'utf8')), 'room phone push');
    result.bookingReceipt = booked[0]; result.runtime = runtime; result.checks.push('signed old exe + new code; GUI rules -> daemon -> mock 14:00 booking -> history -> card -> phone');
    await click('[data-ca="close-panel"]');
    await ui('/\\d{2}-\\d{2}（周[一二三四五六日]）14:00–16:00 · /.test(document.querySelector("[data-slot=rooms]")?.innerText || "")', 'room card shows date, weekday and 14:00–16:00');
    assert.equal(await c.eval('getComputedStyle(document.querySelector(".ca-status .ca-dot")).width'), '10px');
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('mishu-probe-')), []);
    result.checks.push('room card slot text; 10px status dot; probe temp dir removed');
    await shot('05-result');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 850, deviceScaleFactor: 1, mobile: false });
    assert.equal(await c.eval('document.querySelector(".ca-sidebar").getBoundingClientRect().width'), 56);
    assert.equal(await c.eval('document.querySelector(".ca-main").scrollWidth > document.querySelector(".ca-main").clientWidth'), false);
    await shot('06-conversation-1000');
    result.checks.push('1440 sidebar 272px; 1000 sidebar 56px; avatars; no horizontal main overflow');
    result.ok = true;
  } catch (e) {
    result.ok = false; result.error = e.stack; if (c) await shot('failure').catch(() => {}); throw e;
  } finally {
    // window.close follows BrowserWindow's close event and the real save/drain path.
    // CDP /json/close destroys WebContents directly and can leave the company
    // forum's hidden owner alive without ever requesting application shutdown.
    if (c && hub?.isAlive()) {
      try {
        await c.eval('window.close()');
        await until(() => !hub.isAlive(), 'normal window close drains and exits', 25000);
        result.checks.push('normal window close -> saves/drains -> clean process exit');
      } catch (e) {
        result.ok = false; process.exitCode = 1; result.closeError = e.message;
      }
    }
    if (c) c.close();
    if (hub) {
      try { result.teardown = await gracefulQuit(hub, { allowAlreadyExited: true }); }
      catch (e) { result.ok = false; process.exitCode = 1; result.teardownError = e.message; }
      result.hubLogTail = hub.log().slice(-24);
    }
    if (!secretaryPid) { try { secretaryPid = JSON.parse(fs.readFileSync(path.join(room, 'hub-control', 'status.json'))).pid; } catch {} }
    if (secretaryPid) {
      const procPath = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(secretaryPid)} -ErrorAction Stop).Path`], { encoding: 'utf8', windowsHide: true }).trim();
      assert.equal(path.resolve(procPath).toLowerCase(), path.resolve(exe).toLowerCase());
      execFileSync('taskkill.exe', ['/PID', String(secretaryPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    mock?.kill();
    result.mockErrors = errors; result.finished = Date.now();
    fs.writeFileSync(path.join(out, `20261020-company-v3${variant}-e2e-codex2.json`), j(result));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
