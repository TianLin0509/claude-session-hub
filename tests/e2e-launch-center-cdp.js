'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-launch-center-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'launch-center');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `launch-center-${RUN_ID}.png`);
const GROUP_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `launch-center-group-${RUN_ID}.png`);
const GROUP_COMPACT_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `launch-center-group-760-${RUN_ID}.png`);
const GROUP_MOBILE_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `launch-center-group-375-${RUN_ID}.png`);
const RESUME_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `launch-center-resume-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);
const rendererErrors = [];
const ERROR_CAPTURE = `(() => {
  window.__launchCenterErrors = [];
  window.addEventListener('error', event => window.__launchCenterErrors.push(String(event.error || event.message || 'renderer error')));
  window.addEventListener('unhandledrejection', event => window.__launchCenterErrors.push(String(event.reason || 'unhandled rejection')));
})()`;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function pointFor(client, selector) {
  return client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false, selector: ${JSON.stringify(selector)} };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      found: true, selector: ${JSON.stringify(selector)}, x, y,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
      hit: hit && (hit.tagName + '.' + hit.className),
    };
  })()`);
}

async function clickPoint(client, selector) {
  const point = await pointFor(client, selector);
  assert.equal(point.found, true, `${selector} should exist`);
  assert.equal(point.visible, true, `${selector} should be visible`);
  assert.equal(point.topmost, true, `${selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function setViewport(client, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await _waitMs(180);
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function chooseValue(client, selector, value) {
  assert.equal(await client.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input || ![...input.options].some(option => option.value === ${JSON.stringify(value)})) return false;
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`), true, `select ${selector} = ${value}`);
}

async function reloadReady(client) {
  rendererErrors.push(...await client.eval('window.__launchCenterErrors || []'));
  const previousOrigin = await client.eval('performance.timeOrigin');
  await client.send('Page.reload');
  await waitFor('new renderer document ready', () => client.eval(`Boolean(performance.timeOrigin !== ${previousOrigin} && document.readyState === 'complete' && window.LaunchCenter && window.WorkspaceController)`));
}

async function verifyLastLaunch(client, result) {
  console.log('[T4] real launch, memory and fallback');
  await clickPoint(client, '[data-launch-intent="session"]');
  await clickPoint(client, '.new-session-option[data-kind="codex"]');
  await waitFor('Codex tuning catalog', () => client.eval(`document.querySelector('#new-session-model')?.options.length > 0`));
  await client.eval(`window.WorkspaceController.loadModelCatalog('codex')`);
  await chooseValue(client, '#new-session-effort', 'high');
  await chooseValue(client, '#new-session-mcp', 'none');
  await chooseValue(client, '#new-session-codex-tier', 'standard');
  const beforeIds = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.map(s => s.id))`);
  await clickPoint(client, '#new-session-submit');
  const first = await waitFor('first real Codex session', () => client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.find(s => s.kind === 'codex' && !${JSON.stringify(beforeIds)}.includes(s.id)) || null)`), 60000);
  await waitFor('last launch stored', () => client.eval(`localStorage.getItem('hub.launch.last') && document.getElementById('new-session-menu').style.display === 'none'`));
  const saved = await client.eval(`JSON.parse(localStorage.getItem('hub.launch.last'))`);
  assert.equal(saved.kind, 'codex');
  assert.equal(saved.effort, 'high');
  assert.equal(saved.mcpProfile, 'none');
  assert.equal(saved.codexSpeedTier, 'standard');
  assert.equal(saved.workspace.path, first.cwd);
  assert.equal(first.currentModel.id, saved.model);
  assert.equal(await client.eval(`document.querySelector('#btn-new .btn-label').textContent`), `启动 Codex  ${saved.workspace.label}`);
  // Observe the real modal throughout direct launch, without replacing creation/IPC.
  await client.eval(`(() => {
    window.__t4ModalOpens = 0;
    window.addEventListener('launch-center:session-opened', () => { window.__t4ModalOpens += 1; });
  })()`);
  await clickPoint(client, '#btn-new');
  const second = await waitFor('second real Codex session', () => client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.find(s => s.kind === 'codex' && !${JSON.stringify([...beforeIds, first.id])}.includes(s.id)) || null)`), 60000);
  await waitFor('direct launch settled', () => client.eval(`!document.getElementById('btn-new').disabled`));
  for (const key of ['kind', 'cwd', 'model', 'effort', 'mcpProfile', 'codexSpeedTier', 'fastMode']) assert.deepEqual(second[key], first[key], key);
  assert.equal(second.currentModel.id, saved.model);
  assert.notEqual(first.id, second.id);
  assert.equal(await client.eval('window.__t4ModalOpens'), 0);
  const dimensions = await client.eval(`(() => ({ height: document.querySelector('.launch-split').getBoundingClientRect().height, moreWidth: document.getElementById('btn-new-more').getBoundingClientRect().width }))()`);
  assert.equal(dimensions.height, 32); assert.equal(dimensions.moreWidth, 30);
  await screenshot(client, path.join(ARTIFACT_DIR, 'T4-launch-split.png'));
  result.lastLaunch = { first, second, saved, dimensions, modalOpens: 0 };

  await reloadReady(client);
  await waitFor('remembered launch after reload', () => client.eval(`Boolean(window.LaunchCenter && document.querySelector('#btn-new .btn-label').textContent.startsWith('启动 Codex'))`));
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 2 });
  await waitFor('Ctrl+N still opens center', () => client.eval(`document.getElementById('new-session-menu').style.display === 'flex'`));
  await clickPoint(client, '#new-session-close');

  // A removed, test-owned empty directory simulates stale stored workspace safely.
  const missing = path.join(TEMP_ROOT, 'removed-workspace');
  fs.mkdirSync(missing);
  fs.rmdirSync(missing);
  await client.eval(`localStorage.setItem('hub.launch.last', JSON.stringify({ ...${JSON.stringify(saved)}, workspace: { path: ${JSON.stringify(missing)}, label: '已删除的测试工作区' } }))`);
  const count = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.length)`);
  await clickPoint(client, '#btn-new');
  await waitFor('missing directory falls back and settles', () => client.eval(`document.getElementById('new-session-menu').style.display === 'flex' && !document.getElementById('btn-new').disabled`));
  result.missingWorkspace = await client.eval(`({ message: document.getElementById('new-session-error').textContent, errorVisible: !document.getElementById('new-session-error').hidden, path: document.getElementById('new-session-path-value').title, model: document.getElementById('new-session-model').value, effort: document.getElementById('new-session-effort').value })`);
  assert.match(result.missingWorkspace.message, /工作区/);
  assert.equal(result.missingWorkspace.errorVisible, true);
  result.missingWorkspace.errorUnobscured = await client.eval(`(() => {
    const error = document.getElementById('new-session-error');
    const rect = error.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const footer = document.querySelector('.session-create-footer').getBoundingClientRect();
    return rect.height > 0 && rect.bottom <= footer.top + 1 && (hit === error || error.contains(hit));
  })()`);
  assert.equal(result.missingWorkspace.errorUnobscured, true, 'fallback reason must be visible above the footer');
  assert.equal(result.missingWorkspace.path, missing);
  assert.equal(result.missingWorkspace.model, saved.model);
  assert.equal(result.missingWorkspace.effort, saved.effort);
  assert.equal(await client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.length)`), count);
  assert.equal(fs.existsSync(missing), false);
  await screenshot(client, path.join(ARTIFACT_DIR, 'T4-missing-workspace.png'));
  await clickPoint(client, '#new-session-close');
  await client.eval(`localStorage.removeItem('hub.launch.last'); window.dispatchEvent(new Event('focus'));`);
  assert.equal(await client.eval(`document.querySelector('#btn-new .btn-label').textContent`), '启动');
  await clickPoint(client, '#btn-new');
  await waitFor('cleared history opens center', () => client.eval(`document.getElementById('new-session-menu').style.display === 'flex'`));
  assert.equal(await client.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.length)`), count);
  await clickPoint(client, '#new-session-close');
  await reloadReady(client);
  await waitFor('cleared history after reload', () => client.eval(`Boolean(window.LaunchCenter && document.querySelector('#btn-new .btn-label').textContent === '启动')`));
}

async function verifyPersistentMembers(client, result) {
  console.log('[T4] persistent group members');
  await clickPoint(client, '#btn-new-more');
  await waitFor('more button opens center', () => client.eval(`document.getElementById('new-session-menu').style.display === 'flex'`));
  await clickPoint(client, '[data-launch-intent="group"]');
  await waitFor('two member form', () => client.eval(`document.querySelectorAll('.mcm-ai-select').length === 2`));
  await clickPoint(client, '[data-mcm-scene="general"]');
  await clickPoint(client, '[data-mcm-workspace-mode="default"]');
  for (let i = 1; i <= 2; i++) await chooseValue(client, `.mcm-slot:nth-child(${i}) .mcm-ai-select`, 'codex');
  await client.eval(`document.getElementById('mcm-title-input').value = 'T4 两个 Codex 常驻成员'`);
  await clickPoint(client, '.mcm-create');
  const meetingId = await waitFor('created group in sidebar', () => client.eval(`[...document.querySelectorAll('#session-list .meeting.gc')].find(row => row.querySelector('.sl-title')?.textContent.includes('T4 两个 Codex'))?.dataset.meetingId || null`), 60000);
  await clickPoint(client, '#btn-home');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 850 });
  const selector = `#session-list .meeting.gc[data-meeting-id="${meetingId}"]`;
  result.members = await client.eval(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const members = row.querySelector('.session-mini-jumps');
    const rect = row.getBoundingClientRect(); const detailRect = members.getBoundingClientRect();
    const next = row.nextElementSibling?.getBoundingClientRect();
    return { id: row.dataset.meetingId, count: members.querySelectorAll('.mini-jump-btn').length,
      labels: [...members.querySelectorAll('.mini-jump-text')].map(n => n.textContent),
      hint: members.querySelector('.sl-members-hint').textContent, display: getComputedStyle(members).display,
      position: getComputedStyle(members).position, hovered: row.matches(':hover'), focused: row.contains(document.activeElement),
      rowHeight: rect.height, contained: detailRect.bottom <= rect.bottom, noOverlap: !next || rect.bottom <= next.top + 1,
      firstMember: members.querySelector('.mini-jump-btn').dataset.subId };
  })()`);
  assert.deepEqual(result.members.labels, ['codex', 'codex']);
  assert.equal(result.members.count, 2); assert.equal(result.members.hint, '2/2 已选');
  assert.equal(result.members.display, 'flex'); assert.equal(result.members.position, 'static');
  assert.equal(result.members.hovered, false); assert.equal(result.members.focused, false);
  assert.ok(result.members.rowHeight > 27); assert.ok(result.members.contained); assert.ok(result.members.noOverlap);
  await screenshot(client, path.join(ARTIFACT_DIR, 'T4-group-members-persistent.png'));
  await clickPoint(client, `${selector} .mini-jump-btn`);
  await waitFor('original member session selected', () => client.eval(`document.querySelector(${JSON.stringify(selector + ' .mini-jump-btn')}).classList.contains('active')`));
  assert.equal(await client.eval(`localStorage.getItem('hub.launch.last')`), null, 'group creation cannot replace ordinary launch memory');

  await clickPoint(client, '#btn-home');
  for (const theme of ['dark', 'claude', 'codex', 'frost']) {
    await clickPoint(client, '#btn-theme');
    await clickPoint(client, `[data-theme-id="${theme}"]`);
    await clickPoint(client, '#btn-theme');
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 850 });
    assert.equal(await client.eval(`getComputedStyle(document.querySelector(${JSON.stringify(selector + ' .session-mini-jumps')})).display`), 'flex', theme);
  }
  result.members.themes = ['dark', 'claude', 'codex', 'frost'];
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', modifiers: 2 });
  await waitFor('sidebar collapsed', () => client.eval(`document.getElementById('session-sidebar').getBoundingClientRect().width === 0 || getComputedStyle(document.getElementById('session-sidebar')).display === 'none'`));
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', modifiers: 2 });
  await waitFor('sidebar expanded', () => client.eval(`document.getElementById('session-sidebar').getBoundingClientRect().width > 100`));
  assert.equal(await client.eval(`getComputedStyle(document.querySelector(${JSON.stringify(selector + ' .session-mini-jumps')})).display`), 'flex');
  result.members.collapseRestored = true;

  // Real extra members exercise wrapping without fabricating sidebar DOM.
  await clickPoint(client, '#btn-new-more');
  await clickPoint(client, '[data-launch-intent="group"]');
  for (let i = 0; i < 3; i++) {
    await client.eval(`document.getElementById('mcm-add-member').scrollIntoView({ block: 'center' })`);
    await clickPoint(client, '#mcm-add-member');
  }
  await clickPoint(client, '[data-mcm-scene="general"]');
  await clickPoint(client, '[data-mcm-workspace-mode="default"]');
  for (let i = 1; i <= 5; i++) await chooseValue(client, `.mcm-slot:nth-child(${i}) .mcm-ai-select`, 'codex');
  await client.eval(`document.getElementById('mcm-title-input').value = 'T4 多成员换行与长标题不会遮住下一条会话'`);
  await clickPoint(client, '.mcm-create');
  const largerId = await waitFor('five-member group', () => client.eval(`[...document.querySelectorAll('#session-list .meeting.gc')].find(row => row.querySelector('.sl-title')?.textContent.includes('T4 多成员'))?.dataset.meetingId || null`), 60000);
  await clickPoint(client, '#btn-home');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 850 });
  result.members.wrapping = await client.eval(`(() => {
    const row = document.querySelector('[data-meeting-id="${largerId}"]'); const rect = row.getBoundingClientRect();
    const cells = [...row.querySelectorAll('.mini-jump-cell')];
    return { count: cells.length, rows: new Set(cells.map(n => Math.round(n.getBoundingClientRect().top))).size,
      contained: cells.every(n => { const r = n.getBoundingClientRect(); return r.right <= rect.right && r.bottom <= rect.bottom; }),
      noOverlap: rect.bottom <= row.nextElementSibling.getBoundingClientRect().top + 1 };
  })()`);
  assert.equal(result.members.wrapping.count, 5);
  assert.ok(result.members.wrapping.rows >= 2);
  assert.ok(result.members.wrapping.contained && result.members.wrapping.noOverlap);
  await screenshot(client, path.join(ARTIFACT_DIR, 'T4-members-wrap.png'));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = {
    runId: RUN_ID,
    port,
    screenshots: {
      session: SCREENSHOT_PATH,
      group: GROUP_SCREENSHOT_PATH,
      groupCompact: GROUP_COMPACT_SCREENSHOT_PATH,
      groupMobile: GROUP_MOBILE_SCREENSHOT_PATH,
      resume: RESUME_SCREENSHOT_PATH,
    },
  };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'unified-launch-center',
      windowMode: 'hidden',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await setViewport(client, 1500, 960);
    await waitFor('launch center shell', () => client.eval(`Boolean(window.LaunchCenter && window.WorkspaceController && window.openMeetingCreateModal && window.__chuxinShow)`));

    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_CAPTURE });
    await client.eval(ERROR_CAPTURE);

    result.header = await client.eval(`(() => ({
      newLabel: document.querySelector('#btn-new .btn-label')?.textContent,
      homeLabel: document.querySelector('#btn-home .btn-label')?.textContent,
      researchLabel: document.querySelector('#btn-research .btn-label')?.textContent,
      legacyGroup: !!document.getElementById('btn-group-chat'),
      legacyResume: !!document.getElementById('btn-resume'),
      primaryCount: document.querySelectorAll('.sidebar-header .btn-new-session').length,
    }))()`);
    assert.deepEqual(result.header, {
      newLabel: '启动', homeLabel: '主页', researchLabel: '投研',
      legacyGroup: false, legacyResume: false, primaryCount: 1,
    });

    await clickPoint(client, '#btn-new');
    result.open = await waitFor('launch center open', () => client.eval(`(() => {
      const modal = document.getElementById('new-session-menu');
      if (!modal || getComputedStyle(modal).display !== 'flex') return null;
      return {
        expanded: document.getElementById('btn-new').getAttribute('aria-expanded'),
        intent: window.LaunchCenter.getActiveIntent(),
        intentCount: document.querySelectorAll('[data-launch-intent]').length,
        modalRole: modal.getAttribute('role'),
      };
    })()`));
    assert.equal(result.open.expanded, 'true');
    assert.equal(result.open.intent, 'session');
    assert.equal(result.open.intentCount, 3);
    assert.equal(result.open.modalRole, 'dialog');

    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F', code: 'KeyF', modifiers: 10 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F', code: 'KeyF', modifiers: 10 });
    result.modalIsolation = await client.eval(`(() => ({
      launchCenterVisible: getComputedStyle(document.getElementById('new-session-menu')).display === 'flex',
      quickOpenVisible: getComputedStyle(document.getElementById('preview-quick-open')).display !== 'none',
      searchVisible: getComputedStyle(document.getElementById('search-modal')).display !== 'none',
    }))()`);
    assert.deepEqual(result.modalIsolation, { launchCenterVisible: true, quickOpenVisible: false, searchVisible: false });

    await clickPoint(client, '[data-launch-intent="group"]');
    await waitFor('embedded group configuration', () => client.eval(`document.querySelector('#launch-center-group-host .mcm-embedded .mcm-slots')?.children.length === 2`));
    await clickPoint(client, '[data-mcm-scene="dev"]');
    result.groupIntent = await client.eval(`(() => ({
      intent: window.LaunchCenter.getActiveIntent(),
      panelVisible: !document.getElementById('launch-center-group-panel').hidden,
      sessionHidden: document.getElementById('launch-center-session-panel').hidden,
      embedded: document.getElementById('meeting-create-modal')?.classList.contains('mcm-embedded'),
      embeddedRole: document.querySelector('#meeting-create-modal .mcm-dialog')?.getAttribute('role'),
      members: document.querySelectorAll('#launch-center-group-host .mcm-slot').length,
      devSceneSelected: document.querySelector('[data-mcm-scene="dev"]')?.classList.contains('selected'),
      devScene: document.querySelector('input[name="mcm-scene"][value="dev"]')?.checked,
      launchCenterVisible: getComputedStyle(document.getElementById('new-session-menu')).display === 'flex',
    }))()`);
    assert.deepEqual(result.groupIntent, {
      intent: 'group', panelVisible: true, sessionHidden: true,
      embedded: true, embeddedRole: 'group', members: 2, devSceneSelected: true, devScene: true, launchCenterVisible: true,
    });
    await client.eval(`document.getElementById('mcm-title-input').value = '保留这份成员配置'`);
    await screenshot(client, GROUP_SCREENSHOT_PATH);
    await clickPoint(client, '[data-launch-intent="resume"]');
    result.resume = await client.eval(`(() => ({
      intent: window.LaunchCenter.getActiveIntent(),
      providerCount: document.querySelectorAll('[data-resume-kind]').length,
      kinds: [...document.querySelectorAll('[data-resume-kind]')].map(node => node.dataset.resumeKind),
      panelVisible: !document.getElementById('launch-center-resume-panel').hidden,
    }))()`);
    assert.equal(result.resume.intent, 'resume');
    assert.equal(result.resume.providerCount, 5);
    assert.deepEqual(result.resume.kinds, ['claude-resume', 'codex-resume', 'gemini-resume', 'deepseek-resume', 'kimi-resume']);
    assert.equal(result.resume.panelVisible, true);
    await screenshot(client, RESUME_SCREENSHOT_PATH);

    await clickPoint(client, '[data-launch-intent="group"]');
    result.groupPreserved = await client.eval(`(() => ({
      title: document.getElementById('mcm-title-input')?.value,
      members: document.querySelectorAll('#launch-center-group-host .mcm-slot').length,
      devSceneSelected: document.querySelector('[data-mcm-scene="dev"]')?.classList.contains('selected'),
    }))()`);
    assert.deepEqual(result.groupPreserved, { title: '保留这份成员配置', members: 2, devSceneSelected: true });
    await clickPoint(client, '[data-launch-intent="resume"]');

    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    result.escape = await waitFor('launch center close on Escape', () => client.eval(`(() => {
      const modal = document.getElementById('new-session-menu');
      return modal.style.display === 'none' ? {
        expanded: document.getElementById('btn-new').getAttribute('aria-expanded'),
        focus: document.activeElement?.id,
      } : null;
    })()`));
    assert.equal(result.escape.expanded, 'false');
    assert.equal(result.escape.focus, 'btn-new');

    // 回归：开发场景 → 关掉启动中心 → 重开，场景/工作目录都会回到默认，
    // 那条「已切到选择已有路径」的说明必须跟着消失。留着它就会出现
    // 「场景=通用、目录=默认，但屏幕上写着开发场景已切目录」的自相矛盾。
    await clickPoint(client, '#btn-new');
    await clickPoint(client, '[data-launch-intent="group"]');
    await waitFor('group panel reopened', () => client.eval(`document.querySelector('#launch-center-group-host .mcm-embedded .mcm-slots')?.children.length === 2`));
    result.sceneReset = await client.eval(`(() => {
      const hint = document.getElementById('mcm-scene-hint');
      return {
        scene: document.querySelector('input[name="mcm-scene"]:checked')?.value,
        devSceneSelected: document.querySelector('[data-mcm-scene="dev"]')?.classList.contains('selected'),
        workspaceMode: document.querySelector('#meeting-create-modal .mcm-workspace-choice.selected')?.dataset.mcmWorkspaceMode,
        hintShown: !!(hint && getComputedStyle(hint).display !== 'none'),
        hintText: hint ? hint.textContent.trim() : null,
      };
    })()`);
    assert.deepEqual(result.sceneReset, {
      scene: 'dev', devSceneSelected: true, workspaceMode: 'existing',
      hintShown: true, hintText: '从「项目库」选择项目，或选择已有文件夹。单人点「独立开工」；两人点「开题」，由第一位实现、第二位验证与合并。',
    }, '重开后场景说明必须跟着场景一起复位');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await waitFor('launch center closed again', () => client.eval(`document.getElementById('new-session-menu').style.display === 'none'`));

    await clickPoint(client, '#btn-research');
    result.research = await waitFor('research panel', () => client.eval(`(() => {
      const panel = document.getElementById('chuxin-panel');
      if (!panel || getComputedStyle(panel).display === 'none') return null;
      return {
        researchActive: document.getElementById('btn-research').classList.contains('active'),
        researchCurrent: document.getElementById('btn-research').getAttribute('aria-current'),
        homeActive: document.getElementById('btn-home').classList.contains('active'),
      };
    })()`));
    assert.equal(result.research.researchActive, true);
    assert.equal(result.research.researchCurrent, 'page');
    assert.equal(result.research.homeActive, false);
    await clickPoint(client, '#btn-home');
    result.home = await waitFor('home panel', () => client.eval(`(() => {
      const research = document.getElementById('chuxin-panel');
      const home = document.getElementById('btn-home');
      return getComputedStyle(research).display === 'none' && home.classList.contains('active')
        ? { homeCurrent: home.getAttribute('aria-current'), researchActive: document.getElementById('btn-research').classList.contains('active') }
        : null;
    })()`));
    assert.equal(result.home.homeCurrent, 'page');
    assert.equal(result.home.researchActive, false);

    await setViewport(client, 760, 900);
    await clickPoint(client, '#btn-new');
    await clickPoint(client, '[data-launch-intent="group"]');
    await waitFor('compact embedded group form', () => client.eval(`document.querySelector('#launch-center-group-host .mcm-embedded .mcm-slots')?.children.length === 2`));
    result.compact = await client.eval(`(() => {
      const modal = document.getElementById('new-session-menu').getBoundingClientRect();
      const layout = getComputedStyle(document.querySelector('.launch-center-layout'));
      const slots = document.querySelector('#launch-center-group-host .mcm-slots');
      const body = document.querySelector('#launch-center-group-host .mcm-body');
      const create = document.querySelector('#launch-center-group-host .mcm-create').getBoundingClientRect();
      return {
        viewport: innerWidth,
        left: modal.left, right: modal.right, width: modal.width,
        columns: layout.gridTemplateColumns,
        memberColumns: getComputedStyle(slots).gridTemplateColumns.split(' ').filter(Boolean).length,
        formScrollWidth: body.scrollWidth,
        formClientWidth: body.clientWidth,
        createVisible: create.width > 0 && create.height > 0 && create.left >= 0 && create.right <= innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
      };
    })()`);
    assert.ok(result.compact.left >= 0 && result.compact.right <= 760, JSON.stringify(result.compact));
    assert.equal(result.compact.bodyScrollWidth, 760);
    assert.equal(result.compact.memberColumns, 2);
    assert.ok(result.compact.formScrollWidth <= result.compact.formClientWidth + 1, JSON.stringify(result.compact));
    assert.equal(result.compact.createVisible, true);
    await screenshot(client, GROUP_COMPACT_SCREENSHOT_PATH);

    await setViewport(client, 375, 820);
    result.mobile = await client.eval(`(() => {
      const modal = document.getElementById('new-session-menu').getBoundingClientRect();
      const slots = document.querySelector('#launch-center-group-host .mcm-slots');
      const body = document.querySelector('#launch-center-group-host .mcm-body');
      const create = document.querySelector('#launch-center-group-host .mcm-create').getBoundingClientRect();
      return {
        viewport: innerWidth, left: modal.left, right: modal.right, width: modal.width,
        bodyScrollWidth: document.body.scrollWidth,
        memberColumns: getComputedStyle(slots).gridTemplateColumns.split(' ').filter(Boolean).length,
        formScrollWidth: body.scrollWidth,
        formClientWidth: body.clientWidth,
        createVisible: create.width > 0 && create.height > 0 && create.left >= 0 && create.right <= innerWidth,
        homeLabelDisplay: getComputedStyle(document.querySelector('#btn-home .btn-label')).display,
        researchLabelDisplay: getComputedStyle(document.querySelector('#btn-research .btn-label')).display,
      };
    })()`);
    assert.ok(result.mobile.left >= 0 && result.mobile.right <= 375, JSON.stringify(result.mobile));
    assert.equal(result.mobile.bodyScrollWidth, 375);
    assert.equal(result.mobile.memberColumns, 1);
    assert.ok(result.mobile.formScrollWidth <= result.mobile.formClientWidth + 1, JSON.stringify(result.mobile));
    assert.equal(result.mobile.createVisible, true);
    assert.equal(result.mobile.homeLabelDisplay, 'none');
    assert.equal(result.mobile.researchLabelDisplay, 'none');
    await screenshot(client, GROUP_MOBILE_SCREENSHOT_PATH);

    await setViewport(client, 1500, 960);
    await client.eval(`window.LaunchCenter.selectIntent('session', { focus: false })`);
    await screenshot(client, SCREENSHOT_PATH);
    await verifyLastLaunch(client, result);
    await verifyPersistentMembers(client, result);
    result.errors = [...rendererErrors, ...await client.eval('window.__launchCenterErrors || []')];
    assert.deepEqual(result.errors, []);
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ...result, resultPath: RESULT_PATH }, null, 2));
  } catch (error) {
    if (client) {
      try { await screenshot(client, path.join(ARTIFACT_DIR, `failure-${RUN_ID}.png`)); }
      catch (captureError) { console.error('Failure screenshot unavailable:', captureError.message); }
    }
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-100).join('\n'));
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
