'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-global-search-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const FAKE_HOME = path.join(TEMP_ROOT, 'home');
const CLAUDE_ROOT = path.join(FAKE_HOME, '.claude', 'projects');
const CODEX_ROOT = path.join(FAKE_HOME, '.codex', 'sessions');
const WORKSPACE = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'global-session-search');
const SCREENSHOT = path.join(ARTIFACT_DIR, `global-session-search-${RUN_ID}.png`);
const RESPONSIVE_SCREENSHOT = path.join(ARTIFACT_DIR, `global-session-search-responsive-${RUN_ID}.png`);
const PROGRESS_SCREENSHOT = path.join(ARTIFACT_DIR, `global-session-search-progress-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `global-session-search-${RUN_ID}.json`);
const COMMON = 'GLOBAL_FIND_COMMON';

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

async function waitFor(label, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(100);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function writeClaudeFixture() {
  const sid = 'claude-global-search-1';
  const directory = path.join(CLAUDE_ROOT, 'C--global-search-workspace');
  const transcriptPath = path.join(directory, `${sid}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  const rows = [
    {
      type: 'user', uuid: 'claude-user-global', cwd: WORKSPACE, timestamp: '2026-08-20T10:00:00Z',
      message: { content: `${COMMON} Claude 用户提问：端口冲突怎么处理？` },
    },
    {
      type: 'assistant', uuid: 'claude-answer-global', timestamp: '2026-08-20T10:00:01Z',
      message: {
        model: 'claude-sonnet', stop_reason: 'end_turn',
        content: [{ type: 'text', text: `${COMMON} CLAUDE_ANSWER_MARKER：检查端口并复用现有服务。<script>window.__SEARCH_XSS=1</script>` }],
      },
    },
  ];
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return { sid, transcriptPath };
}

function writeFakeClaudeCli() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const script = path.join(FAKE_BIN, 'fake-claude.js');
  fs.writeFileSync(script, `'use strict';\nprocess.stdout.write('FAKE_GLOBAL_SEARCH_CLAUDE_READY\\r\\n');\nprocess.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n`, 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN, 'claude.cmd'), `@echo off\r\nnode "${script}" %*\r\n`, 'utf8');
}

function writeCodexFixture() {
  const sid = '019d1111-1111-7111-8111-111111111111';
  const dayDir = path.join(CODEX_ROOT, '2026', '08', '21');
  const transcriptPath = path.join(dayDir, `rollout-2026-08-21T10-00-00-${sid}.jsonl`);
  fs.mkdirSync(dayDir, { recursive: true });
  const rows = [
    { timestamp: '2026-08-21T10:00:00Z', type: 'session_meta', payload: { id: sid, timestamp: '2026-08-21T10:00:00Z', cwd: WORKSPACE, source: 'cli', originator: 'codex_cli_rs' } },
    { timestamp: '2026-08-21T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: `${COMMON} Codex 用户提问：路径 URL 为什么识别错？` } },
    { timestamp: '2026-08-21T10:00:01.500Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: `data:image/png;base64,GLOBAL_SEARCH_BINARY_GARBAGE${'X'.repeat(9 * 1024 * 1024)}` } },
    { timestamp: '2026-08-21T10:00:02Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-08-21T10:00:03Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `${COMMON} CODEX_ANSWER_MARKER：统一 openPathInHub 路径入口。`, duration_ms: 1000 } },
    { timestamp: '2026-08-21T10:00:04Z', type: 'response_item', payload: { item: { type: 'command_execution', command: 'node tests/path-link.test.js', cwd: WORKSPACE } } },
  ];
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return { sid, transcriptPath };
}

function writeMeetingFixture() {
  const meetingId = 'meeting-global-search-1';
  const memberId = 'member-global-search-1';
  const meeting = {
    schemaVersion: 2,
    id: meetingId,
    title: '群聊专项评审标题',
    scene: 'general',
    mode: 'free',
    groupChat: true,
    groupMode: 'deliberation',
    workspace: WORKSPACE,
    workspaceLabel: '搜索测试项目',
    createdAt: Date.parse('2026-08-22T10:00:00Z'),
    updatedAt: Date.parse('2026-08-22T10:00:05Z'),
    lastMessageTime: Date.parse('2026-08-22T10:00:05Z'),
    lastCompletedAt: Date.parse('2026-08-22T10:00:05Z'),
    subSessions: [memberId],
    slotSpecs: [{ kind: 'claude' }],
    participants: [0],
    // Prevent opening this dormant fixture room from waking a real CLI: the
    // production lazy-serial path intentionally resumes members only when a
    // workflow step is actually run.
    serialWorkflow: { enabled: true, steps: [['m1']], loop: { enabled: false } },
    _cursors: { [memberId]: 0 },
    _nextIdx: 2,
    _timeline: [
      { idx: 0, sid: 'user', text: `${COMMON} 群聊用户问题：公式渲染如何验收？`, ts: Date.parse('2026-08-22T10:00:00Z') },
      { idx: 1, sid: memberId, text: `${COMMON} MEETING_ANSWER_MARKER：采用两层 guard 和浏览器验收。`, ts: Date.parse('2026-08-22T10:00:05Z') },
    ],
  };
  const meetingDir = path.join(DATA_DIR, 'meetings');
  fs.mkdirSync(meetingDir, { recursive: true });
  fs.writeFileSync(path.join(meetingDir, `${meetingId}.json`), JSON.stringify(meeting), 'utf8');
  return { meeting, memberId };
}

function writeHubState(claude, codex, meetingFixture) {
  const sessions = [
    {
      schemaVersion: 1, hubId: 'hub-claude-search', kind: 'claude', title: 'Claude 标题搜索样本',
      cwd: WORKSPACE, ccSessionId: claude.sid, transcriptPath: claude.transcriptPath,
      lastMessageTime: Date.parse('2026-08-20T10:00:01Z'), updatedAt: Date.parse('2026-08-20T10:00:01Z'),
    },
    {
      schemaVersion: 1, hubId: 'hub-codex-search', kind: 'codex', title: 'Codex 路径修复标题',
      cwd: WORKSPACE, codexSid: codex.sid, codexSessionsRoot: CODEX_ROOT, transcriptPath: codex.transcriptPath,
      lastMessageTime: Date.parse('2026-08-21T10:00:04Z'), updatedAt: Date.parse('2026-08-21T10:00:04Z'),
    },
    {
      schemaVersion: 1, hubId: meetingFixture.memberId, kind: 'claude', title: '群聊 Claude 评审员',
      cwd: WORKSPACE, meetingId: meetingFixture.meeting.id,
      lastMessageTime: Date.parse('2026-08-22T10:00:05Z'), updatedAt: Date.parse('2026-08-22T10:00:05Z'),
    },
  ];
  const state = {
    version: 1,
    cleanShutdown: true,
    sessions,
    meetings: [meetingFixture.meeting],
    immersiveByMeeting: {},
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

async function setSearch(client, query) {
  await client.eval(`(() => {
    const input = document.getElementById('search-query');
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function clickFilter(client, selector) {
  await client.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function waitSearchState(client, predicate, label) {
  return waitFor(label, async () => {
    const state = await client.eval('window.__hubE2E.globalSessionSearch.state()');
    return predicate(state) ? state : null;
  }, 10_000);
}

(async () => {
  const port = await reservePort();
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port };
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFakeClaudeCli();
    const claude = writeClaudeFixture();
    const codex = writeCodexFixture();
    const meetingFixture = writeMeetingFixture();
    writeHubState(claude, codex, meetingFixture);

    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'global-session-search',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: FAKE_HOME,
        DEEPSEEK_API_KEY: '',
        USERPROFILE: FAKE_HOME,
        HOME: FAKE_HOME,
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: CLAUDE_ROOT,
        HUB_SESSION_SEARCH_CODEX_ROOTS: CODEX_ROOT,
        HUB_SESSION_SEARCH_REFRESH_TTL_MS: '500',
        HUB_SESSION_SEARCH_PREWARM: '1',
        HUB_SESSION_SEARCH_PREWARM_DELAY_MS: '250',
        CLAUDE_HUB_NO_EFFORT_MAX: '1',
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await waitFor('renderer CDP page', async () => {
      try { return await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || '')); }
      catch { return null; }
    });
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
    await client.eval(`(() => {
      window.__GLOBAL_SEARCH_CONSOLE_ERRORS = [];
      const record = value => window.__GLOBAL_SEARCH_CONSOLE_ERRORS.push(String(value && (value.stack || value.message) || value));
      window.addEventListener('error', event => record(event.error || event.message));
      window.addEventListener('unhandledrejection', event => record(event.reason));
      const originalError = console.error.bind(console);
      console.error = (...args) => { record(args.map(String).join(' ')); originalError(...args); };
    })()`);
    await waitFor('global search UI bridge', () => client.eval(`!!(window.__hubE2E && window.__hubE2E.globalSessionSearch)`));
    result.startupPrewarm = await waitFor('startup search prewarm', async () => {
      const status = await client.eval(`require('electron').ipcRenderer.invoke('get-session-search-status')`);
      return status && status.ready && status.index && status.index.sessions >= 3 ? status : null;
    }, 45_000);
    assert.equal(result.startupPrewarm.ready, true, JSON.stringify(result.startupPrewarm));
    result.explicitRefresh = await client.eval(`require('electron').ipcRenderer.invoke('refresh-session-search', { force: true })`);
    assert.equal(result.explicitRefresh.ready, true, JSON.stringify(result.explicitRefresh));
    result.indexStatus = await waitFor('search index ready', async () => {
      const status = await client.eval(`require('electron').ipcRenderer.invoke('get-session-search-status')`);
      return status && status.ready && status.index && status.index.sessions >= 3 ? status : null;
    }, 45_000);
    assert.ok(result.indexStatus.index.documents >= 9, JSON.stringify(result.indexStatus));
    result.directAnswerQuery = await client.eval(`require('electron').ipcRenderer.invoke('search-past-sessions', {
      query: 'CLAUDE_ANSWER_MARKER', providers: ['claude'], scopes: ['assistant'], limit: 50
    })`);
    assert.equal(result.directAnswerQuery.totalSessions, 1, JSON.stringify(result.directAnswerQuery));
    result.binaryGarbageQuery = await client.eval(`require('electron').ipcRenderer.invoke('search-past-sessions', {
      query: 'GLOBAL_SEARCH_BINARY_GARBAGE', providers: ['codex'], limit: 50
    })`);
    assert.equal(result.binaryGarbageQuery.totalSessions, 0, JSON.stringify(result.binaryGarbageQuery));

    await client.eval(`document.getElementById('btn-global-search').click()`);
    await waitFor('search dialog visible', () => client.eval(`document.getElementById('search-modal').style.display === 'flex'`));
    result.progress = await client.eval(`(() => {
      window.__hubE2E.globalSessionSearch.renderStatus({
        phase:'indexing', ready:false, refreshing:true,
        indexedSources:1032, totalSources:2181,
        index:{ sessions:900, documents:12000, providers:{} }
      });
      const root = document.getElementById('session-search-progress');
      const track = document.getElementById('session-search-progress-track');
      const fill = document.getElementById('session-search-progress-fill');
      return {
        hidden:root.hidden,
        role:track.getAttribute('role'),
        now:track.getAttribute('aria-valuenow'),
        valueText:track.getAttribute('aria-valuetext'),
        width:fill.style.width,
        percent:document.getElementById('session-search-progress-percent').textContent,
        detail:document.getElementById('session-search-progress-detail').textContent,
        refreshDisabled:document.getElementById('session-search-index-status').disabled,
      };
    })()`);
    assert.deepEqual(result.progress, {
      hidden:false,
      role:'progressbar',
      now:'47',
      valueText:'正在解析会话，已完成 1032/2181，47%',
      width:'47%',
      percent:'47%',
      detail:'正在解析会话 · 1032/2181 个来源 · 可继续使用 AI Hub',
      refreshDisabled:true,
    });
    const progressShot = await client.send('Page.captureScreenshot', { format:'png', fromSurface:true });
    fs.writeFileSync(PROGRESS_SCREENSHOT, Buffer.from(progressShot.data, 'base64'));
    result.progressScreenshot = PROGRESS_SCREENSHOT;
    await client.eval(`window.__hubE2E.globalSessionSearch.renderStatus(${JSON.stringify(result.indexStatus)})`);
    await setSearch(client, COMMON);
    result.all = await waitSearchState(client, state => state.query === COMMON && state.resultCount === 3, 'three provider results');
    result.providerLabels = await client.eval(`[...document.querySelectorAll('.session-search-result-provider')].map(node => node.textContent.trim())`);
    assert.deepEqual(new Set(result.providerLabels), new Set(['Claude', 'Codex', '群聊']));
    result.deepseekZeroHidden = await client.eval(`(() => {
      const button = document.querySelector('#session-search-provider-filters [data-provider="deepseek"]');
      return button.hidden && getComputedStyle(button).display === 'none';
    })()`);
    assert.equal(result.deepseekZeroHidden, true);
    await waitFor('preview loaded', () => client.eval(`!!document.querySelector('#session-search-preview h3')`));
    result.preview = await client.eval(`({
      title: document.querySelector('#session-search-preview h3').textContent,
      matchCount: document.querySelectorAll('#session-search-preview .session-search-preview-turn.match').length,
      xss: window.__SEARCH_XSS || 0,
    })`);
    assert.equal(result.preview.matchCount, 1);
    assert.equal(result.preview.xss, 0, 'transcript HTML must render as inert text');

    await clickFilter(client, '#session-search-provider-filters [data-provider="codex"]');
    result.codexOnly = await waitSearchState(client, state => state.activeProvider === 'codex' && state.resultCount === 1, 'Codex-only filter');
    result.codexPreview = await waitSearchState(client, state => /Codex/.test(state.previewTitle), 'Codex preview');

    await clickFilter(client, '#session-search-provider-filters [data-provider="meeting"]');
    result.meetingOnly = await waitSearchState(client, state => state.activeProvider === 'meeting' && state.resultCount === 1, 'meeting-only filter');
    result.meetingPreview = await waitSearchState(client, state => /群聊专项评审/.test(state.previewTitle), 'meeting preview');

    await clickFilter(client, '#session-search-provider-filters [data-provider="all"]');
    await clickFilter(client, '[data-scope="assistant"]');
    await setSearch(client, 'CLAUDE_ANSWER_MARKER');
    result.answerOnly = await waitSearchState(client, state => state.activeScope === 'assistant' && state.resultCount === 1, 'answer-only filter');
    result.answerPreview = await waitSearchState(client, state => /Claude/.test(state.previewTitle), 'answer preview');

    await clickFilter(client, '[data-scope="user"]');
    result.userNoMatch = await waitSearchState(client, state => state.activeScope === 'user' && state.resultCount === 0, 'user scope excludes assistant marker');

    await clickFilter(client, '[data-scope="title"]');
    await setSearch(client, '群聊专项评审标题');
    result.titleOnly = await waitSearchState(client, state => state.activeScope === 'title' && state.resultCount === 1, 'title-only search');
    result.titlePreview = await waitSearchState(client, state => /群聊专项评审标题/.test(state.previewTitle), 'title preview');

    await clickFilter(client, '[data-scope="all"]');
    await setSearch(client, COMMON);
    await waitSearchState(client, state => state.resultCount === 3, 'reset all results');
    await client.eval(`document.getElementById('search-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    result.keyboard = await waitSearchState(client, state => state.activeIndex === 1, 'keyboard next result');

    const timings = await client.eval(`(async () => {
      const ipc = require('electron').ipcRenderer;
      const samples = [];
      for (let i = 0; i < 24; i++) {
        const start = performance.now();
        const response = await ipc.invoke('search-past-sessions', { query: ${JSON.stringify(COMMON)}, limit: 50 });
        samples.push({ wall: performance.now() - start, queryMs: response.queryMs, total: response.totalSessions });
      }
      return samples;
    })()`);
    const sortedWall = timings.map(sample => sample.wall).sort((a, b) => a - b);
    result.performance = {
      p50WallMs: sortedWall[Math.floor(sortedWall.length * .5)],
      p95WallMs: sortedWall[Math.floor(sortedWall.length * .95)],
      maxQueryMs: Math.max(...timings.map(sample => sample.queryMs)),
    };
    assert.ok(result.performance.p95WallMs < 120, JSON.stringify(result.performance));
    assert.ok(timings.every(sample => sample.total === 3));

    const desktop = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT, Buffer.from(desktop.data, 'base64'));

    await client.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 820, deviceScaleFactor: 1, mobile: false });
    await _waitMs(120);
    result.responsive = await client.eval(`({
      width: innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      dialogWidth: document.querySelector('.session-search-dialog').getBoundingClientRect().width,
      visible: document.getElementById('search-modal').style.display === 'flex',
    })`);
    assert.equal(result.responsive.bodyScrollWidth, result.responsive.width);
    assert.ok(result.responsive.dialogWidth <= result.responsive.width);
    assert.equal(result.responsive.visible, true);
    const responsive = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(RESPONSIVE_SCREENSHOT, Buffer.from(responsive.data, 'base64'));

    await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await _waitMs(120);
    result.mobile = await client.eval(`(() => {
      window.__hubE2E.globalSessionSearch.renderStatus({
        phase:'indexing', ready:false, refreshing:true,
        indexedSources:1032, totalSources:2181,
        index:{ sessions:900, documents:12000, providers:{} }
      });
      const dialog = document.querySelector('.session-search-dialog').getBoundingClientRect();
      const progress = document.getElementById('session-search-progress').getBoundingClientRect();
      return {
        width:innerWidth,
        bodyScrollWidth:document.body.scrollWidth,
        dialogWidth:dialog.width,
        contentColumns:getComputedStyle(document.querySelector('.session-search-content')).gridTemplateColumns,
        progressInside:progress.left >= dialog.left && progress.right <= dialog.right + 1,
        progressWidth:progress.width,
      };
    })()`);
    assert.equal(result.mobile.bodyScrollWidth, result.mobile.width);
    assert.ok(result.mobile.dialogWidth <= result.mobile.width);
    assert.equal(result.mobile.progressInside, true);
    assert.ok(result.mobile.progressWidth > 0 && result.mobile.progressWidth <= result.mobile.dialogWidth);
    await client.eval(`window.__hubE2E.globalSessionSearch.renderStatus(${JSON.stringify(result.indexStatus)})`);

    await clickFilter(client, '#session-search-provider-filters [data-provider="meeting"]');
    await setSearch(client, COMMON);
    await waitSearchState(client, state => state.activeProvider === 'meeting' && state.resultCount === 1 && /群聊专项评审/.test(state.previewTitle), 'meeting result before open');
    await client.eval(`[...document.querySelectorAll('.session-search-action')].find(button => button.textContent === '打开群聊').click()`);
    result.openMeeting = await waitFor('search result opens owning meeting', async () => {
      const state = await client.eval(`({
        modalOpen: document.getElementById('search-modal').style.display === 'flex',
        activeMeetingId: window.__hubE2E.getActiveMeetingId(),
      })`);
      return !state.modalOpen && state.activeMeetingId === meetingFixture.meeting.id ? state : null;
    });

    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 960, deviceScaleFactor: 1, mobile: false });
    await client.eval(`document.getElementById('btn-global-search').click()`);
    await waitFor('search dialog reopened', () => client.eval(`document.getElementById('search-modal').style.display === 'flex'`));
    await clickFilter(client, '#session-search-provider-filters [data-provider="claude"]');
    await clickFilter(client, '[data-scope="assistant"]');
    await setSearch(client, 'CLAUDE_ANSWER_MARKER');
    await waitSearchState(client, state => state.activeProvider === 'claude' && state.activeScope === 'assistant' && state.resultCount === 1 && /Claude/.test(state.previewTitle), 'Claude result before precise open');
    await client.eval(`[...document.querySelectorAll('.session-search-action')].find(button => button.textContent === '定位到命中').click()`);
    result.openClaude = await waitFor('precise Claude result opens card at matching event', async () => {
      const state = await client.eval(`({
        modalOpen: document.getElementById('search-modal').style.display === 'flex',
        terminalIds: window.__hubE2E.terminalCacheStats().ids,
        matchMounted: !!document.querySelector('.turn-card[data-turn-id="claude-answer-global"]'),
        matchFocused: !!document.querySelector('.turn-card[data-turn-id="claude-answer-global"].global-search-focus'),
      })`);
      return !state.modalOpen && state.terminalIds.includes('hub-claude-search') && state.matchMounted ? state : null;
    }, 20_000);

    const databasePath = path.join(DATA_DIR, 'cache', 'session-search-v3.sqlite');
    result.cacheExists = fs.existsSync(databasePath);
    result.databaseBytes = result.cacheExists ? fs.statSync(databasePath).size : 0;
    assert.equal(result.cacheExists, true);
    assert.ok(result.databaseBytes > 0);
    result.consoleErrors = await client.send('Runtime.evaluate', {
      expression: 'window.__GLOBAL_SEARCH_CONSOLE_ERRORS || []', returnByValue: true,
    }).then(response => response.result.value || []);
    assert.deepEqual(result.consoleErrors, []);
    result.screenshot = SCREENSHOT;
    result.responsiveScreenshot = RESPONSIVE_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, resultPath: RESULT_PATH, ...result }, null, 2));
    const keepOpenMs = Math.min(90_000, Math.max(0, Number(process.env.HUB_GLOBAL_SEARCH_KEEP_OPEN_MS) || 0));
    if (keepOpenMs > 0) {
      console.log(`PLAYWRIGHT_CLI_READY=http://127.0.0.1:${port}`);
      await _waitMs(keepOpenMs);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    if (client) {
      try {
        const diagnostics = await client.eval(`(() => ({
          readyState: document.readyState,
          rendererScripts: [...document.scripts].map(s => s.src).filter(Boolean).slice(-8),
          bridgeKeys: Object.keys(window.__hubE2E || {}),
          globalSearchState: window.__hubE2E && window.__hubE2E.globalSessionSearch
            ? window.__hubE2E.globalSessionSearch.state()
            : null,
          providerButtons: [...document.querySelectorAll('#session-search-provider-filters [data-provider]')].map(button => ({
            provider: button.dataset.provider,
            active: button.classList.contains('active'),
            pressed: button.getAttribute('aria-pressed'),
            text: button.textContent.trim(),
          })),
          summary: document.getElementById('session-search-result-summary')?.textContent || '',
          hasSearchModal: !!document.getElementById('search-modal'),
          hasSearchButton: !!document.getElementById('btn-global-search'),
          hasSessionList: !!document.getElementById('session-list'),
          bodyText: (document.body && document.body.innerText || '').slice(0, 500),
        }))()`);
        console.error('RENDERER_DIAGNOSTICS', JSON.stringify(diagnostics, null, 2));
      } catch (diagnosticError) {
        console.error('RENDERER_DIAGNOSTICS_FAILED', diagnosticError.message);
      }
    }
    if (hub) console.error(hub.log().slice(-100).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { await client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    await _waitMs(1000);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-global-search-')) {
      try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); }
      catch (cleanupError) { console.warn('cleanup skipped:', cleanupError.message); }
    }
  }
})();
