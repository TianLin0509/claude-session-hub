'use strict';

// Focused E2E: isolated Electron Hub + real committee turn progress.
// Verifies the committee dashboard becomes visible, shows the checkup stage,
// exposes diagnostics actions, and keeps the internal router prompt hidden.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ARTIFACT_DIR = 'C:\\Users\\lintian\\hub-committee-artifacts';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const DATA_DIR = path.join(os.tmpdir(), `hub-committee-dashboard-${RUN_ID}`);
const CDP_PORT = Number(process.env.COMMITTEE_DASHBOARD_CDP_PORT || 9271);
const IMAGE_PATH = process.env.COMMITTEE_DASHBOARD_IMAGE_PATH
  || 'C:\\Users\\lintian\\.claude-session-hub\\images\\20260613063944-3415ee.png';

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function logLine(file, text) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  ensure(fs.existsSync(IMAGE_PATH), `image not found: ${IMAGE_PATH}`);

  const logPath = path.join(ARTIFACT_DIR, `committee-dashboard-ui-${RUN_ID}.log`);
  const summaryPath = path.join(ARTIFACT_DIR, `committee-dashboard-ui-${RUN_ID}.json`);
  const shotPath = path.join(ARTIFACT_DIR, `committee-dashboard-ui-${RUN_ID}.png`);

  logLine(logPath, `start dashboard E2E image=${IMAGE_PATH}`);
  logLine(logPath, `dataDir=${DATA_DIR}`);

  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port: CDP_PORT,
    label: 'committee-dashboard-ui',
    extraEnv: {
      COMMITTEE_DISABLE_LLM_ROUTER: '',
      CLAUDE_HUB_MOBILE_ENABLED: '',
      CLAUDE_HUB_MOBILE_ISOLATED_OPTIN: '',
      CLAUDE_HUB_E2E: '1',
    },
  });
  let cdp = null;
  try {
    cdp = await connectFirstPage(hub);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const created = await cdp.eval(`
      (async () => {
        const { ipcRenderer } = require('electron');
        localStorage.setItem('mr-group-chat-view-mode', 'chat');
        const meeting = await ipcRenderer.invoke('create-meeting', {
          title: 'Dashboard UI E2E ${RUN_ID}',
          mode: 'committee',
          scene: 'committee',
          groupChat: true,
          groupMode: 'deliberation',
          groupRecentRawN: 5,
          slots: [
            { kind: 'deepseek', model: 'deepseek-v4-pro[1m]' },
            { kind: 'claude', model: 'claude-opus-4-8[1m]' },
            { kind: 'codex', model: 'gpt-5.5' },
            { kind: 'codex', model: 'gpt-5.5' },
            { kind: 'claude', model: 'claude-opus-4-8[1m]' },
          ],
        });
        if (typeof meetings !== 'undefined') meetings[meeting.id] = meeting;
        if (typeof renderSessionList === 'function') renderSessionList();
        const deadline = Date.now() + 5000;
        let clicked = false;
        const isOpen = () => window.MeetingRoom
          && typeof window.MeetingRoom.getActiveMeetingId === 'function'
          && window.MeetingRoom.getActiveMeetingId() === meeting.id;
        if (window.__hubE2E && typeof window.__hubE2E.selectMeeting === 'function') {
          await window.__hubE2E.selectMeeting(meeting.id);
          while (Date.now() < deadline && !isOpen()) {
            await new Promise(r => setTimeout(r, 100));
          }
          clicked = isOpen();
        }
        while (Date.now() < deadline && !clicked) {
          const item = Array.from(document.querySelectorAll('.session-item.meeting'))
            .find(el => (el.innerText || '').includes(meeting.title));
          if (item) {
            item.click();
            clicked = true;
            break;
          }
          await new Promise(r => setTimeout(r, 200));
          clicked = isOpen();
        }
        if (!isOpen() && window.MeetingRoom && typeof window.MeetingRoom.openMeeting === 'function') {
          window.MeetingRoom.openMeeting(meeting.id, meeting);
          clicked = isOpen();
        }
        return {
          id: meeting && meeting.id,
          scene: meeting && meeting.scene,
          subSessions: meeting && meeting.subSessions,
          hasSelectMeeting: typeof selectMeeting === 'function',
          hasMeetingsMap: typeof meetings !== 'undefined',
          hasHubE2E: !!window.__hubE2E,
          clicked,
        };
      })()
    `);
    ensure(created && created.id, 'create-meeting returned no id');
    ensure(created.scene === 'committee', `scene mismatch: ${created.scene}`);
    ensure(Array.isArray(created.subSessions) && created.subSessions.length === 5,
      `expected 5 subSessions, got ${created.subSessions && created.subSessions.length}`);
    logLine(logPath, `created meeting ${created.id}`);

    const initialDom = await cdp.eval(`
      (async () => {
        const started = Date.now();
        let el = null;
        while (Date.now() - started < 12000) {
          el = document.querySelector('.mr-committee-console');
          if (el) break;
          await new Promise(r => setTimeout(r, 250));
        }
        return {
          exists: !!el,
          text: el ? el.innerText : '',
          buttons: Array.from(document.querySelectorAll('.mr-committee-actions button')).map(b => b.innerText),
          groupViewMode: localStorage.getItem('mr-group-chat-view-mode'),
          meetingPanelDisplay: document.getElementById('meeting-room-panel')?.style.display || '',
          terminalPanelDisplay: document.getElementById('terminal-panel')?.style.display || '',
          emptyDisplay: document.getElementById('empty-state')?.style.display || '',
          activeMeetingId: window.MeetingRoom && typeof window.MeetingRoom.getActiveMeetingId === 'function'
            ? window.MeetingRoom.getActiveMeetingId()
            : null,
          hasHubE2E: !!window.__hubE2E,
          e2eEnv: typeof process !== 'undefined' && process.env ? process.env.CLAUDE_HUB_E2E || '' : '',
          hasGroupPanel: !!document.getElementById('mr-group-chat-panel'),
          groupPanelText: document.getElementById('mr-group-chat-panel')?.innerText.slice(0, 500) || '',
          bodyText: document.body ? document.body.innerText.slice(0, 500) : '',
        };
      })()
    `);
    ensure(initialDom.exists, `committee dashboard not rendered after open: ${JSON.stringify(initialDom)}`);
    ensure(initialDom.text.includes('投委会待命'), `initial dashboard text unexpected: ${initialDom.text}`);

    const probe = await cdp.eval(`
      (async () => {
        const { ipcRenderer } = require('electron');
        const meetingId = ${JSON.stringify(created.id)};
        const imagePath = ${JSON.stringify(IMAGE_PATH)};
        const progress = [];
        const onProgress = (_event, payload) => {
          if (payload && payload.meetingId === meetingId) progress.push(String(payload.text || ''));
        };
        ipcRenderer.on('committee-progress', onProgress);
        const input = document.getElementById('mr-input-box');
        const sendBtn = document.getElementById('mr-send-btn');
        if (!input || !sendBtn) return { progress, missingInput: !input, missingSend: !sendBtn };
        input.textContent = imagePath;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: imagePath }));
        sendBtn.click();
        const started = Date.now();
        let acceptedText = '';
        let dashboardText = '';
        let stageCount = 0;
        let seatCount = 0;
        let actionCount = 0;
        while (Date.now() - started < 2000) {
          const el = document.querySelector('.mr-committee-console');
          acceptedText = el ? el.innerText : '';
          if (acceptedText.includes('请求已收到')) break;
          await new Promise(r => setTimeout(r, 100));
        }
        while (Date.now() - started < 22000) {
          const el = document.querySelector('.mr-committee-console');
          dashboardText = el ? el.innerText : '';
          stageCount = document.querySelectorAll('.mr-committee-stage').length;
          seatCount = document.querySelectorAll('.mr-committee-seat').length;
          actionCount = document.querySelectorAll('.mr-committee-actions button').length;
          if (dashboardText.includes('持仓识别') && progress.some(x => x.includes('持仓识别') && x.includes(imagePath))) break;
          await new Promise(r => setTimeout(r, 250));
        }
        ipcRenderer.removeListener('committee-progress', onProgress);
        const visibleUserText = Array.from(document.querySelectorAll('.mr-gc-msg.mine .mr-gc-bubble')).map(el => el.innerText || '');
        return { progress, acceptedText, dashboardText, stageCount, seatCount, actionCount, visibleUserText };
      })()
    `);

    ensure(probe.acceptedText && probe.acceptedText.includes('请求已收到'),
      `dashboard did not acknowledge user send immediately: ${JSON.stringify(probe)}`);
    ensure(probe.dashboardText.includes('持仓识别'), `dashboard did not show checkup stage: ${probe.dashboardText}`);
    ensure(probe.stageCount >= 6, `expected stage rail, got ${probe.stageCount}`);
    ensure(probe.seatCount >= 5, `expected 5 seat states, got ${probe.seatCount}`);
    ensure(probe.actionCount >= 3, `expected dashboard actions, got ${probe.actionCount}`);
    ensure(probe.progress.some(x => x.includes('持仓识别') && x.includes(IMAGE_PATH)),
      `no checkup progress for image path: ${JSON.stringify(probe.progress)}`);
    ensure(!probe.progress.some(x => x.includes('立项路由')),
      `LLM router leaked into image route progress: ${JSON.stringify(probe.progress)}`);
    ensure(!probe.visibleUserText.some(x => x.includes('投委会 · 立项路由')),
      'visible chat contains internal router prompt');
    ensure(!probe.visibleUserText.some(x => x.includes('投委会 · 持仓体检 · 识别') || x.includes('请用 Read 工具读取持仓截图')),
      'visible chat contains internal checkup OCR prompt');

    const issueProbe = await cdp.eval(`
      (async () => {
        const { ipcRenderer } = require('electron');
        const meetingId = ${JSON.stringify(created.id)};
        ipcRenderer.emit('committee-progress', {}, {
          meetingId,
          text: 'MCP auth 失败：stock_news doctor 未通过，请检查认证',
        });
        const started = Date.now();
        let text = '';
        let cls = '';
        while (Date.now() - started < 5000) {
          const el = document.querySelector('.mr-committee-console');
          text = el ? el.innerText : '';
          cls = el ? el.className : '';
          if (text.includes('CLI 或 MCP 环境问题') && cls.includes('error')) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return { text, cls };
      })()
    `);
    ensure(issueProbe.cls.includes('error'),
      `committee issue should switch dashboard to error state: ${JSON.stringify(issueProbe)}`);
    ensure(issueProbe.text.includes('CLI 或 MCP 环境问题') && issueProbe.text.includes('doctor/auth'),
      `committee issue should show root-cause guidance: ${JSON.stringify(issueProbe)}`);

    const outcomeProbe = await cdp.eval(`
      (async () => {
        const { ipcRenderer } = require('electron');
        const meetingId = ${JSON.stringify(created.id)};
        const receipt = [
          '📥 决议落盘：V-E2E-DASHBOARD',
          '📊 Dashboard：C:\\\\LinDangAgent\\\\data\\\\knowledge\\\\committee\\\\dashboard.html',
          '🗂️ 案卷：C:\\\\LinDangAgent\\\\data\\\\knowledge\\\\committee\\\\cases\\\\E2E.md',
          '⚔️ 质询：未触发（E2E UI 验证）',
        ].join('\\n');
        ipcRenderer.emit('committee-progress', {}, { meetingId, text: receipt });
        const started = Date.now();
        let text = '';
        let pathButtonCount = 0;
        while (Date.now() - started < 5000) {
          const el = document.querySelector('.mr-committee-outcome');
          text = el ? el.innerText : '';
          pathButtonCount = document.querySelectorAll('[data-committee-open-path]').length;
          if (text.includes('V-E2E-DASHBOARD') && pathButtonCount >= 2) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return { text, pathButtonCount };
      })()
    `);
    ensure(outcomeProbe.text.includes('V-E2E-DASHBOARD'),
      `dashboard did not render compact outcome receipt: ${JSON.stringify(outcomeProbe)}`);
    ensure(outcomeProbe.pathButtonCount >= 2,
      `dashboard outcome did not expose artifact buttons: ${JSON.stringify(outcomeProbe)}`);

    const rawLogContent = [
      '投委会席位原始回复。',
      '```json',
      '{"rating":"A","confidence":88,"core_thesis":"E2E raw collapse"}',
      '```',
    ].join('\n');
    const rawLogProbe = await cdp.eval(`
      (async () => {
        const meetingId = ${JSON.stringify(created.id)};
        const debug = window.MeetingRoom && window.MeetingRoom.debugRenderGroupChatState;
        if (typeof debug !== 'function') return { hasHook: false };
        const state = {
          currentMode: 'idle',
          turns: [{ n: 1, mode: 'committee', by: {} }],
          summarySegments: [],
          aiStats: {},
          messages: [{
            id: 'a1-json-raw',
            role: 'assistant',
            sid: ${JSON.stringify(created.subSessions[1])},
            turnNum: 1,
            speaker: 'Claude 2',
            createdAt: Date.now(),
            content: ${JSON.stringify(rawLogContent)},
          }],
        };
        const rendered = debug(meetingId, state);
        const details = document.querySelector('.mr-committee-raw-log');
        const bubble = document.querySelector('.mr-gc-msg.ai .mr-gc-bubble');
        const rawBody = document.querySelector('.mr-committee-raw-body');
        return {
          hasHook: true,
          renderedOk: rendered && rendered.ok,
          detailsCount: document.querySelectorAll('.mr-committee-raw-log').length,
          detailsOpen: details ? details.open : null,
          summaryText: details ? details.querySelector('summary')?.innerText || '' : '',
          bubbleText: bubble ? bubble.innerText || '' : '',
          rawBodyHeight: rawBody ? rawBody.getBoundingClientRect().height : null,
        };
      })()
    `);
    ensure(rawLogProbe.hasHook && rawLogProbe.renderedOk,
      `raw log E2E render hook unavailable: ${JSON.stringify(rawLogProbe)}`);
    ensure(rawLogProbe.detailsCount === 1,
      `committee raw JSON should render as one collapsed details block: ${JSON.stringify(rawLogProbe)}`);
    ensure(rawLogProbe.detailsOpen === false,
      `committee raw JSON should be closed by default: ${JSON.stringify(rawLogProbe)}`);
    ensure(rawLogProbe.summaryText.includes('JSON 原始记录已收起'),
      `committee raw JSON summary missing: ${JSON.stringify(rawLogProbe)}`);
    ensure(!rawLogProbe.bubbleText.includes('confidence') && !rawLogProbe.bubbleText.includes('rating'),
      `committee raw JSON body leaked into default bubble text: ${JSON.stringify(rawLogProbe)}`);
    ensure(rawLogProbe.rawBodyHeight === 0,
      `committee raw JSON body should not occupy visible space while collapsed: ${JSON.stringify(rawLogProbe)}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

    const summary = {
      ok: true,
      runId: RUN_ID,
      imagePath: IMAGE_PATH,
      dataDir: DATA_DIR,
      cdpPort: CDP_PORT,
      meeting: created,
      initialDom,
      probe,
      issueProbe,
      outcomeProbe,
      rawLogProbe,
      screenshot: shotPath,
      log: logPath,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    logLine(logPath, `ok dashboardText=${JSON.stringify(probe.dashboardText.slice(0, 240))}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    await gracefulQuit(hub, { timeoutMs: 8000 });
  }
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
