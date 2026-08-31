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

    await client.eval(`(() => {
      window.__launchCenterErrors = [];
      window.addEventListener('error', event => window.__launchCenterErrors.push(String(event.error || event.message || 'renderer error')));
      window.addEventListener('unhandledrejection', event => window.__launchCenterErrors.push(String(event.reason || 'unhandled rejection')));
    })()`);

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
    await clickPoint(client, '[data-mcm-template="review"]');
    result.groupIntent = await client.eval(`(() => ({
      intent: window.LaunchCenter.getActiveIntent(),
      panelVisible: !document.getElementById('launch-center-group-panel').hidden,
      sessionHidden: document.getElementById('launch-center-session-panel').hidden,
      embedded: document.getElementById('meeting-create-modal')?.classList.contains('mcm-embedded'),
      embeddedRole: document.querySelector('#meeting-create-modal .mcm-dialog')?.getAttribute('role'),
      members: document.querySelectorAll('#launch-center-group-host .mcm-slot').length,
      reviewSelected: document.querySelector('[data-mcm-template="review"]')?.classList.contains('selected'),
      devScene: document.querySelector('input[name="mcm-scene"][value="dev"]')?.checked,
      launchCenterVisible: getComputedStyle(document.getElementById('new-session-menu')).display === 'flex',
    }))()`);
    assert.deepEqual(result.groupIntent, {
      intent: 'group', panelVisible: true, sessionHidden: true,
      embedded: true, embeddedRole: 'group', members: 2, reviewSelected: true, devScene: true, launchCenterVisible: true,
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
      reviewSelected: document.querySelector('[data-mcm-template="review"]')?.classList.contains('selected'),
    }))()`);
    assert.deepEqual(result.groupPreserved, { title: '保留这份成员配置', members: 2, reviewSelected: true });
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
    result.errors = await client.eval('window.__launchCenterErrors || []');
    assert.deepEqual(result.errors, []);
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ...result, resultPath: RESULT_PATH }, null, 2));
  } catch (error) {
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
