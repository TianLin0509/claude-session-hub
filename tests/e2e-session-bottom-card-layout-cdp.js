'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEST_ROOT = path.join(os.tmpdir(), `hub-session-bottom-card-${RUN_ID}`);
const DATA_DIR = path.join(TEST_ROOT, 'hub-data');
const HOME_DIR = path.join(TEST_ROOT, 'home');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'output', 'playwright', 'session-bottom-card-layout');
const SID = 'bottom-layout-target';
const MEETING_TITLE = '置底群聊 E2E';
const SIDEBAR_SCREENSHOT = path.join(ARTIFACT_DIR, `sidebar-${RUN_ID}.png`);
const CARD_SCREENSHOT = path.join(ARTIFACT_DIR, `card-list-${RUN_ID}.png`);
const REHYDRATED_SCREENSHOT = path.join(ARTIFACT_DIR, `rehydrated-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(80);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function pointerPoint(client, selector) {
  const point = await client.eval(`(async () => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block:'center', inline:'nearest' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = node.getBoundingClientRect();
    return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2,
      width:rect.width, height:rect.height };
  })()`);
  assert.ok(point && point.width > 0 && point.height > 0, `missing or hidden pointer target: ${selector}`);
  return point;
}

async function physicalClick(client, selector, button = 'left') {
  const point = await pointerPoint(client, selector);
  const buttons = button === 'right' ? 2 : 1;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1,
  });
  return point;
}

async function openContextMenu(client, selector) {
  await client.send('Page.bringToFront');
  await physicalClick(client, selector, 'right');
  return waitFor('session context menu', async () => {
    const snapshot = await client.eval(`(() => {
      const menu = document.getElementById('context-menu');
      if (!menu || getComputedStyle(menu).display === 'none') return null;
      return Array.from(menu.querySelectorAll('.context-menu-item'))
        .filter(button => getComputedStyle(button).display !== 'none')
        .map(button => ({ action:button.dataset.action, label:button.textContent.trim(), disabled:button.disabled }));
    })()`);
    return snapshot && snapshot.length ? snapshot : null;
  });
}

async function clickMenuAction(client, action) {
  await physicalClick(client, `#context-menu [data-action="${action}"]`, 'left');
  await waitFor('context menu close', () => client.eval(
    `getComputedStyle(document.getElementById('context-menu')).display === 'none'`,
  ));
  // CDP's input acknowledgement can arrive after the listener hides the menu
  // but before the production 75ms render coalescer rebuilds the sidebar.
  // Judge the user-visible frame, not that transient boundary.
  await _waitMs(110);
  await client.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

async function capture(client, filePath) {
  const image = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
}

async function launch(port, label) {
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port,
    label,
    windowMode: 'visible',
    extraEnv: {
      CLAUDE_HUB_E2E: '1',
      CLAUDE_HUB_HOME_DIR: HOME_DIR,
      DEEPSEEK_API_KEY: '',
    },
  });
  const client = await connectFirstPage(
    hub,
    target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''),
  );
  await waitFor('renderer E2E bridge', () => client.eval(
    '!!(window.__hubE2E && window.__hubE2E.addFakeSessions && window._mountSessionTurnCard)',
  ));
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 920, deviceScaleFactor: 1, mobile: false,
  });
  return { hub, client };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const firstPort = await reservePort();
  const secondPort = await reservePort();
  const result = { runId: RUN_ID, firstPort, secondPort };
  let hub = null;
  let client = null;

  try {
    ({ hub, client } = await launch(firstPort, 'session-bottom-card-layout'));

    await client.eval(`(() => {
      window.__hubE2E.clearSessions();
      for (const key of Object.keys(meetings)) delete meetings[key];
      return true;
    })()`);
    const meeting = await client.eval(`ipcRenderer.invoke('create-meeting', {
      title:${JSON.stringify(MEETING_TITLE)}, scene:'general'
    })`);
    assert.ok(meeting && meeting.id, 'real meeting creation must succeed');
    result.meetingId = meeting.id;
    await client.eval(`ipcRenderer.invoke('update-meeting-sync', {
      meetingId:${JSON.stringify(meeting.id)}, fields:{ lastMessageTime:Date.now() - 5000 }
    })`);

    result.setup = await client.eval(`(() => {
      const now = Date.now();
      const items = [
        { id:${JSON.stringify(SID)}, title:'右键置底目标', kind:'codex', status:'idle',
          codexSid:'019f0000-0000-7000-8000-000000000001', lastMessageTime:now + 10_000 },
        { id:'pin-old', title:'原有置顶', kind:'claude', status:'idle', pinned:true,
          ccSessionId:'11111111-1111-4111-8111-111111111111', lastMessageTime:now - 86_400_000 },
      ];
      for (let index = 0; index < 120; index += 1) items.push({
        id:'pressure-' + index,
        title:'压力会话 ' + index,
        kind:index % 2 ? 'claude' : 'codex',
        status:'dormant',
        lastMessageTime:now - index * 20_000,
        createdAt:now - index * 20_000,
      });
      const timing = window.__hubE2E.addFakeSessions(items);
      return {
        timing,
        rows:document.querySelectorAll('#session-list .session-item').length,
        first:document.querySelector('#session-list .session-item')?.dataset.sessionId || null,
      };
    })()`);
    assert.equal(result.setup.rows, 123, '120 pressure rows + target + pinned + meeting should render');
    assert.equal(result.setup.first, 'pin-old');
    assert.ok(result.setup.timing.renderMs < 250,
      `123-row sidebar render took ${result.setup.timing.renderMs}ms`);

    result.sessionMenu = await openContextMenu(client, `[data-session-id="${SID}"]`);
    assert.deepStrictEqual(result.sessionMenu, [
      { action: 'pin', label: '置顶', disabled: false },
      { action: 'restart', label: '重启', disabled: false },
      { action: 'close', label: '休眠', disabled: false },
      { action: 'delete', label: '删除', disabled: false },
      { action: 'bottom', label: '置底', disabled: false },
    ]);
    await clickMenuAction(client, 'bottom');

    result.afterBottom = await client.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('#session-list .session-item'));
      const session = sessions.get(${JSON.stringify(SID)});
      return {
        pinned:!!session?.pinned,
        bottomed:!!session?.bottomed,
        lastSessionId:rows.at(-1)?.dataset.sessionId || null,
        lastMeetingId:rows.at(-1)?.dataset.meetingId || null,
        finalHeader:Array.from(document.querySelectorAll('#session-list .session-sec-header')).at(-1)?.textContent.replace(/\\s+/g, ' ').trim() || '',
      };
    })()`);
    assert.deepStrictEqual(result.afterBottom, {
      pinned: false, bottomed: true, lastSessionId: SID, lastMeetingId: null, finalHeader: '置底1',
    });

    const bottomMenu = await openContextMenu(client, `[data-session-id="${SID}"]`);
    assert.equal(bottomMenu.at(-1).label, '取消置底');
    await clickMenuAction(client, 'pin');
    result.afterPin = await client.eval(`(() => {
      const session = sessions.get(${JSON.stringify(SID)});
      const first = document.querySelector('#session-list .session-item');
      return { pinned:!!session?.pinned, bottomed:!!session?.bottomed,
        firstSessionId:first?.dataset.sessionId || null };
    })()`);
    assert.deepStrictEqual(result.afterPin, { pinned: true, bottomed: false, firstSessionId: SID });

    result.stress = { iterations: 11, elapsedMs: 0, failures: [] };
    const stressStartedAt = Date.now();
    for (let index = 0; index < result.stress.iterations; index += 1) {
      const action = index % 2 === 0 ? 'bottom' : 'pin';
      await openContextMenu(client, `[data-session-id="${SID}"]`);
      await clickMenuAction(client, action);
      const state = await client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(SID)});
        return { pinned:!!session?.pinned, bottomed:!!session?.bottomed };
      })()`);
      const expected = action === 'bottom'
        ? { pinned: false, bottomed: true }
        : { pinned: true, bottomed: false };
      if (state.pinned !== expected.pinned || state.bottomed !== expected.bottomed) {
        result.stress.failures.push({ index, action, state, expected });
      }
    }
    result.stress.elapsedMs = Date.now() - stressStartedAt;
    assert.deepStrictEqual(result.stress.failures, []);

    result.meetingMenu = await openContextMenu(client, `[data-meeting-id="${meeting.id}"]`);
    assert.deepStrictEqual(result.meetingMenu, [
      { action: 'pin', label: '置顶', disabled: false },
      { action: 'close', label: '删除会议室', disabled: false },
      { action: 'bottom', label: '置底', disabled: false },
    ]);
    await clickMenuAction(client, 'bottom');
    result.afterMeetingBottom = await client.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('#session-list .session-item'));
      const meeting = meetings[${JSON.stringify(meeting.id)}];
      return {
        pinned:!!meeting?.pinned,
        bottomed:!!meeting?.bottomed,
        lastMeetingId:rows.at(-1)?.dataset.meetingId || null,
        bottomSectionCount:Array.from(document.querySelectorAll('#session-list .session-sec-header'))
          .find(header => header.textContent.includes('置底'))?.querySelector('.sec-count')?.textContent || '',
      };
    })()`);
    assert.deepStrictEqual(result.afterMeetingBottom, {
      pinned: false, bottomed: true, lastMeetingId: meeting.id, bottomSectionCount: '2',
    });

    await _waitMs(1600);
    const statePath = path.join(DATA_DIR, 'state.json');
    const diskState = await waitFor('bottom placement state.json', async () => {
      if (!fs.existsSync(statePath)) return null;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const session = (state.sessions || []).find(item => item.hubId === SID);
      const savedMeeting = (state.meetings || []).find(item => item.id === meeting.id);
      return session?.bottomed && savedMeeting?.bottomed ? { session, meeting: savedMeeting } : null;
    });
    result.disk = {
      session: { pinned: !!diskState.session.pinned, bottomed: !!diskState.session.bottomed },
      meeting: { pinned: !!diskState.meeting.pinned, bottomed: !!diskState.meeting.bottomed },
    };
    assert.deepStrictEqual(result.disk, {
      session: { pinned: false, bottomed: true },
      meeting: { pinned: false, bottomed: true },
    });
    await capture(client, SIDEBAR_SCREENSHOT);

    result.cardLayout = await client.eval(`(() => {
      window.__hubE2E.cardQuestionNavigator.mountFixture({
        sessionId:'card-list-layout-e2e', count:0, clear:true
      });
      window._mountSessionTurnCard('card-list-layout-e2e', {
        id:'markdown-list-layout', role:'assistant', kind:'codex', ts:Date.now(),
        text:[
          '### 列表边界与行距验收',
          '',
          '下面模拟真实回答中的 Markdown 列表，包含长句、换行和嵌套层级：',
          '',
          '- 第一项：圆点应当完整留在深色卡片内部，不再悬到左侧背景之外。',
          '- 第二项：这是一段故意写得比较长的说明文字，用来验证内容换行以后，续行仍与首行正文对齐，而不是跑到圆点下面。',
          '  - 子项：嵌套列表也应该保留清晰但克制的缩进。',
          '- 第三项：正文行距增加约百分之十，长回答阅读起来更松弛。',
          '',
          '1. 有序列表沿用同一套内部留白。',
          '2. 数字标记不会越过卡片边界。',
        ].join('\\n')
      }, { kind:'codex' });
      const overlay = document.getElementById('msg-overlay');
      overlay.scrollTop = 0;
      const body = overlay.querySelector('.turn-body');
      const list = body.querySelector('ul');
      const item = list.querySelector('li');
      const nested = list.querySelector('ul');
      const bodyStyle = getComputedStyle(body);
      const listStyle = getComputedStyle(list);
      const bodyRect = body.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const fontSize = parseFloat(bodyStyle.fontSize);
      const lineHeight = parseFloat(bodyStyle.lineHeight);
      return {
        fontSize,
        lineHeight,
        lineHeightRatio:lineHeight / fontSize,
        listStylePosition:listStyle.listStylePosition,
        listPaddingInlineStart:parseFloat(listStyle.paddingInlineStart),
        bodyPaddingLeft:parseFloat(bodyStyle.paddingLeft),
        bodyLeft:bodyRect.left,
        listLeft:listRect.left,
        itemLeft:itemRect.left,
        reservedMarkerSpace:itemRect.left - listRect.left,
        estimatedMarkerLeft:itemRect.left - fontSize * 0.9,
        nestedListCount:nested ? 1 : 0,
        horizontalOverflow:body.scrollWidth - body.clientWidth,
        bodyText:body.innerText,
      };
    })()`);
    assert.ok(result.cardLayout.lineHeightRatio >= 1.70 && result.cardLayout.lineHeightRatio <= 1.78,
      `expected ~1.74 line height, got ${result.cardLayout.lineHeightRatio}`);
    assert.equal(result.cardLayout.listStylePosition, 'outside');
    assert.ok(result.cardLayout.listPaddingInlineStart >= 20);
    assert.ok(result.cardLayout.listLeft >= result.cardLayout.bodyLeft + result.cardLayout.bodyPaddingLeft - 1);
    assert.ok(result.cardLayout.reservedMarkerSpace >= 20,
      `marker reserve was only ${result.cardLayout.reservedMarkerSpace}px`);
    assert.ok(result.cardLayout.estimatedMarkerLeft >= result.cardLayout.bodyLeft + 3,
      'estimated outside marker paint must remain inside the card background');
    assert.equal(result.cardLayout.nestedListCount, 1);
    assert.ok(result.cardLayout.horizontalOverflow <= 1);
    await capture(client, CARD_SCREENSHOT);

    await client.close();
    client = null;
    result.firstExit = await gracefulQuit(hub);
    hub = null;

    ({ hub, client } = await launch(secondPort, 'session-bottom-card-layout-rehydrate'));
    result.rehydrated = await waitFor('rehydrated bottom placements', async () => {
      const snapshot = await client.eval(`(() => {
        const session = sessions.get(${JSON.stringify(SID)});
        const meeting = meetings[${JSON.stringify(meeting.id)}];
        const rows = Array.from(document.querySelectorAll('#session-list .session-item'));
        return {
          session:session ? { status:session.status, pinned:!!session.pinned, bottomed:!!session.bottomed } : null,
          meeting:meeting ? { status:meeting.status, pinned:!!meeting.pinned, bottomed:!!meeting.bottomed } : null,
          lastMeetingId:rows.at(-1)?.dataset.meetingId || null,
          finalHeader:Array.from(document.querySelectorAll('#session-list .session-sec-header')).at(-1)?.textContent.replace(/\\s+/g, ' ').trim() || '',
        };
      })()`);
      return snapshot.session?.bottomed && snapshot.meeting?.bottomed ? snapshot : null;
    });
    assert.deepStrictEqual(result.rehydrated.session, { status: 'dormant', pinned: false, bottomed: true });
    assert.deepStrictEqual(result.rehydrated.meeting, { status: 'dormant', pinned: false, bottomed: true });
    assert.equal(result.rehydrated.lastMeetingId, meeting.id);
    assert.equal(result.rehydrated.finalHeader, '置底2');
    const rehydratedMenu = await openContextMenu(client, `[data-session-id="${SID}"]`);
    assert.equal(rehydratedMenu.at(-1).label, '取消置底');
    await capture(client, REHYDRATED_SCREENSHOT);

    result.sidebarScreenshot = SIDEBAR_SCREENSHOT;
    result.cardScreenshot = CARD_SCREENSHOT;
    result.rehydratedScreenshot = REHYDRATED_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ...result, resultPath: RESULT_PATH }, null, 2));
  } catch (error) {
    if (hub) console.error(hub.log().slice(-80).join('\n'));
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEST_ROOT);
    const tempPrefix = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(tempPrefix) && path.basename(resolved).startsWith('hub-session-bottom-card-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exitCode = 1;
});
