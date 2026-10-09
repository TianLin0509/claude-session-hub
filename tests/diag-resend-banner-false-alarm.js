'use strict';
// 「暂未确认 agent 收到消息，请核对后台或点击补发」误报的真 CLI 对照（2026-10-10 用户反馈）。
//
// 场景（每个 provider 各跑一遍，走真实用户路径：浮动输入框填字 + Enter）：
//   idle  —— 会话空闲时发一条，等它答完；
//   busy  —— 发一条要答一会儿的，趁它还在答再发一条追问（CLI 会把追问排队）。
// 判据：任何时刻出现 .fi-stuck 横幅即记一次误报（两条消息最终都答上来了才算误报；没答上来就是真问题）。
//
//   node tests/diag-resend-banner-false-alarm.js            # 默认 claude,codex
//   $env:HUB_RESEND_PROVIDERS='claude'; node tests/diag-resend-banner-false-alarm.js
//
// 用真凭证跑真 CLI（Claude 用 Haiku、Codex 用低档），只起隔离实例，凭证副本跑完删除。
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resend-banner-'));
const WORKSPACE = path.join(ROOT, 'workspace');
const CLAUDE_DIR = path.join(ROOT, 'claude-config');
const CODEX_DIR = path.join(ROOT, 'codex-home');
const PROVIDERS = String(process.env.HUB_RESEND_PROVIDERS || 'claude,codex').split(',').map(s => s.trim()).filter(Boolean);
const TRIALS = Math.max(1, Math.min(5, Number(process.env.HUB_RESEND_TRIALS) || 2));
const MODELS = { claude: process.env.HUB_RESEND_CLAUDE_MODEL || 'haiku', codex: process.env.HUB_RESEND_CODEX_MODEL || 'gpt-5.6-sol' };
const j = JSON.stringify;

function prepareConfigs() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const srcClaude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(path.join(srcClaude, '.credentials.json'), path.join(CLAUDE_DIR, '.credentials.json'));
  // 只搬 Hub 自己的状态回报 hook（提交确认靠它），不带使用者的其他 hook / 插件。
  const srcSettings = JSON.parse(fs.readFileSync(path.join(srcClaude, 'settings.json'), 'utf8'));
  const hooks = {};
  for (const [event, list] of Object.entries(srcSettings.hooks || {})) {
    const kept = (Array.isArray(list) ? list : [list]).map(e => ({ ...e, hooks: (e.hooks || []).filter(h => /session-hub-hook/.test(String(h.command || ''))) })).filter(e => e.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true, hooks }));
  const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const iso = { hasCompletedOnboarding: true, lastOnboardingVersion: state.lastOnboardingVersion, projects: {}, autoUpdates: false,
    bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, theme: 'dark' };
  for (const k of ['userID', 'oauthAccount', 'hasAvailableSubscription', 'modelAccessCache', 'hasResetAutoModeOptInForDefaultOffer', 'hasSeenAutoModeEntryWarning', 'lastReleaseNotesSeen', 'seenNotifications']) if (state[k] !== undefined) iso[k] = state[k];
  fs.writeFileSync(path.join(CLAUDE_DIR, '.claude.json'), j(iso));
  const srcCodex = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    const p = path.join(srcCodex, name);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(CODEX_DIR, name));
  }
}
function removeCredentials() {
  for (const p of [path.join(CLAUDE_DIR, '.credentials.json'), path.join(CODEX_DIR, 'auth.json')]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function waitFor(label, fn, ms = 180000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await _waitMs(400); }
  throw new Error(`timeout: ${label}${last ? ' (' + last.message + ')' : ''}`);
}

const DIALOGS = [
  ['Make auto mode your default permission mode?', 'down'], ['Allow external CLAUDE.md file imports?', 'enter'],
  ['Do you trust the files in this folder?', 'enter'], ['Do you trust the contents of this directory', 'enter'],
  ['Yes, I trust this folder', 'enter'], ['Trust all and continue', 'down'],
];
async function startSession(c, provider) {
  const opts = provider === 'codex' ? { effort: 'low', mcpProfile: 'none', ...(MODELS.codex ? { model: MODELS.codex } : {}) }
    : { model: MODELS.claude, effort: 'low', mcpProfile: 'lean', fastMode: false };
  const { id } = await c.eval(`window.WorkspaceController.createSession(${j(provider)}, { cwd: ${j(WORKSPACE)}, opts: ${j(opts)} }).then(s => ({ id: s.id }))`);
  await waitFor('renderer session', () => c.eval(`sessions.has(${j(id)})`), 30000);
  await c.eval(`window.__hubE2E.selectSession(${j(id)}, { forceScrollBottom: true })`);
  const ready = provider === 'codex' ? (process.env.HUB_RESEND_CODEX_READY || 'Ask Codex to do anything') : 'shift+tab';
  for (let i = 0; i < 6; i++) {
    const state = await waitFor(`${provider} startup`, () => c.eval(`(() => { const s = window.__hubE2E.terminalLiveScreenText(${j(id)});
      const d = ${j(DIALOGS)}.find(x => s.includes(x[0])); if (d) return 'dialog:' + d[1]; return s.includes(${j(ready)}) ? 'ready' : ''; })()`), 120000).catch(async e => { throw new Error(e.message + '\n' + await c.eval(`window.__hubE2E.terminalLiveScreenText(${j(id)})`).catch(() => '')); });
    if (state === 'ready') break;
    await c.eval(`(() => { const id = ${j(id)}; if (${j(state === 'dialog:down')}) ipcRenderer.send('terminal-input', { sessionId: id, data: '\\x1b[B' });
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: id, data: '\\r' }), 150); return true; })()`);
    await _waitMs(1500);
  }
  await _waitMs(1000);
  await c.eval(`applyViewMode('card')`).catch(() => {});
  return id;
}
async function typeAndSend(c, text) {
  await c.eval(`(() => { const box = document.querySelector('.floating-input-box'); if (!box) throw new Error('no input box');
    box.focus(); box.textContent = ${j(text)}; box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
}
const answered = (c, id, marker) => c.eval(`ipcRenderer.invoke('get-last-assistant-text', ${j(id)}).then(t => String(t || '').includes(${j(marker)}))`);
const transcriptHas = (c, id, marker) => c.eval(`ipcRenderer.invoke('get-session-transcript-text', ${j(id)}).then(t => String(t || '').includes(${j(marker)})).catch(() => false)`);

// 观察窗口：期间每 300ms 看一次横幅。
async function watchBanner(c, ms) {
  const end = Date.now() + ms; let seen = null;
  while (Date.now() < end) {
    const text = await c.eval(`(document.querySelector('.fi-stuck') || {}).textContent || ''`).catch(() => '');
    if (text && !seen) seen = { at: Date.now(), text: text.slice(0, 80) };
    await _waitMs(300);
  }
  return seen;
}
async function lastSendResults(c, n) {
  return c.eval(`window.__rec.slice(-${n}).map(r => ({ sendStatus: r.result && r.result.sendStatus, ok: r.result && r.result.ok,
    ack: r.result && r.result.acknowledgementSource, receipt: r.result && r.result.receipt && r.result.receipt.status, enters: r.result && r.result.enterAttempts }))`);
}

(async () => {
  prepareConfigs();
  const hub = await launchIsolatedHub({ dataDir: path.join(ROOT, 'hub-data'), port: await freePort(), label: 'resend-banner', windowMode: 'background',
    extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'fake-home'), CLAUDE_CONFIG_DIR: CLAUDE_DIR, CODEX_HOME: CODEX_DIR, DEEPSEEK_API_KEY: '' } });
  const c = await connectFirstPage(hub);
  const results = [];
  try {
    await waitFor('hub ui', () => c.eval('typeof sessions !== "undefined" && !!window.WorkspaceController && !!window.__hubE2E'), 90000);
    await c.eval(`(() => { if (window.__rec) return true; const orig = ipcRenderer.invoke.bind(ipcRenderer); window.__rec = [];
      ipcRenderer.invoke = (ch, ...a) => { const p = orig(ch, ...a); if (ch === 'session:send-prompt') p.then(r => window.__rec.push({ result: r }), () => {}); return p; }; return true; })()`);
    for (const provider of PROVIDERS) {
      const id = await startSession(c, provider);
      for (let t = 1; t <= TRIALS; t++) {
        // idle：空闲时发一条短问题。
        const m1 = `IDLE-${provider}-${t}`;
        await typeAndSend(c, `只回复 ${m1} 这几个字符，不要调用任何工具。`);
        const idleBanner = await watchBanner(c, 45000);
        const idleAnswered = !!await waitFor('idle answer', () => answered(c, id, m1), 120000).catch(() => false);
        const idleSend = (await lastSendResults(c, 1))[0];
        // busy：先发一条要答一会儿的，开始答之后立刻追问。
        const m2 = `BUSY-${provider}-${t}`, m3 = `FOLLOW-${provider}-${t}`;
        await typeAndSend(c, `请在终端执行命令等待 45 秒（Windows PowerShell：Start-Sleep -Seconds 45），等它结束后只回复 ${m2}。`);
        await waitFor('busy running', () => c.eval(`getSessionRuntimeTruth(sessions.get(${j(id)})).state === 'running'`), 60000).catch(() => null);
        await _waitMs(1500);
        await typeAndSend(c, `追问：只回复 ${m3} 这几个字符，不要调用任何工具。`);
        const busyBanner = await watchBanner(c, 45000);
        const followAnswered = !!await waitFor('follow-up answer', () => answered(c, id, m3), 180000).catch(() => false);
        const busySends = await lastSendResults(c, 2);
        results.push({ provider, trial: t, idle: { banner: idleBanner, answered: idleAnswered, send: idleSend },
          busy: { banner: busyBanner, followAnswered, sends: busySends } });
        console.log(j(results.at(-1)));
        await _waitMs(3000);
      }
    }
  } finally {
    try { c.close(); } catch {}
    await gracefulQuit(hub).catch(() => {});
    removeCredentials();
  }
  const falseAlarms = results.flatMap(r => [r.idle.banner && r.idle.answered ? `${r.provider}#${r.trial} idle` : null,
    r.busy.banner && r.busy.followAnswered ? `${r.provider}#${r.trial} busy` : null]).filter(Boolean);
  const realFailures = results.flatMap(r => [!r.idle.answered ? `${r.provider}#${r.trial} idle 没答上` : null, !r.busy.followAnswered ? `${r.provider}#${r.trial} 追问没答上` : null]).filter(Boolean);
  const summary = { root: ROOT, scenarios: results.length * 2, falseAlarms, realFailures };
  fs.writeFileSync(path.join(ROOT, 'result.json'), j({ summary, results }, null, 2));
  console.log('SUMMARY ' + j(summary));
  setTimeout(() => process.exit(0), 300);
})().catch(error => { removeCredentials(); console.error(error); process.exit(1); });
