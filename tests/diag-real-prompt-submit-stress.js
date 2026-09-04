'use strict';

// 长 prompt 提交可靠性压力测试（2026-09-03）。
//
// 覆盖被修的那条失败模式的完整矩阵：
//   surface  ∈ {normal（普通会话下方浮动输入框）, groupchat（群聊 composer）}
//   provider ∈ {claude, codex}
//   size     ∈ 递增行数（默认 60 / 220 / 600 行）——「越长越容易卡」是这个 bug 的特征，
//              所以体积必须是自变量，只测一个尺寸证明不了什么。
//
// 判据（三条全过才算这一格通过）：
//   1. sendStatus ∈ {ok, auto_recovered}，绝不能是 stuck
//   2. 拿到语义确认（Claude UserPromptSubmit / Codex task_started），
//      且 enterAttempts ≤ 2（不能靠狂发回车蒙对）
//   3. AI 真的回了带 marker 的那一行 —— 端到端确认 prompt 完整进去了
//   附加：普通会话不得出现 .fi-stuck 提示条
//
// 用真凭证跑真 CLI，会产生真实用量。只起隔离实例、只关自己起的 PID。
//
// 用法：
//   node tests/diag-real-prompt-submit-stress.js
//   $env:HUB_STRESS_PROVIDERS='codex'; $env:HUB_STRESS_SIZES='600'; node tests/diag-real-prompt-submit-stress.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const REPO = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const ROOT = path.join(os.tmpdir(), `hub-prompt-submit-stress-${process.pid}-${Date.now()}`);
const WORKSPACE = path.join(ROOT, 'workspace');
const SOURCE_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ISOLATED_CODEX_HOME = path.join(ROOT, 'codex-home');
const SOURCE_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ISOLATED_CLAUDE_CONFIG_DIR = path.join(ROOT, 'claude-config');
const EVIDENCE_DIR = path.join(REPO, 'output', 'playwright', 'prompt-submit-stress');
const RESULT_JSON = path.join(EVIDENCE_DIR, `20260903-ai-hub-prompt-submit-stress-${STAMP}.json`);
const SCREENSHOT = path.join(EVIDENCE_DIR, `20260903-ai-hub-prompt-submit-stress-${STAMP}.png`);

const PROVIDERS = String(process.env.HUB_STRESS_PROVIDERS || 'claude,codex')
  .split(',').map(x => x.trim()).filter(Boolean);
const SURFACES = String(process.env.HUB_STRESS_SURFACES || 'normal,groupchat')
  .split(',').map(x => x.trim()).filter(Boolean);
const SIZES = String(process.env.HUB_STRESS_SIZES || '60,220,600')
  .split(',').map(x => Number(x.trim())).filter(n => Number.isFinite(n) && n > 0);
const TRIALS = Math.max(1, Math.min(5, Number(process.env.HUB_STRESS_TRIALS) || 1));
const CLAUDE_MODEL = process.env.HUB_STRESS_CLAUDE_MODEL || 'claude-opus-5';
const CODEX_MODEL = process.env.HUB_STRESS_CODEX_MODEL || 'gpt-5.6-sol';

function prepareIsolatedCodexHome() {
  fs.mkdirSync(ISOLATED_CODEX_HOME, { recursive: true });
  const authPath = path.join(SOURCE_CODEX_HOME, 'auth.json');
  if (!fs.existsSync(authPath)) throw new Error(`Codex auth missing: ${authPath}`);
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    const source = path.join(SOURCE_CODEX_HOME, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(ISOLATED_CODEX_HOME, name));
  }
}

// 只搬凭证与 Hub 自己的生命周期 hook。别把用户的 Stop hook / 插件目录复制进来 ——
// 那些会拖慢启动甚至把整个 marketplace 的 .git 克隆进 Temp（沿用 diag-real-pty-runtime-state 的做法）。
function prepareIsolatedClaudeConfig() {
  fs.mkdirSync(ISOLATED_CLAUDE_CONFIG_DIR, { recursive: true });
  const credentials = path.join(SOURCE_CLAUDE_CONFIG_DIR, '.credentials.json');
  if (!fs.existsSync(credentials)) throw new Error(`Claude credentials missing: ${credentials}`);
  fs.copyFileSync(credentials, path.join(ISOLATED_CLAUDE_CONFIG_DIR, '.credentials.json'));
  const settingsPath = path.join(SOURCE_CLAUDE_CONFIG_DIR, 'settings.json');
  const isolatedSettings = { hooks: {} };
  if (fs.existsSync(settingsPath)) {
    const source = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const key of ['permissions', 'skipDangerousModePermissionPrompt', 'permissionMode',
      'alwaysThinkingEnabled', 'disableAgentView', 'tui', 'theme']) {
      if (source[key] !== undefined) isolatedSettings[key] = source[key];
    }
    for (const eventName of ['UserPromptSubmit', 'Stop', 'StopFailure']) {
      const entries = source.hooks && source.hooks[eventName];
      const list = Array.isArray(entries) ? entries : (entries ? [entries] : []);
      const filtered = list.map(entry => ({
        ...entry,
        hooks: (Array.isArray(entry && entry.hooks) ? entry.hooks : [])
          .filter(hook => /session-hub-hook\.py/i.test(String(hook && hook.command || ''))),
      })).filter(entry => entry.hooks.length > 0);
      if (filtered.length > 0) isolatedSettings.hooks[eventName] = filtered;
    }
  }
  fs.writeFileSync(path.join(ISOLATED_CLAUDE_CONFIG_DIR, 'settings.json'),
    JSON.stringify(isolatedSettings, null, 2), 'utf8');

  // 没有这份 .claude.json，Claude CLI 在全新 config 目录下会停在 onboarding 向导，
  //   永远画不出 'shift+tab' 那条 footer —— 表现就是 startup frame 超时。
  //   只搬身份与"已完成引导"这类状态，projects 清空（避免带进真实工作区的信任记录）。
  const statePath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(statePath)) return;
  const sourceState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const isolatedState = {
    autoUpdates: false,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: sourceState.lastOnboardingVersion || '2.1.251',
    installMethod: sourceState.installMethod || 'native',
    projects: {},
    remoteControlAtStartup: false,
    officialMarketplaceAutoInstallAttempted: true,
    officialMarketplaceAutoInstalled: true,
  };
  for (const key of [
    'userID', 'anonymousId', 'machineID', 'oauthAccount', 'clientDataCacheSlots',
    'hasAvailableSubscription', 'modelAccessCache', 'orgModelDefaultCache',
    'additionalModelOptionsCache', 'additionalModelCostsCache',
    'hasSeenAutoModeEntryWarning', 'hasResetAutoModeOptInForDefaultOffer',
    'autoPermissionsNotificationCount', 'skipDangerousModePermissionPrompt',
    'unpinFable5LaunchEffort', 'lastReleaseNotesSeen', 'hasSeenUltraplanTerms',
    'seenNotifications', 'announcementImpressions', 'remoteDialogSeen',
  ]) {
    if (sourceState[key] !== undefined) isolatedState[key] = sourceState[key];
  }
  fs.writeFileSync(path.join(ISOLATED_CLAUDE_CONFIG_DIR, '.claude.json'),
    JSON.stringify(isolatedState, null, 2), 'utf8');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(250);
  }
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

// 中文 + 长行：中文走的是与 ASCII 不同的字节路径（UTF-8 三字节），
// 而这个 bug 的现场就是中文长 prompt，测试载荷必须同构。
function buildPrompt(marker, lines) {
  const body = Array.from({ length: lines }, (_v, i) =>
    `压力行 ${String(i + 1).padStart(4, '0')}：长提示完整性校验 ${'内容填充 '.repeat(5)}${i}`);
  return [
    `不要调用任何工具。读完下面全部 ${lines} 行后，只回复这一行，不要解释、不要 Markdown：${marker}`,
    ...body,
    `以上共 ${lines} 行。只回复：${marker}`,
  ].join('\n');
}

// 在页面里挂一层录音：包住真实的 ipcRenderer.invoke，记录 session:send-prompt 的
// 返回值。这样测的仍然是生产代码路径本身，只是把它的结论旁录一份出来。
const INSTALL_RECORDER = `(() => {
  if (window.__stressRec) return true;
  const ipc = require('electron').ipcRenderer;
  const orig = ipc.invoke.bind(ipc);
  window.__stressRec = [];
  ipc.invoke = (channel, ...args) => {
    const p = orig(channel, ...args);
    if (channel === 'session:send-prompt' || channel === 'session:resend-prompt') {
      const at = Date.now();
      p.then(
        result => window.__stressRec.push({ channel, at, sessionId: args[0] && args[0].sessionId, len: (args[0] && args[0].text || '').length, result }),
        error => window.__stressRec.push({ channel, at, error: String(error && error.message || error) }),
      );
    }
    return p;
  };
  return true;
})()`;

// Claude 首启会弹若干个挡在输入框前面的选择框。每一个都要认出来并回答，
//   否则永远等不到就绪 —— 第一版跑出的 "timeout claude startup frame" 就是卡在
//   「Allow external CLAUDE.md file imports?」这一屏。
//   'down' = 需要先把光标移到第二项（auto mode 要选"不设为默认"）；
//   'enter' = 默认高亮项就是我们要的（外部 import 默认停在 "No, disable"）。
const STARTUP_DIALOGS = [
  { needle: 'Make auto mode your default permission mode?', key: 'down' },
  { needle: 'Allow external CLAUDE.md file imports?', key: 'enter' },
  { needle: 'Do you trust the files in this folder?', key: 'enter' },
  { needle: 'Do you trust the contents of this directory', key: 'enter' },
];

async function answerStartupDialogs(client, id, provider, readyPattern, timeoutMs = 90000) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let state;
    try {
      state = await waitFor(`${provider} startup frame`, () => client.eval(`(() => {
        const screen = window.__hubE2E.terminalLiveScreenText(${JSON.stringify(id)});
        const dialogs = ${JSON.stringify(STARTUP_DIALOGS)};
        const hit = dialogs.find(d => screen.includes(d.needle));
        if (hit) return 'dialog:' + hit.key;
        if (screen.includes(${JSON.stringify(readyPattern)})) return 'ready';
        return '';
      })()`), timeoutMs);
    } catch (error) {
      // 没画面就没法判断卡在哪一屏（信任对话框？登录？主题选择？）。
      // 把真实终端内容带出来，别让失败只剩一句 timeout。
      const screen = await client.eval(
        `window.__hubE2E.terminalBufferText(${JSON.stringify(id)}, 120)`,
      ).catch(() => '<unavailable>');
      throw new Error(`${error.message}\n--- ${provider} terminal screen ---\n${screen}\n--- end ---`);
    }
    if (state === 'ready') return true;
    const needsDown = state === 'dialog:down';
    await client.eval(`(() => {
      const id = ${JSON.stringify(id)};
      const needsDown = ${JSON.stringify(needsDown)};
      if (needsDown) ipcRenderer.send('terminal-input', { sessionId: id, data: '\\x1b[B' });
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: id, data: '\\r' }), needsDown ? 150 : 40);
      return true;
    })()`);
    await _waitMs(1500);
  }
  return false;
}

async function ensureNormalSession(client, provider) {
  const opts = provider === 'codex'
    ? { model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' }
    : { model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'lean', fastMode: false };
  const created = await client.eval(`window.WorkspaceController.createSession(${JSON.stringify(provider)}, {
    cwd: ${JSON.stringify(WORKSPACE)},
    opts: ${JSON.stringify(opts)},
  }).then(s => ({ id: s.id }))`);
  const id = created.id;
  await waitFor(`${provider} renderer session`, () => client.eval(`sessions.has(${JSON.stringify(id)})`), 30000);
  await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(id)}, { forceScrollBottom: true })`);
  const readyPattern = provider === 'codex' ? 'Context ' : 'shift+tab';

  await answerStartupDialogs(client, id, provider, readyPattern);
  await _waitMs(900);
  return id;
}

// HUB_STRESS_LEGACY=1：逐字节复现修复前那条开环时序 —— bracketed paste 一次性写下去，
//   然后在 700/900/1100ms 三个固定时刻盲发 \r，发完不管。用来做前后对照，
//   证明这个修复确实改变了结果，而不是测试本身太宽松。
const LEGACY_MODE = process.env.HUB_STRESS_LEGACY === '1';
const LEGACY_ANSWER_TIMEOUT_MS = Math.max(30000, Number(process.env.HUB_STRESS_LEGACY_TIMEOUT_MS) || 150000);

// 判"答上来了"必须查 transcript，不能在终端文字里搜 marker：
//   marker 本身就写在 prompt 里，短 prompt 被 CLI 原样回显时屏幕上立刻就有它 ——
//   那样测出来的是"回显发生了"，不是"AI 回答了"，属于假阳性。
//   get-last-assistant-text 走 transcriptTap，是 provider 侧的权威内容。
function answeredExpr(sid, marker) {
  return `require('electron').ipcRenderer.invoke('get-last-assistant-text', ${JSON.stringify(sid)})
    .then(text => String(text || '').includes(${JSON.stringify(marker)}))`;
}

async function sendLegacyOpenLoop(client, sid, prompt) {
  await client.eval(`(() => {
    const ipc = require('electron').ipcRenderer;
    const id = ${JSON.stringify(sid)};
    const text = ${JSON.stringify(prompt)};
    ipc.send('terminal-input', { sessionId: id, data: '\\x1b[200~' + text + '\\x1b[201~' });
    setTimeout(() => ipc.send('terminal-input', { sessionId: id, data: '\\r' }), 700);
    setTimeout(() => ipc.send('terminal-input', { sessionId: id, data: '\\r' }), 900);
    setTimeout(() => ipc.send('terminal-input', { sessionId: id, data: '\\r' }), 1100);
    return true;
  })()`);
}

async function runNormalTrial(client, { sid, provider, marker, prompt }) {
  const startedAt = Date.now();
  const before = await client.eval('window.__stressRec.length');

  if (LEGACY_MODE) {
    await sendLegacyOpenLoop(client, sid, prompt);
    let answered = false;
    try {
      answered = !!await waitFor(`${provider} legacy answer`,
        () => client.eval(answeredExpr(sid, marker)), LEGACY_ANSWER_TIMEOUT_MS);
    } catch { answered = false; }
    // 没答上来时，看屏幕上是不是正卡着折叠标记 —— 那就是"内容进了输入框但没提交"的现场。
    const screen = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sid)})`);
    const pasteMarker = /\[+(?:Pasted|paste)(?:\s+Content)?(?:\s+text)?\s*(?:#\d+)?\s*\+?\d+\s*(?:chars|lines)\]+/i.exec(screen);
    return {
      legacy: true,
      answered,
      pasteMarkerOnScreen: pasteMarker ? pasteMarker[0] : null,
      durationMs: Date.now() - startedAt,
      record: { result: { legacy: true } },
      stuckBanner: false,
    };
  }

  // 走真实用户路径：往浮动输入框里填字 → 触发 input 事件 → 按 Enter。
  // 不直接调 IPC，否则测的就不是被改的那条路了。
  await client.eval(`(() => {
    const box = document.querySelector('.terminal-panel .floating-input-box');
    if (!box) throw new Error('floating input box missing');
    box.focus();
    box.textContent = ${JSON.stringify(prompt)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);

  const record = await waitFor(`${provider} normal send result`, () => client.eval(
    `(() => { const r = window.__stressRec.slice(${Number(before)}).find(x => x.channel === 'session:send-prompt'); return r || null; })()`,
  ), 120000);

  // 答不上来时不要直接抛 —— 那会把 sendStatus 这条最关键的证据一起丢掉。
  // 先记下来，让调用方带着完整上下文去判。
  let answered = false;
  let answerError = null;
  try {
    answered = !!await waitFor(`${provider} normal answer`,
      () => client.eval(answeredExpr(sid, marker)), 300000);
  } catch (error) {
    answerError = error.message;
  }

  const stuckBanner = await client.eval("!!document.querySelector('.terminal-panel .fi-stuck')");
  const screen = answered ? null
    : await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sid)})`).catch(() => null);
  return { record, answered, answerError, stuckBanner, screen, durationMs: Date.now() - startedAt };
}

async function setupGroupMeeting(client, provider) {
  const slot = provider === 'codex'
    ? { index: 0, kind: 'codex', model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' }
    : { index: 0, kind: 'claude', model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'lean' };
  const meeting = await client.eval(`require('electron').ipcRenderer.invoke('create-meeting', ${JSON.stringify({
    mode: 'general',
    scene: 'general',
    title: `Prompt submit stress (${provider})`,
    groupChat: true,
    groupMode: 'deliberation',
    groupRecentRawN: 5,
    participants: [0],
    workspace: WORKSPACE,
    workspaceLabel: `prompt-submit-stress-${provider}`,
    workspaceDraft: true,
    slots: [slot],
  })})`);
  assert.ok(meeting && meeting.id && meeting.subSessions && meeting.subSessions.length === 1,
    `meeting creation failed for ${provider}`);
  const sid = meeting.subSessions[0];
  await waitFor(`${provider} group renderer session`, () => client.eval(`sessions.has(${JSON.stringify(sid)})`), 40000);

  // 群聊成员同样会撞上首启对话框（外部 CLAUDE.md import / auto mode / 目录信任），
  //   而 cliReadyDetector 只会一直判 not-ready，不会替你按键。
  //   必须先把成员会话选出来让它的终端真正挂载 —— 群聊面板只画卡片，
  //   terminalLiveScreenText 在未挂载的会话上返回空串，对话框永远没人按。
  const memberReadyPattern = provider === 'codex' ? 'Context ' : 'shift+tab';
  await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)}, { forceScrollBottom: true })`);
  await answerStartupDialogs(client, sid, `${provider}-group`, memberReadyPattern, 120000);

  await client.eval(`(() => {
    const meeting = ${JSON.stringify(meeting)};
    meetings[meeting.id] = meeting;
    if (!window.__stressGroup) {
      window.__stressGroup = { acks: [], stuck: [] };
      const ipc = require('electron').ipcRenderer;
      ipc.on('groupchat-send-ack', (_e, p) => window.__stressGroup.acks.push(p));
      ipc.on('groupchat-send-stuck', (_e, p) => window.__stressGroup.stuck.push(p));
    }
    window.MeetingRoom.openMeeting(meeting.id, meeting, { forceScrollBottom: true });
    return true;
  })()`);
  const ready = await waitFor(`${provider} group member ready`, () => client.eval(
    `require('electron').ipcRenderer.invoke('cli-ready-status', ${JSON.stringify(sid)})`,
  ), 120000);
  assert.equal(ready, true, `${provider} group member never became ready`);
  return { meeting, sid };
}

async function runGroupTrial(client, { meeting, sid, provider, marker, prompt }) {
  const startedAt = Date.now();
  // ack 和 stuck 都必须记基线。只记 ack 的话，前一格留下的 stuck 事件会被
  // 后面每一格重复计入，把好的格子也判成失败（这条自己踩过）。
  const beforeAcks = await client.eval('window.__stressGroup.acks.length');
  const beforeStuck = await client.eval('window.__stressGroup.stuck.length');
  await client.eval(`(() => {
    const box = document.getElementById('mr-input-box');
    if (!box) throw new Error('group composer missing');
    box.textContent = ${JSON.stringify(prompt)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('mr-send-btn').click();
    return true;
  })()`);

  // 答不上来时不要直接抛 —— 那会把 sendStatus / ack 这些最关键的证据一起丢掉。
  let settled = null;
  let answerError = null;
  try {
    settled = await waitFor(`${provider} group answer`, () => client.eval(`(async () => {
      const state = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${JSON.stringify(meeting.id)} });
      const hit = (state.messages || []).find(m => m && m.role === 'assistant' && String(m.content || '').includes(${JSON.stringify(marker)}));
      if (!hit || state.currentMode !== 'idle') return null;
      return { status: hit.status, chars: String(hit.content || '').length };
    })()`), 420000);
  } catch (error) {
    answerError = error.message;
  }

  const telemetry = await client.eval(`(() => ({
    ack: window.__stressGroup.acks.slice(${Number(beforeAcks)}).at(-1) || null,
    stuck: window.__stressGroup.stuck.slice(${Number(beforeStuck)}).filter(s => s && s.sid === ${JSON.stringify(sid)}).length,
  }))()`);
  const screen = settled ? null
    : await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sid)})`).catch(() => null);
  return { settled, answerError, screen, telemetry, durationMs: Date.now() - startedAt };
}

async function main() {
  let hub = null;
  let client = null;
  const nonce = `${process.pid}${Date.now().toString(36)}`;
  const cells = [];
  const failures = [];
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    if (PROVIDERS.includes('codex')) prepareIsolatedCodexHome();
    if (PROVIDERS.includes('claude')) prepareIsolatedClaudeConfig();
    const port = await reservePort();
    hub = await launchIsolatedHub({
      dataDir: path.join(ROOT, 'hub-data'),
      port,
      label: 'prompt-submit-stress',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'fake-home'),
        CLAUDE_CONFIG_DIR: ISOLATED_CLAUDE_CONFIG_DIR,
        CODEX_HOME: ISOLATED_CODEX_HOME,
        DEEPSEEK_API_KEY: '',
        HUB_GROUPCHAT_SEND_DIAGNOSTICS: '1',
      },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await waitFor('renderer API', () => client.eval('!!(window.WorkspaceController && window.__hubE2E && window.MeetingRoom)'), 60000);
    await client.eval(INSTALL_RECORDER);

    for (const provider of PROVIDERS) {
      for (const surface of SURFACES) {
        let ctx = null;
        try {
          ctx = surface === 'normal'
            ? { sid: await ensureNormalSession(client, provider) }
            : await setupGroupMeeting(client, provider);
        } catch (error) {
          failures.push({ provider, surface, phase: 'setup', error: error.message });
          console.error(`[stress] SETUP FAILED ${provider}/${surface}: ${error.message}`);
          continue;
        }
        for (const lines of SIZES) {
          for (let trial = 1; trial <= TRIALS; trial += 1) {
            const marker = `SUBMIT_OK_${provider}_${surface}_${lines}_${trial}_${nonce}`.toUpperCase();
            const prompt = buildPrompt(marker, lines);
            const cell = { provider, surface, lines, trial, promptChars: prompt.length };
            try {
              if (surface === 'normal' && LEGACY_MODE) {
                const r = await runNormalTrial(client, { sid: ctx.sid, provider, marker, prompt });
                Object.assign(cell, {
                  legacy: true,
                  answered: r.answered,
                  pasteMarkerOnScreen: r.pasteMarkerOnScreen,
                  durationMs: r.durationMs,
                });
                // legacy 基线只判一件事：在给定窗口里 AI 到底答没答上来。
                cell.ok = r.answered;
                if (!r.answered) {
                  const why = r.pasteMarkerOnScreen
                    ? `prompt 卡在输入框：${r.pasteMarkerOnScreen}`
                    : '窗口内没等到回答';
                  failures.push({ provider, surface, lines, trial, legacy: true, error: why });
                  console.error(`[stress] LEGACY-FAIL ${provider}/${surface}/${lines}行: ${why}`);
                } else {
                  console.log(`[stress] LEGACY-PASS ${provider}/${surface}/${lines}行 · ${cell.promptChars}字 · ${r.durationMs}ms`);
                }
                cells.push(cell);
                await _waitMs(800);
                continue;
              }
              if (surface === 'normal') {
                const r = await runNormalTrial(client, { sid: ctx.sid, provider, marker, prompt });
                const result = r.record.result || {};
                Object.assign(cell, {
                  ok: true,
                  durationMs: r.durationMs,
                  sendStatus: result.sendStatus,
                  mode: result.mode,
                  enterAttempts: result.enterAttempts,
                  acknowledgementSource: result.acknowledgementSource,
                  stuckBanner: r.stuckBanner,
                  answered: r.answered,
                });
                assert.ok(result.ok, `send-prompt returned not-ok: ${JSON.stringify(result)}`);
                assert.notEqual(result.sendStatus, 'stuck', `sendStatus stuck: ${JSON.stringify(result)}`);
                assert.ok(result.acknowledgementSource, `no semantic acknowledgement: ${JSON.stringify(result)}`);
                assert.ok(result.enterAttempts <= 2, `too many Enter attempts: ${JSON.stringify(result)}`);
                assert.equal(r.stuckBanner, false, 'stuck banner should not appear on a healthy send');
                assert.ok(r.answered,
                  `AI 没在窗口内答出 marker（send=${JSON.stringify(result)}; ${r.answerError}）\n--- screen ---\n${r.screen}\n--- end ---`);
              } else {
                const r = await runGroupTrial(client, { ...ctx, provider, marker, prompt });
                const ack = r.telemetry.ack || {};
                Object.assign(cell, {
                  ok: true,
                  durationMs: r.durationMs,
                  sendStatus: ack.sendStatus,
                  enterAttempts: ack.enterAttempts,
                  acknowledgementSource: ack.acknowledgementSource,
                  answerStatus: r.settled && r.settled.status,
                  answered: !!r.settled,
                  stuckEvents: r.telemetry.stuck,
                });
                assert.ok(['ok', 'auto_recovered'].includes(ack.sendStatus), `bad sendStatus: ${JSON.stringify(ack)}`);
                assert.ok(ack.enterAttempts >= 1 && ack.enterAttempts <= 2, `bad enterAttempts: ${JSON.stringify(ack)}`);
                assert.equal(r.telemetry.stuck, 0, `group chat reported a stuck send: ${JSON.stringify(ack)}`);
                if (!r.settled) {
                  // 群聊这条链路的失败通常在主进程（tap 绑定 / turn-completion / 编排），
                  // 渲染侧看不到。把 Hub 自己的日志尾巴带出来，否则只剩一句 timeout。
                  const hubLog = (hub.log() || []).filter(line =>
                    /codex-tap|group-chat|groupchat|paste-trapped|tap\]/i.test(line)).slice(-40);
                  cell.hubLogTail = hubLog;
                }
                assert.ok(r.settled,
                  `群聊没在窗口内答出 marker（ack=${JSON.stringify(ack)}; ${r.answerError}）\n--- hub log ---\n${(cell.hubLogTail || []).join('\n')}\n--- screen ---\n${r.screen}\n--- end ---`);
              }
              console.log(`[stress] PASS ${provider}/${surface}/${lines}行 · ${cell.promptChars}字 · ${cell.sendStatus} · enter=${cell.enterAttempts} · ${cell.durationMs}ms`);
            } catch (error) {
              cell.ok = false;
              cell.error = error.message;
              failures.push({ provider, surface, lines, trial, error: error.message });
              console.error(`[stress] FAIL ${provider}/${surface}/${lines}行: ${error.message}`);
            }
            cells.push(cell);
            await _waitMs(800);
          }
        }
      }
    }

    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    const payload = {
      ok: failures.length === 0,
      generatedAt: new Date().toISOString(),
      matrix: { providers: PROVIDERS, surfaces: SURFACES, sizes: SIZES, trials: TRIALS },
      passed: cells.filter(c => c.ok).length,
      failed: failures.length,
      cells,
      failures,
      screenshot: SCREENSHOT,
      resultJson: RESULT_JSON,
      hubPid: hub.pid,
    };
    fs.writeFileSync(RESULT_JSON, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\n[stress] ${payload.passed} passed / ${payload.failed} failed`);
    console.log(`[stress] result: ${RESULT_JSON}`);
    if (!payload.ok) process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) { await gracefulQuit(hub).catch(() => {}); await _waitMs(2000); }
    const resolved = path.resolve(ROOT);
    if (process.env.HUB_STRESS_KEEP_TEMP === '1') {
      console.error(`[stress] kept temp root: ${resolved}`);
    } else if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-prompt-submit-stress-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exitCode = 1;
});
