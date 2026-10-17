'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, click, waitFor } = require('./helpers/usage-refresh-fixture');
const { nativeSnapshot } = require('./helpers/native-runtime-fixture');

const out = path.resolve(process.argv[2] || 'artifacts/20261017-sidebar-badge-left-codex1/gui');
fs.mkdirSync(out, { recursive: true });
const evidence = { ok: false, checks: [], layouts: [], boundary: '隔离 Electron 实际渲染与点击；会话为受控样例，不调用 AI' };
let hub, cdp;
const row = id => `.session-item[data-session-id="${id}"]`;
const group = '.session-item[data-meeting-id="badge-group"]';
function check(value, label) { assert(value, label); evidence.checks.push(label); console.log('PASS ' + label); }

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
}

async function inspectLayout(label) {
  const rows = await cdp.eval(`(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x:r.x, right:r.right, y:r.y, height:r.height, width:r.width }; };
    return [...document.querySelectorAll('#session-list .session-item.slim')].filter(e => e.getBoundingClientRect().height > 0).map(e => {
      const line = e.querySelector(':scope > .sl-line1') || e;
      const badge = line.querySelector(':scope > .sl-kind, :scope > .sl-group-logos, :scope > .sl-model');
      const title = line.querySelector(':scope > .sl-title'), time = line.querySelector(':scope > .sl-time');
      const arrow = line.querySelector(':scope > .expand-arrow');
      const cs = getComputedStyle(badge);
      return { id:e.dataset.sessionId || e.dataset.meetingId, line:rect(line), badge:rect(badge), title:rect(title), time:rect(time), arrow:arrow && rect(arrow), ellipsis:getComputedStyle(title).textOverflow, state:badge.dataset.state, ring:cs.outlineWidth, ringStyle:cs.outlineStyle, filter:cs.filter, animation:cs.animationName, titleScroll:title.scrollWidth, titleClient:title.clientWidth };
    });
  })()`);
  evidence.layouts.push({ label, rows });
  assert(rows.length >= 9, label + ': ordinary and group rows must render');
  for (const r of rows) {
    assert(r.badge.right < r.title.x, `${label}/${r.id}: badge must be before title`);
    assert(r.title.right <= r.time.x, `${label}/${r.id}: title must not overlap time`);
    assert(r.badge.x >= r.line.x && r.time.right <= r.line.right, `${label}/${r.id}: all columns stay inside the row`);
    assert(Math.abs(r.line.height - 27) < 1, `${label}/${r.id}: compact line remains 27 px`);
    assert.equal(r.ellipsis, 'ellipsis', `${label}/${r.id}: long title stays ellipsized`);
    if (r.arrow) assert(r.arrow.right <= r.badge.x, `${label}/${r.id}: expand arrow keeps its own column`);
  }
  const long = rows.find(r => r.id === 'badge-long');
  assert(long.titleScroll > long.titleClient, 'long title fixture must actually truncate');
  const running = rows.find(r => r.id === 'badge-running');
  assert.equal(running.state, 'run');
  // Chromium rounds the 2 CSS px outline at Windows fractional display scales.
  assert(parseFloat(running.ring) >= 1.5 && running.ringStyle === 'solid' && running.animation === 'none', 'static running ring is retained');
  const dormant = rows.find(r => r.id === 'badge-dormant');
  assert.equal(dormant.state, 'dorm');
  assert.equal(dormant.filter, 'grayscale(1)');
  check(true, label + '：徽章在标题前、27 px 单行、长标题省略、时间与状态保留');
}

(async () => {
  try {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-badge-left-e2e-'));
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await getFreePort(), label: 'sidebar-badge-left', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    cdp = await connectFirstPage(hub);
    await waitFor(cdp, '!!window.__hubE2E');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await click(cdp, '[data-display-mode="desktop"]');
    const fixtures = [
      { id:'badge-long', kind:'codex', title:'AI Hub 头像风格与侧栏会话徽章位置的长标题排版核验', status:'idle', nativeRuntime:nativeSnapshot('idle') },
      { id:'badge-running', kind:'codex', title:'运行中的 Codex 会话', status:'running', nativeRuntime:nativeSnapshot('running') },
      { id:'badge-idle', kind:'claude', title:'Claude 普通会话', status:'idle' },
      { id:'badge-dormant', kind:'claude', title:'休眠会话', status:'dormant' },
      { id:'badge-wait', kind:'claude', title:'等待输入会话', status:'running', attentionState:'needs-input', needsUserInput:true },
      { id:'badge-unread', kind:'claude', title:'有未读消息的会话', status:'idle', unreadCount:1 },
      { id:'badge-shell', kind:'powershell', title:'PowerShell 终端', status:'idle' },
      { id:'badge-member-a', kind:'claude', title:'群聊成员 Claude', status:'idle', meetingId:'badge-group' },
      { id:'badge-member-b', kind:'codex', title:'群聊成员 Codex', status:'idle', meetingId:'badge-group', nativeRuntime:nativeSnapshot('idle') },
    ];
    await cdp.eval(`window.__hubE2E.clearSessions(); meetings={};
      window.__hubE2E.addFakeSessions(${JSON.stringify(fixtures)});
      meetings['badge-group']={id:'badge-group',title:'两位成员的群聊',groupChat:true,status:'idle',subSessions:['badge-member-a','badge-member-b'],participants:[0,1],turns:[],log:[],lastMessageTime:Date.now(),createdAt:Date.now()};
      meetings['badge-empty']={id:'badge-empty',title:'无成员群聊徽章',groupChat:true,status:'idle',subSessions:[],participants:[],turns:[],log:[],lastMessageTime:Date.now(),createdAt:Date.now()};
      document.documentElement.dataset.theme='codex';
      document.documentElement.style.setProperty('--display-session-width','224px');
      renderSessionList();`);
    await waitFor(cdp, `!!document.querySelector('${row('badge-long')} .sl-kind')`);
    await _waitMs(300);
    if (await cdp.eval("getComputedStyle(document.querySelector('#new-session-menu')).display!=='none'")) {
      await click(cdp, '#new-session-close');
      await waitFor(cdp, "getComputedStyle(document.querySelector('#new-session-menu')).display==='none'");
    }
    await inspectLayout('浅色紧凑 224 px');
    await screenshot('20261017-badge-left-desktop');

    await click(cdp, row('badge-idle') + ' .sl-kind');
    await waitFor(cdp, `activeSessionId==='badge-idle'`);
    check(await cdp.eval(`document.querySelector('${row('badge-idle')}').classList.contains('selected')`), '点击左侧徽章仍选中会话');
    await click(cdp, group + ' .sl-group-logos');
    await waitFor(cdp, `activeMeetingId==='badge-group'`);
    await waitFor(cdp, `document.querySelector('${row('badge-member-a')}')?.getBoundingClientRect().height>0`);
    await inspectLayout('群聊选中及成员展开');
    await click(cdp, row('badge-member-a') + ' .sl-kind');
    await waitFor(cdp, `activeSessionId==='badge-member-a'`);
    check(true, '群聊与成员左侧徽章均可点击进入');

    await click(cdp, '#btn-session-details');
    await waitFor(cdp, `document.querySelector('#btn-session-details').getAttribute('aria-pressed')==='true'`);
    const expandedBefore = await cdp.eval(`document.querySelector('${group}').classList.contains('expanded')`);
    await click(cdp, group + ' .expand-arrow');
    await waitFor(cdp, `document.querySelector('${group}').classList.contains('expanded')!==${expandedBefore}`);
    if (expandedBefore) await click(cdp, group + ' .expand-arrow');
    await waitFor(cdp, `!!document.querySelector('${row('badge-member-a')}')`);
    await inspectLayout('详情模式与群聊展开箭头');
    await screenshot('20261017-badge-left-details');
    check(true, '详情按钮和群聊展开收起仍可操作');

    await click(cdp, '#btn-session-details');
    await cdp.eval("document.documentElement.dataset.theme='dark'");
    await click(cdp, '[data-display-mode="phone"]');
    await _waitMs(300);
    await inspectLayout('深色紧凑显示预设');
    await screenshot('20261017-badge-left-dark');
    await click(cdp, '[data-display-mode="desktop"]');
    await cdp.eval("document.documentElement.dataset.theme='codex';document.documentElement.style.setProperty('--display-session-width','280px')");
    await inspectLayout('加宽侧栏 280 px');
    evidence.ok = true;
  } catch (error) {
    evidence.error = error.stack;
    process.exitCode = 1;
    if (cdp) {
      try { await screenshot('20261017-badge-left-failure'); }
      catch (shotError) { evidence.screenshotError = shotError.stack; console.error(shotError); }
    }
    console.error(error);
  } finally {
    fs.writeFileSync(path.join(out, '20261017-sidebar-badge-left-evidence.json'), JSON.stringify(evidence, null, 2));
    try { if (cdp) await cdp.close(); }
    finally { if (hub) await gracefulQuit(hub); }
    console.log('REPORT', out, evidence.ok ? 'PASS' : 'FAIL');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
