const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
let QRCode = null;
const { SessionManager } = require('./core/session-manager.js');
const stateStore = require('./core/state-store.js');
const { createMobileServer } = require('./core/mobile-server.js');
const mobileAuth = require('./core/mobile-auth.js');
const { getHubDataDir } = require('./core/data-dir.js');
const { MeetingRoomManager, isRoundtableCapableMeeting } = require('./core/meeting-room.js');
const meetingStore = require('./core/meeting-store.js');
const { SummaryEngine } = require('./core/summary-engine');
const summaryEngine = new SummaryEngine();
const { TranscriptTap } = require('./core/transcript-tap');
const { createUsageFilter } = require('./core/usage-filter.js');
const transcriptTap = new TranscriptTap();
const { DeepSummaryService } = require('./core/deep-summary-service.js');
const scenes = require('./core/roundtable-scenes.js');
const generalRoundtablePrivateStore = require('./core/general-roundtable-private-store.js');
const lindangBridge = require('./core/lindang-bridge.js');
const { GeminiCliProvider } = require('./core/summary-providers/gemini-cli.js');
const { DeepSeekProvider } = require('./core/summary-providers/deepseek-api.js');
const { loadConfig: loadDeepSummaryConfig } = require('./core/deep-summary-config.js');

// Isolate Chromium userData when CLAUDE_HUB_DATA_DIR is set (parallel test
// instances). Must run before app.whenReady(). Production Hub unaffected
// because the env var is only set by test harnesses.
if (process.env.CLAUDE_HUB_DATA_DIR) {
  app.setPath('userData', path.join(process.env.CLAUDE_HUB_DATA_DIR, 'electron-userdata'));
}

// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — skips if already present, never overwrites user's existing hooks.
// claudeDirPath: target Claude config dir (e.g. ~/.claude or ~/.claude-deepseek)
function ensureHooksDeployed(claudeDirPath) {
  const claudeDir = claudeDirPath;
  const scriptsDir = path.join(claudeDir, 'scripts');

  // 1. Copy hook scripts if missing
  const srcDir = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');

  const scriptFiles = ['session-hub-hook.py', 'claude-hub-statusline.js', 'deepseek_repl.py'];
  for (const file of scriptFiles) {
    const dest = path.join(scriptsDir, file);
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(scriptsDir, { recursive: true });
    // Repo-generated scripts (not user-authored): keep deployed copy in sync
    // with the repo. Otherwise an old deployed statusline/hook keeps running
    // and silently ignores new logic shipped in later Hub releases.
    let needsCopy = !fs.existsSync(dest);
    if (!needsCopy) {
      try { needsCopy = !fs.readFileSync(src).equals(fs.readFileSync(dest)); }
      catch { needsCopy = true; }
    }
    if (needsCopy) {
      fs.copyFileSync(src, dest);
      console.log(`[hub] deployed ${file} -> ${dest}`);
    }
  }

  // 2. Merge hook config into settings.json if not present
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const hookPyPath = path.join(scriptsDir, 'session-hub-hook.py').replace(/\\/g, '\\\\');
  const statusJsPath = path.join(scriptsDir, 'claude-hub-statusline.js').replace(/\\/g, '/');

  let changed = false;

  // Ensure hooks object
  if (!settings.hooks) settings.hooks = {};

  // Stop hook
  const stopCmd = `python "${hookPyPath}" stop`;
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  const hasStop = settings.hooks.Stop.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('session-hub-hook'))
  );
  if (!hasStop) {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: stopCmd, timeout: 5 }]
    });
    changed = true;
  }

  // UserPromptSubmit hook
  const promptCmd = `python "${hookPyPath}" prompt`;
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  const hasPrompt = settings.hooks.UserPromptSubmit.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('session-hub-hook'))
  );
  if (!hasPrompt) {
    settings.hooks.UserPromptSubmit.push({
      matcher: '',
      hooks: [{ type: 'command', command: promptCmd, timeout: 5 }]
    });
    changed = true;
  }

  // Statusline
  if (!settings.statusLine || !String(settings.statusLine.command || '').includes('claude-hub-statusline')) {
    settings.statusLine = {
      type: 'command',
      command: `node "${statusJsPath}"`
    };
    changed = true;
  }

  // 3. Ensure bypass-permissions — so DeepSeek (and any future Claude-derivative)
  //    sessions start without folder-trust / permission-confirmation prompts.
  //    The main ~/.claude dir typically already has this from prior manual setup,
  //    but ~/.claude-deepseek is a fresh isolated config that needs it seeded.
  if (!settings.permissionMode || settings.permissionMode !== 'bypassPermissions') {
    settings.permissionMode = 'bypassPermissions';
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[hub] settings.json updated with hook config');
  }

  // 4. Ensure .claude.json project trust — Claude Code 将"信任文件夹"状态
  //    存在 .claude.json 而非 settings.json。隔离配置(~/.claude-deepseek)缺少
  //    主配置(~/.claude)的历史信任记录，需要每次启动检查并修复。
  const statePath = path.join(claudeDir, '.claude.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw);
    if (state.projects && typeof state.projects === 'object') {
      let trustChanged = false;
      for (const [projectDir, proj] of Object.entries(state.projects)) {
        if (proj && typeof proj === 'object' && proj.hasTrustDialogAccepted === false) {
          proj.hasTrustDialogAccepted = true;
          trustChanged = true;
          console.log(`[hub] .claude.json trust fixed: ${projectDir}`);
        }
      }
      if (trustChanged) {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
        console.log('[hub] .claude.json trust state updated');
      }
    }
  } catch { /* .claude.json 不存在或格式异常，跳过（首次启动可能尚未生成） */ }
}

// Ensure Codex CLI status bar includes context-remaining so the scanner can
// parse context usage. Idempotent — only patches if the key is absent.
function ensureCodexContextConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const configPath = path.join(home, '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch {}
    if (content.includes('status_line')) return;
    const line = '\n[tui]\nstatus_line = ["model-with-reasoning", "context-remaining", "current-dir"]\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.appendFileSync(configPath, line);
    console.log('[hub] codex config.toml patched with context-remaining');
  } catch (e) {
    console.warn('[hub] codex config patch failed:', e.message);
  }
}

// Find the project directory holding a given CC session's JSONL by globbing
// ~/.claude/projects/<slug>/<ccSessionId>.jsonl across all project slugs.
// Returns the full path, or null if not found.
function findTranscriptByCCSessionId(ccSessionId) {
  if (!ccSessionId) return null;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const candidateRoots = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.claude-deepseek', 'projects'),
  ];
  for (const projectsDir of candidateRoots) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(projectsDir, d.name, ccSessionId + '.jsonl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

// Pull the original cwd out of a transcript JSONL. CC embeds `cwd` in most
// message entries as JSON; we read enough to grab the first occurrence.
// Authoritative — this is what the session was actually running in when the
// transcript was written, so using it guarantees `claude --resume <id>` can
// locate the project slug.
function extractCwdFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // Read up to 64KB from the head; cwd appears very early.
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf-8');
      const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally { fs.closeSync(fd); }
  } catch {}
  return null;
}

// Heal stale cwds in a persisted session list by looking up each session's
// transcript file and reading the authoritative cwd. Fixes legacy entries
// that were corrupted by the old `status-event` overwrite bug.
function healPersistedCwds(sessions) {
  let fixed = 0;
  for (const s of sessions) {
    if (!s.ccSessionId) continue;
    const tp = findTranscriptByCCSessionId(s.ccSessionId);
    if (!tp) continue;
    const realCwd = extractCwdFromTranscript(tp);
    if (realCwd && realCwd !== s.cwd) {
      console.log(`[hub] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
      s.cwd = realCwd;
      fixed++;
    }
  }
  return fixed;
}

// Read the last user message text from a Claude Code transcript JSONL file.
// Reads the trailing chunk(s) only (not the whole file) — long sessions can be
// 10MB+ and we used to readFileSync the whole thing on every hook POST, which
// stalled the main-process event loop. Now we seek from EOF and walk backward
// in 64KB chunks until we hit the first complete `user`-typed entry.
// Returns null on any failure — caller should treat absence as non-fatal.
async function readLastUserMessage(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // The first fragment may be an incomplete line — keep it for the next pass
      // by prepending it back to `tail`, except when we've reached the very start.
      const firstFragment = pos === 0 ? null : lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const role = entry.type || entry.role;
        if (role !== 'user') continue;
        const msg = entry.message;
        let text = '';
        if (typeof msg === 'string') {
          text = msg;
        } else if (msg && typeof msg.content === 'string') {
          text = msg.content;
        } else if (msg && Array.isArray(msg.content)) {
          // CC stores tool_result entries as role=user too (Anthropic API
          // convention). Skip those — they pollute the preview with strings
          // like "[Image: source: ]" pulled from tool return payloads.
          const hasTool = msg.content.some(c => c && c.type === 'tool_result');
          if (hasTool) continue;
          text = msg.content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ').trim();
        }
        if (text) return text;
      }
      tail = firstFragment == null ? '' : firstFragment;
    }
  } catch {
    // swallowed — non-fatal
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  return null;
}

// Hook server picks the first free port in this range.
const HOOK_PORT_CANDIDATES = [
  3456, 3457, 3458, 3459, 3460,
  3461, 3462, 3463, 3464, 3465,
  3466, 3467, 3468, 3469, 3470,
  3471, 3472, 3473, 3474, 3475,
];
// Random per-launch token; hook POSTs must carry it. Stops any other local
// process from forging unread bumps.
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

let hookPort = null;  // set after listen() succeeds
let mobileSrv = null; // set after app.whenReady startup

let mainWindow;
const sessionManager = new SessionManager();
const meetingManager = new MeetingRoomManager();

// Deep-summary service singleton: instantiated from config-driven fallback chain.
// Providers tried in order; first one with a parseable response wins.
const _deepSummaryConfig = loadDeepSummaryConfig();
function _buildDeepSummaryProviders() {
  const providers = [];
  for (const name of _deepSummaryConfig.fallback_chain) {
    if (name === 'gemini-cli') {
      providers.push(new GeminiCliProvider(_deepSummaryConfig.gemini_cli));
    } else if (name === 'deepseek-api') {
      providers.push(new DeepSeekProvider(_deepSummaryConfig.deepseek_api));
    } else {
      console.warn('[deep-summary] unknown provider in fallback_chain:', name);
    }
  }
  if (providers.length === 0) {
    throw new Error('deep-summary fallback_chain produced 0 providers');
  }
  return providers;
}
const deepSummaryService = new DeepSummaryService({ providers: _buildDeepSummaryProviders() });

// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', ({ hubSessionId, text, completedAt }) => {
  const session = sessionManager.getSession(hubSessionId);
  if (!session || !session.meetingId) return;
  const turn = meetingManager.appendTurn(
    session.meetingId,
    hubSessionId,
    text,
    completedAt != null ? completedAt : Date.now(),
  );
  if (turn) {
    sendToRenderer('meeting-timeline-updated', { meetingId: session.meetingId, turn });
  }
  // (Driver-mode auto-review removed when driver mode was deprecated.)
});

// Persist resume meta when transcript-tap binds a sub-session to its native CLI sid.
transcriptTap.on('session-bound', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  // Find the session in lastPersistedSessions and merge new fields.
  const idx = lastPersistedSessions.findIndex(s => s.hubId === ev.hubSessionId);
  if (idx < 0) return;
  const cur = lastPersistedSessions[idx];
  let changed = false;
  if (ev.kind === 'codex' && ev.codexSid && cur.codexSid !== ev.codexSid) {
    cur.codexSid = ev.codexSid;
    changed = true;
  }
  if (ev.kind === 'gemini') {
    if (ev.geminiChatId && cur.geminiChatId !== ev.geminiChatId) { cur.geminiChatId = ev.geminiChatId; changed = true; }
    if (ev.geminiProjectHash && cur.geminiProjectHash !== ev.geminiProjectHash) { cur.geminiProjectHash = ev.geminiProjectHash; changed = true; }
    if (ev.geminiProjectRoot && cur.geminiProjectRoot !== ev.geminiProjectRoot) { cur.geminiProjectRoot = ev.geminiProjectRoot; changed = true; }
  }
  if (changed) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
    });
    console.log(`[hub] persisted resume meta for ${ev.kind} session ${ev.hubSessionId.slice(0,8)}`);
  }
});

sessionManager.hookToken = HOOK_TOKEN;  // port set after listen

// NOTE: Don't call app.setAppUserModelId here. Setting an AUMID without also
// registering an icon resource for that AUMID (or matching it on the launcher
// .lnk) decouples the running process from the launching shortcut, and Windows
// falls back to electron.exe's default atom icon in the taskbar. With no AUMID
// set, Windows uses the .lnk's icon for taskbar entries spawned via the .lnk
// and BrowserWindow.icon for the title bar — both end up the octopus.

function createWindow() {
  // Load the icon as a NativeImage so we can pass it to BrowserWindow AND
  // re-apply via setIcon — on Windows the constructor `icon` alone sometimes
  // misses the taskbar; the explicit setIcon nails it.
  const iconPath = path.join(__dirname, 'claude-wx.ico');
  const winIcon = nativeImage.createFromPath(iconPath);

  // 标题动态读 package.json 版本号，避免硬编码漂移（card-redesign 0.2.0 起）
  const _pkgVersion = (() => {
    try { return require('./package.json').version || ''; } catch { return ''; }
  })();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Claude Session Hub${_pkgVersion ? ` v${_pkgVersion}` : ''}`,
    backgroundColor: '#0d1117',
    icon: winIcon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  if (!winIcon.isEmpty()) {
    mainWindow.setIcon(winIcon);
  } else {
    console.warn('[icon] failed to load', iconPath);
  }

  mainWindow.maximize();
  mainWindow.show();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

sessionManager.onData = (sessionId, data) => {
  sendToRenderer('terminal-data', { sessionId, data });
};

sessionManager.onSessionClosed = (sessionId, meetingId, exitInfo) => {
  // Stage 2 P1-1：把 PTY 退出作为 L2 完成信号通知圆桌 watcher。
  //   如果该 sid 当前正在 turn 等待中（_activeWatchers 命中），调 markProcessExit
  //   让 watcher 立即 settle（completed if exit=0 else errored），不再被任何
  //   "永远不来"的 L1 信号或 30min 过渡 timeout 拖住。
  const watcher = _activeWatchers.get(sessionId);
  if (watcher) {
    // node-pty 的 exitInfo 是 { exitCode, signal }，watcher 接受 { code, signal }——做名称适配
    const adapted = exitInfo
      ? { code: typeof exitInfo.exitCode === 'number' ? exitInfo.exitCode : null, signal: exitInfo.signal }
      : { code: null };
    console.log(`[roundtable] PTY exit detected for sid=${sessionId.slice(0, 8)} (code=${adapted.code} signal=${adapted.signal || 'none'}), notifying watcher`);
    try { watcher.markProcessExit(adapted); } catch (e) {
      console.warn('[roundtable] markProcessExit threw:', e.message);
    }
  }

  try { transcriptTap.unregisterSession(sessionId); } catch {}
  sendToRenderer('session-closed', { sessionId });
  if (meetingId) {
    const updated = meetingManager.removeSubSession(meetingId, sessionId);
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  }
};

// Register a freshly-spawned session with the transcript tap so the appropriate
// backend starts watching its CLI-native transcript file. No-op for kinds
// without a backend (powershell/deepseek/glm).
function registerSessionForTap(session) {
  if (!session || !session.id) return;
  try { transcriptTap.registerSession(session.id, session.kind, { cwd: session.cwd }); }
  catch {}
}

ipcMain.handle('create-session', (_e, arg) => {
  // Back-compat: legacy callers pass just a `kind` string. New callers pass
  // `{ kind, opts }` so they can request `resumeCCSessionId` / custom cwd / etc.
  let kind, opts;
  if (typeof arg === 'string') { kind = arg; opts = {}; }
  else if (arg && typeof arg === 'object') { kind = arg.kind; opts = arg.opts || {}; }
  else { kind = 'powershell'; opts = {}; }
  const session = sessionManager.createSession(kind, opts);
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });
  return session;
});

// --- Meeting Room IPC ---

ipcMain.handle('create-meeting', (_e, opts) => {
  // opts: { mode?: 'general' | 'research' }
  // 兼容老调用(无参数 / 旧前端)→ createMeeting 默认 'general'。
  const meeting = meetingManager.createMeeting(opts || {});
  sendToRenderer('meeting-created', { meeting });
  return meeting;
});

ipcMain.handle('add-meeting-sub', async (_e, { meetingId, kind, opts }) => {
  const meeting = meetingManager.getMeeting(meetingId);
  let sessionOpts = { ...(opts || {}), meetingId };

  if (meeting && meeting.scene) {
    const hubDataDir = getHubDataDir();
    const sceneObj = scenes.getScene(meeting.scene);
    const covenantText = (typeof meeting.covenantText === 'string')
      ? meeting.covenantText
      : scenes.readCovenantSnapshot(hubDataDir, meetingId);
    if (covenantText && covenantText.trim().length > 0) {
      scenes.writeCovenantSnapshot(hubDataDir, meetingId, covenantText);
    }
    const promptFile = scenes.writePromptFile(hubDataDir, meetingId, meeting.scene, covenantText);
    if (kind === 'claude' || kind === 'glm') {
      sessionOpts.appendSystemPromptFile = promptFile;
      if (sceneObj && sceneObj.mcpConfig === 'research' && hookPort) {
        sessionOpts.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, meetingId, hookPort, HOOK_TOKEN, 'claude');
      } else if (sceneObj && sceneObj.mcpConfig === 'research' && !hookPort) {
        console.warn('[hub] research scene Claude in meeting ' + meetingId + ' but hookPort unavailable — MCP tools unavailable');
      }
    } else if (kind === 'gemini') {
      sessionOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
    } else if (kind === 'codex') {
      sessionOpts.codexInstructionFile = promptFile;
      sessionOpts.codexBypassApprovals = true;
      if (sceneObj && sceneObj.mcpConfig === 'research' && hookPort) {
        sessionOpts.codexMcpEntries = [scenes.buildResearchMcpEntryForCodex(meetingId, hookPort, HOOK_TOKEN)];
      }
    }
  }

  const session = sessionManager.createSession(kind, sessionOpts);
  if (!session) return null;
  const updated = meetingManager.addSubSession(meetingId, session.id);
  if (!updated) {
    sessionManager.closeSession(session.id);
    return null;
  }

  registerSessionForTap(session);
  sendToRenderer('session-created', { session });
  const freshMeeting = meetingManager.getMeeting(meetingId);
  sendToRenderer('meeting-updated', { meeting: freshMeeting || updated });
  return { session, meeting: freshMeeting || updated };
});

ipcMain.handle('remove-meeting-sub', (_e, { meetingId, sessionId }) => {
  sessionManager.closeSession(sessionId);
  const updated = meetingManager.removeSubSession(meetingId, sessionId);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  return updated;
});

ipcMain.handle('close-meeting', (_e, meetingId) => {
  const subIds = meetingManager.closeMeeting(meetingId);
  if (!subIds) return false;
  for (const sid of subIds) {
    sessionManager.closeSession(sid);
  }
  scenes.cleanup(getHubDataDir(), meetingId);
  sendToRenderer('meeting-closed', { meetingId });
  return true;
});

// =====================================================================
// Roundtable Mode (Sprint 2): fanout / debate / summary 三种轮次
// =====================================================================
const roundtable = require('./core/roundtable-orchestrator.js');
let _roundtableInProgress = new Set(); // 同会议室单一并发：set of meetingId

const _RT_READY_MARKERS = {
  // Claude 启动 buffer 含大量 ANSI/box 字符，文本匹配易失败 → 空 markers 走 buffer 长度兜底
  claude: [],
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  codex: ['gpt-5.5', 'gpt-5.4', 'Context 100%', 'send'],
  glm: [],
};

// timeout 提到 60s 兜底（Claude Opus 1M 启动 + 配置加载在慢机可能 30s+）
async function _rtWaitCliReady(sid, kind, maxMs = 60000) {
  const need = _RT_READY_MARKERS[kind] || [];
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const buf = sessionManager.getSessionBuffer(sid) || '';
    // 空 markers：buffer 至少 1500 字符就认为启动完成（启动屏 + 提示符通常 >2KB）
    if (need.length === 0) { if (buf.length >= 1500) return true; }
    else if (need.some(m => buf.includes(m))) return true;
    // 100ms 轮询：cold path 加速 ~200ms（原 300ms 是为了省 CPU，但圆桌冷启动总耗时主要由 CLI 自身决定，轮询频率影响小）
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// 发送 prompt 到 PTY 并回车
// 设计：CLI 初始化是持久状态，只需做一次。session-manager 的 roundtableReady 缓存
//       让第 2-N 轮跳过冷启动等待，直接走快路径。
// **关键约束（历史 bug 重现于 2026-04-30）**：Claude/Gemini/Codex 三家都是 TUI alt-screen 程序，
//   把紧贴到达的字符当"粘贴"事件 → 粘贴里的 '\r' 被当文本换行符而不是 Enter 提交。
//   所以 prompt 和 '\r' **必须分两次 write**，中间留 TUI 消化窗口；不能合并 `prompt + '\r'`。
// **大 prompt 加固（2026-05-01 第二次修，bug 重现于 debate/summary 阶段）**：
//   原 300ms 固定窗口对 3500+ 字 prompt 不够 —— Codex 的 paste-detect 在末批字符到达后
//   还要 ~150ms 才 fire。\r 落在 paste 缓冲态里就被吃掉，Enter 不触发。
//   改为"安静期自适应"：每 50ms 轮询 lastActivity，连续 FAST_PATH_QUIET_MS=250ms 无变化即
//   视为 CLI 已完成 paste 接收 + paste-end 检测，此时 \r 才会被识别为 Enter。
//   MAX FAST_PATH_MAX_WAIT_MS=3000ms 兜底（极大 prompt 也不无限等）。
// 活性兜底（fail-safe）：write 后 PTY 始终零 echo 视为 CLI 失活（Ctrl+C / crash / PTY 断开）
//   → 重置 ready 直接 return false 让调用方 skip 这家。
//   不在兜底里"重发 prompt"——第一次 write 已把字符送进 PTY stdin，无论 CLI 有无 echo
//   字符都已被接收/缓冲，重发会造成 prompt+prompt+\r 双重输入。下一轮自动走冷启动恢复。
async function _rtSendToPty(sid, prompt, kind) {
  const FAST_PATH_QUIET_MS = 250;       // 连续 250ms 无 PTY 数据 → 视为 paste 接收完
  const FAST_PATH_MAX_WAIT_MS = 3000;   // 上限：极大 prompt 也不无限等
  const FAST_PATH_POLL_MS = 50;

  // 冷启动：仅首次或 ready 被重置后
  if (!sessionManager.getRoundtableReady(sid)) {
    const ready = await _rtWaitCliReady(sid, kind, 60000);
    if (!ready) return false;
    sessionManager.setRoundtableReady(sid, true);
  }

  // 第 1 次 write：仅 prompt（不带 '\r'）
  const beforeWrite = sessionManager.getRoundtableLastActivity(sid);
  sessionManager.writeToSession(sid, prompt);

  // 自适应安静期等待：每 50ms 检查 lastActivity，
  //   连续 250ms 无变化 → CLI paste-detect timer 已 fire，安全发 Enter
  //   一直在抖动 → 等到 MAX，仍发 \r（best effort，与老 300ms 行为同等保守）
  const startWait = Date.now();
  let lastSeen = beforeWrite;
  let lastChange = Date.now();
  while (Date.now() - startWait < FAST_PATH_MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, FAST_PATH_POLL_MS));
    const cur = sessionManager.getRoundtableLastActivity(sid);
    if (cur !== lastSeen) {
      lastSeen = cur;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= FAST_PATH_QUIET_MS) break;
  }

  // 活性兜底：从头到尾零 echo → CLI 已死
  if (lastSeen === beforeWrite) {
    console.warn(`[roundtable] fast-path activity check failed for ${kind}(${sid.slice(0, 8)}), skipping turn (ready reset for next-turn cold restart)`);
    sessionManager.setRoundtableReady(sid, false);
    return false;
  }

  // 第 2 次 write：单独 '\r' 触发提交（独立 write 是 TUI 识别 Enter 而非粘贴 newline 的硬性条件）
  sessionManager.writeToSession(sid, '\r');
  return true;
}

// 等待指定 sid 的 turn-complete 事件，返回 { sid, status, text }
// onPartial 回调（如提供）：单家完成时立即调用，让面板单卡片刷新（不必等 Promise.all）
function _rtExtractStreamingText(sid) {
  const buf = sessionManager.getSessionBuffer(sid);
  if (!buf) return '';
  const cleaned = buf
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=><%]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '');
  const lines = cleaned.split('\n');
  const usable = [];
  let started = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!started && line.length > 0) started = true;
    if (started) {
      if (/^(PS |>|\$|❊|Cooked for|bypass permissions|Claude Code v)/.test(line)) break;
      if (/^\[.*圆桌.*轮/.test(line)) break;
      if (/^(##\s*用户问题|请独立回答)/.test(line)) break;
      if (/quota\s+--?no.sandbox|gemini\s+--approval/.test(line)) break;
      usable.unshift(line);
    }
  }
  return usable.join('\n').trim().slice(-500);
}

// Stage 2 容错升级（2026-05-01）— 用 turn-completion-watcher 替代老 watchdog 实现
//
// 架构变更：
//   - 老逻辑：内联 transcriptTap.on('turn-complete') + 600s 强制 timeout → 整轮锁死
//   - 新逻辑：watcher 状态机管理（completed/errored/manual_extracted/absent），
//            T1=90s/T2=180s 软提醒 banner（不阻塞），用户可点 UI 触发点退出。
//
// **过渡期兜底**（FIX-B 2026-05-01 缩短）：原 30min 太长——Codex 自动更新 / Gemini OAuth 退出
//   等 CLI 自我退出场景，PTY 宿主 shell 还活，markProcessExit 不会被触发，watcher 唯一兜底就是
//   这个 timeout。30min 期间用户面板按钮锁死、卡片显错状态。
//   缩到 5min 覆盖 Opus 极慢推理上限，让"真卡死"场景能更快释放。彻底治本靠 FIX-D 的
//   shell prompt 心跳检测（10-15s 内识别 CLI 自我退出）。
const RT_TRANSITIONAL_HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// 模块级活跃 watcher 注册表：让 IPC handler 能找到当前 turn 中等待的 watcher
//   key = hubSessionId（每家 sid 同时最多一个 watcher）；value = watcher
const _activeWatchers = new Map();

const { createTurnCompletionWatcher } = require('./core/turn-completion-watcher.js');

function _rtWaitTurnComplete(sid, label, opts = {}) {
  const { meetingId, mode, turnNum, onPartial } = opts;

  // Card redesign（2026-05-01）：记录本轮起始时刻 + 清除上轮 token 缓存。
  //   settle 后注入 result.thinkSec（0.1s 精度）+ result.tokens（仅 Gemini 有）。
  //   卡片 row3/row4 用这两个字段做"本轮"统计 + orchestrator 做"累计"累加。
  const _startTs = Date.now();
  try { transcriptTap.clearLastTokens(sid); } catch {}

  const watcher = createTurnCompletionWatcher({
    transcriptTap,
    hubSessionId: sid,
    label,
    onSoftAlert: (level) => {
      // 软提醒：T1=90s 推一次 banner；T2=180s 升级。永不强制 settle。
      try {
        sendToRenderer('roundtable-soft-alert', {
          meetingId, turnNum, mode, sid, label, level,
        });
      } catch {}
    },
  });
  _activeWatchers.set(sid, watcher);

  // streaming partial 流式推送（保留现有体验，每 1500ms 推一次终端实时文本）
  let streamTimer = null;
  if (typeof onPartial === 'function') {
    streamTimer = setInterval(() => {
      if (watcher.isSettled()) { clearInterval(streamTimer); streamTimer = null; return; }
      const text = _rtExtractStreamingText(sid);
      if (text.length > 10) {
        try { onPartial({ sid, label, status: 'streaming', text }); } catch {}
      }
    }, 1500);
  }

  // 过渡期硬 timeout（commit 3 UI 落地后可移除）
  const hardTimeout = setTimeout(() => {
    if (watcher.isSettled()) return;
    console.warn(`[roundtable] transitional hard timeout (30min) hit for ${label}(${sid.slice(0, 8)}), forcing skip`);
    watcher.skip();
  }, RT_TRANSITIONAL_HARD_TIMEOUT_MS);
  hardTimeout.unref?.();

  return watcher.wait().then(result => {
    clearTimeout(hardTimeout);
    if (streamTimer) clearInterval(streamTimer);
    _activeWatchers.delete(sid);

    // Card redesign（2026-05-01）：注入本轮统计字段供 orchestrator 累加 + 卡片渲染。
    //   thinkSec 精度 0.1s（Math.round((..)*10)/10）；tokens 仅 Gemini 有，其他家 null。
    const elapsedMs = Date.now() - _startTs;
    result.thinkSec = Math.round(elapsedMs / 100) / 10;
    try { result.tokens = transcriptTap.getLastTokens(sid) || null; }
    catch { result.tokens = null; }

    if (typeof onPartial === 'function') {
      try { onPartial(result); } catch (e) { console.warn('[roundtable] onPartial error:', e.message); }
    }
    return result;
  });
}

// 主调度：mode = 'fanout' | 'debate' | 'summary'
// userInput: 用户输入（fanout 是问题，debate 是补充，summary 可空）
// summarizerKind: 仅 summary 用，'claude' / 'gemini' / 'codex'
async function dispatchRoundtableTurn(meetingId, { mode, userInput, summarizerKind }) {
  if (_roundtableInProgress.has(meetingId)) {
    return { status: 'busy', turnNum: null };
  }
  _roundtableInProgress.add(meetingId);
  try {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!isRoundtableCapableMeeting(meeting)) {
      return { status: 'error', reason: 'not roundtable-capable mode', turnNum: null };
    }

    // 收集三家活跃 sid + kind 映射
    const subs = (meeting.subSessions || [])
      .map(sid => {
        const s = sessionManager.getSession(sid);
        return s && s.status !== 'dormant' ? { sid, kind: s.kind, label: s.title || s.kind || 'AI' } : null;
      })
      .filter(Boolean);
    if (subs.length === 0) return { status: 'no_subs', turnNum: null };

    const labelMap = new Map(subs.map(x => [x.sid, x.label]));
    const sidLabelFn = (sid) => labelMap.get(sid) || 'AI';
    const sidByKind = (kind) => subs.find(x => x.kind === kind)?.sid;

    const sceneObj = scenes.getScene(meeting.scene);
    const orch = roundtable.getOrchestrator(getHubDataDir(), meetingId, sceneObj);

    // 决定本轮的目标 sid 集合 + 拼 per-sid prompt
    const targets = []; // [{ sid, kind, label, prompt }]
    let turnNum;

    if (mode === 'fanout') {
      turnNum = orch.beginTurn('fanout');
      const prompt = orch.buildFanoutPrompt(turnNum, userInput, null);
      for (const x of subs) targets.push({ ...x, prompt });
    } else if (mode === 'debate') {
      const last = orch.getLastTurn();
      if (!last) {
        orch.rollbackTurn(orch.state.currentTurn + 1); // 没启动也无所谓
        return { status: 'error', reason: '没有上一轮可中转，请先用 fanout 提问', turnNum: null };
      }
      turnNum = orch.beginTurn('debate');
      for (const x of subs) {
        const prompt = orch.buildDebatePrompt(turnNum, userInput, last, x.sid, sidLabelFn);
        targets.push({ ...x, prompt });
      }
    } else if (mode === 'summary') {
      const targetSid = summarizerKind ? sidByKind(summarizerKind) : null;
      if (!targetSid) {
        return { status: 'error', reason: `summarizer ${summarizerKind} 不在会议室或未活跃`, turnNum: null };
      }
      turnNum = orch.beginTurn('summary');
      orch.state.currentSummarizerKind = summarizerKind;
      orch._saveState();
      sendToRenderer('roundtable-state-update', { meetingId });
      const target = subs.find(x => x.sid === targetSid);
      const prompt = orch.buildSummaryPrompt(turnNum, target.sid, sidLabelFn);
      targets.push({ ...target, prompt });
    } else {
      return { status: 'error', reason: 'unknown mode', turnNum: null };
    }

    // 并行发送到所有目标 PTY
    const sentTargets = [];
    await Promise.all(targets.map(async (t) => {
      const ok = await _rtSendToPty(t.sid, t.prompt, t.kind);
      if (ok) {
        sentTargets.push(t);
        console.log(`[roundtable] turn ${turnNum} ${mode} sent to ${t.kind}(${t.sid.slice(0,8)})`);
      } else {
        console.log(`[roundtable] turn ${turnNum} ${mode} skip ${t.kind}(${t.sid.slice(0,8)}): not ready`);
      }
    }));
    if (sentTargets.length === 0) {
      orch.rollbackTurn(turnNum);
      return { status: 'no_sent', turnNum };
    }

    // 等所有 sent 的 turn-complete；单家完成立即推 partial-update 给 renderer 单卡片刷新
    // Stage 2: Promise.all → Promise.allSettled，单家卡死/异常不阻塞整轮（其他家照常 settle）
    console.log(`[roundtable] turn ${turnNum} waiting for ${sentTargets.length} turn-complete`);
    const settled = await Promise.allSettled(sentTargets.map(t =>
      _rtWaitTurnComplete(t.sid, t.label, {
        meetingId, mode, turnNum,
        onPartial: (partial) => {
          console.log(`[roundtable] turn ${turnNum} partial: ${partial.label} ${partial.status} (${partial.text.length} chars)`);
          // Card redesign：转发 thinkSec/tokens 给 renderer 让卡片实时显示"本轮"统计
          sendToRenderer('roundtable-partial-update', {
            meetingId, turnNum, mode,
            sid: partial.sid, label: partial.label,
            status: partial.status, text: partial.text,
            thinkSec: partial.thinkSec, tokens: partial.tokens,
          });
        },
      })
    ));
    // watcher 自身不会 reject（settle 都走 resolve 路径），但 Promise.allSettled 兜底处理
    const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
      sid: sentTargets[i].sid,
      label: sentTargets[i].label,
      status: 'errored',
      text: '',
      reason: s.reason?.message || 'Promise rejected',
    });

    // 持久化轮记录
    // Stage 2 容错升级：构建 byMap + byStatus，让下个 turn 的 prompt builder 区分
    //   completed/manual_extracted（正常引用文本）vs absent/errored（明确加注未参与）。
    // Card redesign（2026-05-01）：构建 stats 让 orchestrator 累加 state.aiStats
    //   跨轮持久化"累计思考秒数 / 累计 tokens"，卡片 row3/row4 显示。
    const byMap = {};
    const byStatus = {};
    const thinkSecBy = {};
    const tokensBy = {};
    const thinkSecByKind = { claude: 0, gemini: 0, codex: 0 };
    const tokensByKind = { claude: 0, gemini: 0, codex: 0 };
    for (const r of results) {
      byMap[r.sid] = r.text || '';
      byStatus[r.sid] = r.status || 'completed';
      const thisSec = typeof r.thinkSec === 'number' ? r.thinkSec : 0;
      const thisTok = (r.tokens && typeof r.tokens.total === 'number') ? r.tokens.total : 0;
      thinkSecBy[r.sid] = thisSec;
      tokensBy[r.sid] = thisTok;
      // 找出该 sid 对应 kind 累加（sentTargets 里有 kind 字段）
      const target = sentTargets.find(t => t.sid === r.sid);
      const kind = target ? target.kind : null;
      if (kind && thinkSecByKind[kind] !== undefined) thinkSecByKind[kind] += thisSec;
      if (kind && tokensByKind[kind] !== undefined) tokensByKind[kind] += thisTok;
    }
    const meta = {};
    if (mode === 'summary') {
      meta.summarizer = summarizerKind;
      meta.summarizerSid = sentTargets[0]?.sid || null;
      const title = roundtable.extractDecisionTitle(results[0]?.text || '');
      if (title) meta.decisionTitle = title;
    }
    orch.completeTurn(turnNum, mode, userInput || '', byMap, meta, byStatus, {
      thinkSecBy, tokensBy, thinkSecByKind, tokensByKind,
    });

    // E2 选项：summary 后写决策档案到 .arena/sessions/<datetime>-<title>.md
    if (mode === 'summary') {
      try {
        const claudeSid = sidByKind('claude');
        const claudeSession = claudeSid ? sessionManager.getSession(claudeSid) : null;
        const projectCwd = claudeSession ? claudeSession.cwd : null;
        if (projectCwd) {
          const sessionsDir = path.join(projectCwd, '.arena', 'sessions');
          fs.mkdirSync(sessionsDir, { recursive: true });
          const ts = new Date();
          const stamp = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}`;
          const titleSlug = (meta.decisionTitle || `session-${turnNum}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
          const fileName = `${stamp}-${titleSlug}.md`;
          const archiveTitle = meeting.scene === 'research' ? '# 投研圆桌决策档案' : '# 圆桌讨论决策档案';
          const lines = [
            archiveTitle,
            `- 标题：${meta.decisionTitle || '(未提供)'}`,
            `- 总结人：${meta.summarizer || 'unknown'}`,
            `- 完成时间：${ts.toLocaleString('zh-CN')}`,
            `- 会议室：${meetingId}`,
            `- 历史轮数：${orch.state.turns.length}`,
            '',
            `## 最终意见（${meta.summarizer}）`,
            '',
            results[0]?.text || '(无输出)',
            '',
            `## 全部历史轮次`,
            '',
          ];
          for (const t of orch.state.turns) {
            lines.push(`### 第 ${t.n} 轮 · ${t.mode}`);
            if (t.userInput) lines.push(`**用户输入**：${t.userInput}`);
            for (const [sid, text] of Object.entries(t.by || {})) {
              lines.push('', `#### ${sidLabelFn(sid)}`, text || '(无输出)');
            }
            lines.push('');
          }
          fs.writeFileSync(path.join(sessionsDir, fileName), lines.join('\n'), 'utf-8');
          console.log(`[roundtable] decision archived: ${fileName}`);
          meta.archivedTo = fileName;
        }
      } catch (e) {
        console.warn('[roundtable] archive failed:', e.message);
      }
    }

    sendToRenderer('roundtable-turn-complete', { meetingId, turnNum, mode, results, meta });
    return { status: 'completed', turnNum, results, meta };
  } finally {
    _roundtableInProgress.delete(meetingId);
  }
}

ipcMain.handle('roundtable:turn', async (_e, args) => {
  return await dispatchRoundtableTurn(args.meetingId, args);
});

ipcMain.handle('roundtable:get-state', (_e, { meetingId }) => {
  const meeting = meetingManager.getMeeting(meetingId);
  const sceneObj = meeting ? scenes.getScene(meeting.scene) : null;
  const orch = roundtable.getOrchestrator(getHubDataDir(), meetingId, sceneObj);
  return orch.getState();
});

// ===== Stage 2 容错升级（2026-05-01）— 圆桌逃生工具 IPC =====
//
// 这三个 IPC 让 UI 在某家 AI 卡死时绕过完成检测，不再让整个圆桌锁 10 分钟。
// 与 turn-completion-watcher 配合使用：watcher.wait() 期间，IPC 可以通过
// _activeWatchers Map 找到对应 watcher 并触发 manualExtract / skip。
//
// 调用前提：必须在某 turn 的 wait() 期间调用（即 watcher 还在 _activeWatchers 中）。
// turn 已结束（watcher 已 settle 并从 Map 移除）后调这些 IPC 返回 not_active。

// 一键提取：从 Gemini JSONL 直接读 sincePromptTs 之后的 content 拼接，
//   绕过完成检测设为该家本轮答案。仅 Gemini 需要（Claude/Codex 都有可靠 L1）。
ipcMain.handle('roundtable-manual-extract', async (_e, { meetingId, sid, sincePromptTs } = {}) => {
  if (!sid) return { ok: false, reason: 'missing sid' };
  const watcher = _activeWatchers.get(sid);
  if (!watcher) return { ok: false, reason: 'not_active', detail: 'no active watcher for this sid (turn may have ended)' };
  let extracted = null;
  try { extracted = await transcriptTap.extractLatestGeminiTurn(sid, sincePromptTs || 0); }
  catch (e) { return { ok: false, reason: 'extract_failed', detail: e.message }; }
  if (!extracted || !extracted.text) {
    return { ok: false, reason: 'no_content', detail: 'JSONL had no usable type:"gemini" lines after sincePromptTs' };
  }
  watcher.manualExtract(extracted.text);
  return { ok: true, text: extracted.text, lineCount: extracted.lineCount, source: extracted.source };
});

// 跳过本家：watcher settle 为 absent 状态，下游 prompt builder 过滤这家
//   （过滤逻辑由 commit 4 P0-14 落地；本 commit 只设状态）。
ipcMain.handle('roundtable-skip-participant', async (_e, { meetingId, sid } = {}) => {
  if (!sid) return { ok: false, reason: 'missing sid' };
  const watcher = _activeWatchers.get(sid);
  if (!watcher) return { ok: false, reason: 'not_active' };
  watcher.skip();
  return { ok: true };
});

// 重发该家：plan 中标为 P0.5 单独提交，本 commit 先 stub 占位避免 IPC 缺失。
//   完整实现需要重新走 _rtSendToPty + 新建一个 watcher，等单家重分发逻辑稳定后再补。
ipcMain.handle('roundtable-resend-participant', async (_e, { meetingId, sid } = {}) => {
  // TODO(P0.5): 实现单家重分发——重置 watcher、重发 prompt、重新等待 turn-complete
  console.warn(`[roundtable] resend-participant not yet implemented (sid=${sid?.slice(0, 8)})`);
  return { ok: false, reason: 'not_implemented', detail: 'resend is P0.5 backlog; use skip + new turn for now' };
});

ipcMain.handle('get-ring-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId);
});

ipcMain.handle('quick-summary', (_e, sessionId) => {
  // Authoritative-first: transcript tap (Stop hook / rollout / chats JSONL).
  // Falls back to marker scan from PTY ring buffer when tap has no value.
  // This makes buildContextSummary / checkDivergence pick up transcript-tap
  // content without changing each call site.
  const tapped = transcriptTap.getLastAssistantText(sessionId);
  if (tapped && tapped.trim()) return tapped;
  const raw = sessionManager.getSessionBuffer(sessionId);
  return summaryEngine.quickSummary(raw || '', sessionId);
});

ipcMain.handle('marker-status', (_e, sessionId) => {
  const raw = sessionManager.getSessionBuffer(sessionId);
  return summaryEngine.markerStatus(raw || '', sessionId);
});

// IF-C1（2026-05-01）— 修复 P0 阻塞 bug B：卡片"创建中"永久卡死。
//   原 isInitializing 用 markerStatus（检测 summary marker），AI ready 但无人问
//   过时永远是 'none' → 卡片永远显示"创建中"。本 IPC 复用圆桌发送侧已用的
//   _RT_READY_MARKERS，按 buffer 长度/marker 判断 CLI 是否真就绪。renderer 每
//   秒 invoke 一次，缓存到 _cliReadyCache[sid] 驱动 isInitializing 判断。
ipcMain.handle('cli-ready-status', (_e, sessionId) => {
  if (!sessionId) return false;
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  const kind = session.kind;
  // 非 agent 类型（powershell 等）默认 ready，避免误判
  if (kind === 'powershell' || !_RT_READY_MARKERS[kind]) return true;
  const need = _RT_READY_MARKERS[kind];
  const buf = sessionManager.getSessionBuffer(sessionId) || '';
  // 空 markers（Claude/GLM）：buffer 长度 ≥ 1500 视为已 ready
  if (need.length === 0) return buf.length >= 1500;
  // 有 markers（Gemini/Codex）：任一 marker 出现视为 ready
  return need.some(m => buf.includes(m));
});

ipcMain.handle('get-marker-instruction', () => {
  return summaryEngine.getMarkerInstruction();
});

// Hub Timeline IPC: append a user turn to the meeting timeline.
// Renderer calls this when user submits a message in meeting room before
// the message goes to PTY(s).
ipcMain.handle('meeting-append-user-turn', (_e, { meetingId, text }) => {
  if (!meetingId || typeof text !== 'string' || !text) return null;
  const turn = meetingManager.appendTurn(meetingId, 'user', text, Date.now());
  if (turn) {
    sendToRenderer('meeting-timeline-updated', { meetingId, turn });
  }
  return turn;
});

// Hub Timeline IPC: full snapshot of meeting timeline (for Feed UI rerender).
ipcMain.handle('meeting-get-timeline', (_e, meetingId) => {
  // T11 fix: ensure timeline loaded from disk for restored (dormant) meetings;
  // loadTimelineLazy is idempotent (early-returns when already loaded).
  if (meetingId) meetingManager.loadTimelineLazy(meetingId);
  return meetingManager.getTimeline(meetingId);
});

// Hub Timeline IPC: compute incremental context for a target sub-session.
// Returns { turns: [...], advancedTo: int }. Side effect: cursor advanced.
// Renderer calls this in handleMeetingSend when syncContext is ON.
ipcMain.handle('meeting-incremental-context', (_e, { meetingId, targetSid }) => {
  if (!meetingId || !targetSid) return { turns: [], advancedTo: 0 };
  // T11 fix: ensure timeline loaded from disk before computing context
  // (otherwise restored meetings always return empty turns).
  meetingManager.loadTimelineLazy(meetingId);
  // Surface misconfiguration: cursor not registered for this target means
  // the sub-session was never added (or already removed) — silent empty
  // return would mask wrong meetingId / sid bugs in callers.
  if (meetingManager.getCursor(meetingId, targetSid) === null) {
    console.warn(`[meeting-ipc] incremental-context called with unregistered targetSid=${targetSid} in meetingId=${meetingId}`);
  }
  return meetingManager.incrementalContext(meetingId, targetSid);
});

// Read the authoritative last-assistant text captured by the transcript tap.
// Returns null if no tap backend has fired for this session yet (CLI hasn't
// finished a turn, hook hasn't triggered, or file path couldn't be resolved).
// Renderer falls back to marker-based extraction when null.
ipcMain.handle('get-last-assistant-text', (_e, sessionId) => {
  return transcriptTap.getLastAssistantText(sessionId);
});

function collectAgentOutputs(meetingId) {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return null;
  const outputs = {};
  for (const sid of meeting.subSessions) {
    // Authoritative-first: transcript tap, then marker scan fallback.
    let content = transcriptTap.getLastAssistantText(sid);
    if (!content || !content.trim()) {
      const raw = sessionManager.getSessionBuffer(sid);
      content = summaryEngine.extractMarker(raw || '', sid);
    }
    if (content) {
      const session = sessionManager.getSession(sid);
      const label = session ? (session.kind || 'AI') : 'AI';
      outputs[label] = content;
    }
  }
  return Object.keys(outputs).length >= 2 ? outputs : null;
}

ipcMain.handle('compress-context', async (_e, { content, maxChars }) => {
  return await summaryEngine.compressContext(content, maxChars || 1000);
});

ipcMain.handle('detect-divergence', async (_e, { meetingId }) => {
  const outputs = collectAgentOutputs(meetingId);
  if (!outputs) return { consensus: [], divergence: [] };
  return await summaryEngine.detectDivergence(outputs);
});

ipcMain.handle('deep-summary', async (_e, { sessionId, scene, question, agentName }) => {
  // Prefer authoritative transcript-tap content; fall back to PTY ring buffer
  // (which feeds extractMarker inside deepSummary). When tap has content we
  // synthesize a marker-wrapped string so deepSummary's existing extractMarker
  // path picks it up without changing the summary-engine API.
  const tapped = transcriptTap.getLastAssistantText(sessionId);
  let raw;
  if (tapped && tapped.trim()) {
    raw = `\nSM-START\n${tapped}\nSM-END\n`;
  } else {
    raw = sessionManager.getSessionBuffer(sessionId) || '';
  }
  if (!raw) return '';
  return await summaryEngine.deepSummary(raw, { agentName, question, scene });
});

ipcMain.handle('get-summary-scenes', () => {
  return summaryEngine.getScenes();
});

// build-injection IPC 历史用于 blackboard 用户输入合成注入子会话(meeting-blackboard.js)。
// Module C 后 blackboard 已删除,该 handler 不再被任何前端代码调用,清理。

ipcMain.on('update-meeting', (_e, { meetingId, fields }) => {
  const updated = meetingManager.updateMeeting(meetingId, fields);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
});

ipcMain.handle('update-meeting-sync', (_e, { meetingId, fields }) => {
  const updated = meetingManager.updateMeeting(meetingId, fields);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  return !!updated;
});

// Scene covenant API（renderer 创建会议室对话框预填用）
ipcMain.handle('get-scene-covenant', (_e, sceneKey) => {
  const s = scenes.getScene(sceneKey || 'research');
  return s ? s.defaultCovenant : '';
});
// 兼容旧名（前端 Task 5 改完后可删）
ipcMain.handle('get-research-covenant-template', () => scenes.COVENANT_RESEARCH);

// 通用圆桌：开关 + 公约写盘 + 私聊存储
function _isValidMeetingId(id) {
  // 仅允许 uuid 风格的字母数字+连字符；阻止任何路径分隔符或控制字符
  return typeof id === 'string' && /^[a-zA-Z0-9_\-]+$/.test(id) && id.length > 0 && id.length < 256;
}

function _switchScene(meetingId, scene, covenant) {
  if (!_isValidMeetingId(meetingId)) return { ok: false, error: 'invalid meetingId' };
  if (!scenes.getScene(scene)) return { ok: false, error: `invalid scene: ${scene}` };
  const m = meetingManager.getMeeting(meetingId);
  if (!m) return { ok: false, error: 'meeting not found' };
  const fields = { scene };
  if (typeof covenant === 'string') fields.covenantText = covenant;
  let updated;
  try { updated = meetingManager.updateMeeting(meetingId, fields); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!updated) return { ok: false, error: 'update failed' };
  const text = typeof covenant === 'string' ? covenant : (updated.covenantText || '');
  try {
    scenes.writeCovenantSnapshot(getHubDataDir(), meetingId, text);
    scenes.writePromptFile(getHubDataDir(), meetingId, scene, text);
  } catch (e) {
    console.warn(`[switch-scene] write prompt files failed: ${e.message}`);
  }
  sendToRenderer('meeting-updated', { meeting: updated });
  return { ok: true, meeting: updated };
}

ipcMain.handle('switch-scene', (_e, { meetingId, scene, covenant } = {}) => {
  return _switchScene(meetingId, scene, covenant);
});

// 兼容旧名（前端还在用，Task 5 改完后可删）
ipcMain.handle('toggle-roundtable-mode', (_e, { meetingId, enabled, covenant } = {}) => {
  if (!enabled) return { ok: true };
  return _switchScene(meetingId, 'general', covenant);
});

ipcMain.handle('roundtable-private:append', (_e, { meetingId, kind, userInput, response } = {}) => {
  if (!_isValidMeetingId(meetingId)) {
    return { ok: false, error: 'invalid meetingId' };
  }
  try {
    generalRoundtablePrivateStore.appendPrivateTurn(getHubDataDir(), meetingId, kind, userInput, response);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('roundtable-private:list', (_e, { meetingId, kind } = {}) => {
  if (!_isValidMeetingId(meetingId)) {
    return kind ? [] : { claude: [], gemini: [], codex: [] };
  }
  // 校验 kind：未传/null OK（返回全量 store），传了必须在白名单内，
  // 否则 listPrivateTurns 会 fallthrough 到全量返回，破坏白名单契约
  if (kind !== undefined && kind !== null && !['claude', 'gemini', 'codex'].includes(kind)) {
    return [];
  }
  try {
    return generalRoundtablePrivateStore.listPrivateTurns(getHubDataDir(), meetingId, kind);
  } catch (e) {
    console.warn(`[roundtable-private:list] failed: ${e.message}`);
    return kind ? [] : { claude: [], gemini: [], codex: [] };
  }
});

ipcMain.handle('get-meetings', () => {
  return meetingManager.getAllMeetings();
});

// Deep-summary IPC: generate structured meeting summary from full timeline via
// config-driven provider fallback chain (gemini-cli → deepseek-api). This is
// distinct from the older `'deep-summary'` channel above (single-session marker
// summary). Returns the full service result envelope (status / data / _meta).
ipcMain.handle('generate-meeting-summary', async (_event, meetingId) => {
  try {
    // T11 fix: ensure timeline loaded from disk (otherwise restored meetings
    // produce summaries from 0 turns).
    if (meetingId) meetingManager.loadTimelineLazy(meetingId);
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) {
      return {
        status: 'failed',
        _meta: { last_error: `meeting not found: ${meetingId}`, parse_status: 'failed' },
      };
    }
    const timeline = meetingManager.getTimeline(meetingId);
    const labelMap = new Map();
    const presentAIs = new Set(['user']);
    for (const sid of meeting.subSessions) {
      const s = sessionManager.sessions.get(sid);
      if (s && s.info) {
        labelMap.set(sid, { label: s.info.title || s.info.kind || 'AI', kind: s.info.kind });
        if (s.info.kind) presentAIs.add(s.info.kind);
      }
    }
    return await deepSummaryService.generate(timeline, presentAIs, labelMap);
  } catch (e) {
    console.error('[generate-meeting-summary] error:', e);
    return {
      status: 'failed',
      _meta: { last_error: e.message, parse_status: 'failed' },
    };
  }
});

ipcMain.handle('get-deep-summary-config', async () => _deepSummaryConfig.ui);

// Archive scanner: enumerate past Claude Code sessions for the Resume picker.
const sessionArchive = require('./core/session-archive.js');
ipcMain.handle('list-past-sessions', async (_e, { limit = 50 } = {}) => {
  try { return await sessionArchive.listRecent(limit); }
  catch (e) { console.warn('[hub] list-past-sessions failed:', e.message); return []; }
});

ipcMain.handle('search-past-sessions', async (_e, { query, limit = 50 } = {}) => {
  try { return await sessionArchive.searchAcross(query, { limit }); }
  catch (e) { console.warn('[hub] search-past-sessions failed:', e.message); return { hits: [], truncated: false }; }
});

ipcMain.handle('close-session', (_e, sessionId) => {
  // No explicit sendToRenderer here — closeSession kills the PTY, which fires
  // the onExit callback wired up above (line 87) and emits session-closed for
  // us. Emitting twice would spam the renderer for no benefit.
  sessionManager.closeSession(sessionId);
});

ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
  sessionManager.writeToSession(sessionId, data);
});

ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows }) => {
  sessionManager.resizeSession(sessionId, cols, rows);
});

ipcMain.on('focus-session', (_e, { sessionId }) => {
  sessionManager.setFocusedSession(sessionId);
  sessionManager.markRead(sessionId);
});

ipcMain.handle('rename-session', (_e, { sessionId, title }) => {
  const session = sessionManager.renameSession(sessionId, title);
  if (session) sendToRenderer('session-updated', { session });
  return session;
});

ipcMain.handle('get-sessions', () => {
  return sessionManager.getAllSessions();
});

// Diagnostic: read the PTY ring buffer for a session (used by E2E smoke tests).
ipcMain.handle('debug:get-session-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId);
});

// --- Dormant session persistence ---
// On boot we read state.json; those entries become dormant (sidebar entries
// with no live PTY). User clicks dormant session → resume-session IPC spawns
// PTY with `claude --resume <ccSessionId>`.
const bootState = stateStore.load();
const bootWasClean = bootState.cleanShutdown;
let lastPersistedSessions = Array.isArray(bootState.sessions) ? bootState.sessions : [];
// Heal any cwds that legacy code corrupted (see extractCwdFromTranscript).
// This reads CC's own JSONL transcripts which carry the authoritative cwd.
const healed = healPersistedCwds(lastPersistedSessions);
if (healed > 0) console.log(`[hub] healed ${healed} stale cwd(s) from CC transcripts`);
// Restore persisted meetings on boot
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
for (const m of bootMeetings) {
  if (m.layout === 'split') m.layout = 'focus';
  meetingManager.restoreMeeting(m);
}

// Flip cleanShutdown to false immediately on boot; before-quit will flip it back.
stateStore.save({ version: 1, cleanShutdown: false, sessions: lastPersistedSessions, meetings: bootMeetings }, { sync: true });

ipcMain.handle('get-dormant-meetings', () => meetingManager.getAllMeetings());

// Lazy load timeline for a restored meeting (called when user opens the meeting view).
// Idempotent: safe to call multiple times; second+ call returns same in-memory state.
ipcMain.handle('meeting-load-timeline', (_e, meetingId) => {
  if (!meetingId) return { ok: false, reason: 'missing meetingId' };
  const ok = meetingManager.loadTimelineLazy(meetingId);
  if (!ok) return { ok: false, reason: 'no persisted timeline (or meeting unknown)' };
  return {
    ok: true,
    timeline: meetingManager.getTimeline(meetingId),
  };
});

ipcMain.handle('get-dormant-sessions', () => ({
  sessions: lastPersistedSessions,
  wasCleanShutdown: bootWasClean,
}));

ipcMain.on('persist-sessions', (_e, list, meetingList) => {
  if (!Array.isArray(list)) return;
  // Preserve resume meta fields (codexSid/geminiChatId/geminiProjectHash/geminiProjectRoot)
  // that renderer is unaware of. Without this merge, every renderer schedulePersist
  // would silently wipe these fields populated by transcript-tap session-bound handler.
  const RESUME_META_FIELDS = ['codexSid', 'geminiChatId', 'geminiProjectHash', 'geminiProjectRoot'];
  const oldByHubId = new Map(lastPersistedSessions.map(s => [s.hubId, s]));
  for (const newSession of list) {
    if (!newSession || !newSession.hubId) continue;
    const oldSession = oldByHubId.get(newSession.hubId);
    if (!oldSession) continue;
    for (const field of RESUME_META_FIELDS) {
      // T14 fix: use nullish (== null matches both null and undefined).
      // T10 changed renderer to explicitly emit `field: s.field || null`,
      // so the original `=== undefined` check never triggered → fields got
      // wiped by every schedulePersist (race condition with T7 listener save).
      if (newSession[field] == null && oldSession[field] != null) {
        newSession[field] = oldSession[field];
      }
    }
  }
  lastPersistedSessions = list;
  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: list,
    meetings: Array.isArray(meetingList) ? meetingList : meetingManager.getAllMeetings(),
  });
});

// Wake a dormant session: spawn PTY with the same hubId, reusing stored cwd,
// CC session id, title. The session-manager handles `claude --resume <id>` or
// `--continue` as fallback when we don't have a CC id recorded.
ipcMain.handle('resume-session', async (_e, meta) => {
  if (!meta || !meta.hubId) return null;
  const isClaude = (meta.kind === 'claude' || meta.kind === 'claude-resume');
  const isDeepSeek = (meta.kind === 'deepseek');
  const isGlm = (meta.kind === 'glm');
  const isClaudeCliResumable = isClaude || isDeepSeek || isGlm;
  const isGeminiOrCodex = (meta.kind === 'gemini' || meta.kind === 'codex');

  // resume 时根据会议模式重新注入 prompt 文件(research/general 公约)。
  // 注意三家 CLI 各走自己的注入字段(与 add-meeting-sub 对齐):
  //   Claude  → appendSystemPromptFile (CLI 参数)
  //   Gemini  → extraEnv.GEMINI_SYSTEM_MD (env)
  //   Codex   → codexInstructionFile (CLI 参数)
  let resumeOpts = {};
  if (meta.meetingId) {
    const meeting = meetingManager.getMeeting(meta.meetingId);
    let promptFile = null;
    if (meeting && meeting.scene) {
      const hubDataDir = getHubDataDir();
      const covenantText = (typeof meeting.covenantText === 'string' && meeting.covenantText.length > 0)
        ? meeting.covenantText
        : scenes.readCovenantSnapshot(hubDataDir, meta.meetingId);
      promptFile = scenes.writePromptFile(hubDataDir, meta.meetingId, meeting.scene, covenantText);
    }
    if (promptFile) {
      if (isClaude || isGlm) {
        resumeOpts.appendSystemPromptFile = promptFile;
      } else if (meta.kind === 'gemini') {
        resumeOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
      } else if (meta.kind === 'codex') {
        resumeOpts.codexInstructionFile = promptFile;
      }
    }
  }

  const session = sessionManager.createSession(meta.kind || 'claude', {
    id: meta.hubId,
    title: meta.title,
    cwd: (meta.kind === 'gemini' && meta.geminiProjectRoot) ? meta.geminiProjectRoot : meta.cwd,
    meetingId: meta.meetingId || null,
    resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
    useContinue: isClaudeCliResumable && !meta.ccSessionId,
    useResume: isGeminiOrCodex,
    codexSid: meta.kind === 'codex' ? (meta.codexSid || null) : null,
    geminiChatId: meta.kind === 'gemini' ? (meta.geminiChatId || null) : null,
    geminiProjectRoot: meta.kind === 'gemini' ? (meta.geminiProjectRoot || null) : null,
    lastMessageTime: meta.lastMessageTime,
    lastOutputPreview: meta.lastOutputPreview,
    ...resumeOpts,
  });
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });

  // Level 3 fallback: when native resume is unavailable (Level 1+2 both fail),
  // inject transcript tail as [CONTEXT] block into PTY after spawn settles.
  const needsLevel3 = (
    (meta.kind === 'codex' && !meta.codexSid) ||
    (meta.kind === 'gemini' && !meta.geminiChatId)
  );

  if (needsLevel3) {
    const { readTranscriptTail } = require('./core/session-manager');
    let sourcePath = null;
    if (meta.kind === 'gemini' && meta.geminiProjectHash && meta.geminiChatId) {
      try {
        const dir = require('path').join(require('os').homedir(), '.gemini', 'tmp', meta.geminiProjectHash, 'chats');
        const f = require('fs').readdirSync(dir).find(n => n.includes(meta.geminiChatId));
        if (f) sourcePath = require('path').join(dir, f);
      } catch {}
    }
    // Note: Codex Level 3 not implemented in this PR — sourcePath stays null,
    // so codex falls through to Level 2 (`codex resume --last`) which T8 already handles.
    // If future need: derive from `~/.codex/sessions/<YYYY/MM/DD>/rollout-<...>-<sid>.jsonl`.

    if (sourcePath) {
      readTranscriptTail(meta.kind, sourcePath, 10).then(tail => {
        if (!tail) return;
        const msg = `[CONTEXT FROM PREVIOUS SESSION]\n${tail}\n\n[END CONTEXT]\n`;
        // Wait 5s for spawn to settle (covers Gemini cold start ~3-5s; was 2s but T13 fix found
        // it could collide with CLI banner). Verify session still alive before inject.
        setTimeout(() => {
          try {
            const sess = sessionManager.getSession(session.id);
            if (!sess || sess.status === 'dormant') {
              console.warn(`[hub] Level 3 inject skipped: session ${session.id.slice(0,8)} no longer active`);
              return;
            }
            sessionManager.writeToSession(session.id, msg);
            console.log(`[hub] Level 3 fallback: injected ${tail.length}-char transcript tail to ${meta.kind} session ${session.id.slice(0,8)}`);
          } catch (e) {
            console.warn(`[hub] Level 3 inject failed:`, e.message);
          }
        }, 5000);
      }).catch(e => console.warn('[hub] Level 3 fallback error:', e.message));
    }
  }

  return session;
});

// Restart a Claude/PowerShell session in place: close old PTY, spawn a new one
// with the same kind. The session gets a new id because PTY identity changes.
ipcMain.handle('restart-session', (_e, sessionId) => {
  const old = sessionManager.getSession(sessionId);
  if (!old) return null;
  // closeSession triggers the onExit callback which emits session-closed;
  // don't emit it a second time here.
  sessionManager.closeSession(sessionId);
  const fresh = sessionManager.createSession(old.kind, {
    id: old.id,
    cwd: old.cwd,
    meetingId: old.meetingId || undefined,
  });
  registerSessionForTap(fresh);
  sendToRenderer('session-created', { session: fresh });
  return fresh;
});

// Show a Windows/OS notification. Renderer decides when to call it.
ipcMain.on('show-notification', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Claude Session Hub', body: body || '', silent: false });
  n.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
});

ipcMain.handle('is-window-focused', () => {
  return mainWindow ? mainWindow.isFocused() : false;
});

// --- Clipboard image paste support ---
const imageDir = path.join(getHubDataDir(), 'images');

ipcMain.handle('save-clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    fs.mkdirSync(imageDir, { recursive: true });

    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // 20260412143052
    const id = crypto.randomBytes(3).toString('hex'); // a1b2c3
    const filename = `${ts}-${id}.png`;
    const filePath = path.join(imageDir, filename);

    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  } catch (e) {
    console.warn('[hub] save-clipboard-image failed:', e.message);
    return null;
  }
});

// Let renderer inspect current hook server health for UI indicator.
ipcMain.handle('get-hook-status', () => ({
  up: hookPort !== null,
  port: hookPort,
}));

// Ctrl+click on a file path in the terminal routes here. shell.openPath
// launches the OS default handler (.md → markdown viewer, .png → image
// viewer, .html → browser, etc). Returns '' on success, error string on
// failure — we surface it back so renderer can log.
ipcMain.handle('open-path', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'empty path';
  try {
    return await shell.openPath(filePath);
  } catch (e) {
    return String(e && e.message || e);
  }
});

const READ_FILE_EXTS = new Set([
  '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php',
  '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less',
]);
ipcMain.handle('read-file', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'invalid path' };
  const ext = path.extname(filePath).toLowerCase();
  if (!READ_FILE_EXTS.has(ext)) return { error: 'unsupported extension' };
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) return { error: 'file too large (>5MB)' };
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { content };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// --- Mobile remote IPC handlers ---

ipcMain.handle('mobile:get-ips', () => {
  const nets = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
});

ipcMain.handle('mobile:get-port', () => {
  return (mobileSrv && mobileSrv.port) || 3470;
});

ipcMain.handle('mobile:create-pairing', async (_e, { addresses, deviceName }) => {
  const token = mobileAuth.generateToken();
  const port = (mobileSrv && mobileSrv.port) || 3470;
  const addrs = (addresses && addresses.length) ? addresses : [`127.0.0.1:${port}`];
  const payload = Buffer.from(JSON.stringify(addrs)).toString('base64url');
  const first = addrs[0];
  const scheme = first.startsWith('http://') || first.startsWith('https://') ? '' : 'http://';
  const host = first.replace(/^https?:\/\//, '');
  const pairUrl = `${scheme}${host}/pair?token=${token}&addresses=${payload}&name=${encodeURIComponent(deviceName || 'Phone')}`;
  if (!QRCode) QRCode = require('qrcode');
  const qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 360 });
  return { token, pairUrl, qrDataUrl };
});

ipcMain.handle('mobile:list-devices', () => mobileAuth.listDevices());

ipcMain.handle('mobile:revoke-device', (_e, deviceId) => {
  return mobileAuth.revokeDevice(deviceId);
});

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires Stop / UserPromptSubmit hooks. Forwards to renderer as IPC events.
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  const isResearchFetchStock = req.method === 'POST' && req.url === '/api/research/fetch-stock';
  const isResearchFetchConcept = req.method === 'POST' && req.url === '/api/research/fetch-concept';
  const isResearchFetchSector = req.method === 'POST' && req.url === '/api/research/fetch-sector';
  const isResearchFetch = isResearchFetchStock || isResearchFetchConcept || isResearchFetchSector;
  if (!isHook && !isStatus && !isResearchFetch) {
    res.writeHead(404); res.end('{}'); return;
  }

  // Cap body size at 16KB — statusline payloads are tiny, hooks tinier
  let body = '';
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    if (body.length + c.length > 16384) { tooBig = true; return; }
    body += c;
  });
  req.on('end', async () => {
    if (tooBig) { res.writeHead(413); res.end('{}'); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    // Research mode MCP callbacks (loopback)：fetch_lindang_stock / fetch_concept_stocks / fetch_sector_overview
    if (isResearchFetch) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      const { meetingId, kind, symbol, name, concept, top_n, sector } = parsed;
      const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
      if (!meeting || meeting.scene !== 'research') {
        res.writeHead(400); res.end('{"error":"not research mode"}'); return;
      }
      const t0 = Date.now();
      let result;
      try {
        if (isResearchFetchStock) {
          result = await lindangBridge.fetchStock(symbol, name);
        } else if (isResearchFetchConcept) {
          result = await lindangBridge.fetchConcept(concept, top_n || 10);
        } else {
          result = await lindangBridge.fetchSector(sector);
        }
      } catch (e) {
        result = { ok: false, error: 'bridge throw: ' + e.message };
      }
      const elapsed = Date.now() - t0;
      console.log(`[research] ${req.url.split('/').pop()} kind=${kind} elapsed=${elapsed}ms ok=${result.ok}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }
    if (parsed.token !== HOOK_TOKEN) {
      res.writeHead(403); res.end('{}'); return;
    }
    if (parsed.sessionId && sessionManager.getSession(parsed.sessionId)) {
      if (isHook) {
        const event = req.url.slice('/api/hook/'.length); // 'stop' or 'prompt'
        // Prefer the UserPromptSubmit payload's `prompt` field when present —
        // it's the just-submitted text and doesn't depend on CC having flushed
        // the new transcript entry to disk. For Stop events (no `prompt` in
        // payload) fall back to reading the transcript JSONL tail (async —
        // long transcripts used to block the main-process event loop).
        let latestUserMessage = null;
        if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
          latestUserMessage = parsed.prompt;
        } else if (parsed.transcriptPath) {
          latestUserMessage = await readLastUserMessage(parsed.transcriptPath);
        }
        // Feed the Claude transcript tap so the Hub timeline (research/general)
        // gets the authoritative final assistant turn. Only fire on Stop events
        // — UserPromptSubmit fires before the assistant has responded, so the
        // transcript tail's last-assistant entry would be the previous turn
        // and immediately trigger a stale update.
        if (event === 'stop' && parsed.transcriptPath) {
          transcriptTap.notifyClaudeStop(parsed.sessionId, parsed.transcriptPath).catch(() => {});
        }
        sendToRenderer('hook-event', {
          event,
          sessionId: parsed.sessionId,
          claudeSessionId: parsed.claudeSessionId,
          cwd: parsed.cwd,
          latestUserMessage,
        });
      } else {
        const filtered = claudeUsageFilter.filter(parsed.usage5h, parsed.usage7d);
        sendToRenderer('status-event', {
          sessionId: parsed.sessionId,
          contextPct: parsed.contextPct,
          contextUsed: parsed.contextUsed,
          contextMax: parsed.contextMax,
          usage5h: filtered.usage5h,
          usage7d: filtered.usage7d,
          model: parsed.model,
          sessionName: parsed.sessionName,
          cwd: parsed.cwd,
          apiMs: parsed.apiMs,
          linesAdded: parsed.linesAdded,
          linesRemoved: parsed.linesRemoved,
        });
        if (filtered.anyAccepted) cacheAccountUsage({ usage5h: filtered.usage5h, usage7d: filtered.usage7d });
      }
    }
    res.writeHead(200); res.end('{}');
  });
});

// Try candidate ports in order; return the first that listens successfully.
// Any bind error on a candidate (EADDRINUSE, EACCES, EPERM, …) falls through
// to the next; only when all candidates fail do we give up.
function listenWithFallback() {
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= HOOK_PORT_CANDIDATES.length) return resolve(null);
      const port = HOOK_PORT_CANDIDATES[idx++];
      hookServer.removeAllListeners('error');
      hookServer.removeAllListeners('listening');
      hookServer.once('error', (e) => {
        console.warn(`[hub] hook server bind failed on :${port} (${e.code}): ${e.message}`);
        tryNext();
      });
      hookServer.once('listening', () => resolve(port));
      hookServer.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

// --- Account usage cache ---
// Persist the latest Claude account usage so the sidebar renders immediately on
// restart without waiting for the first statusline callback.
const USAGE_CACHE_FILE = path.join(getHubDataDir(), 'usage-cache.json');

// See core/usage-filter.js for why this filter exists (rate_limits monotonic
// within a window — stale low-pct snapshots from idle sessions must not
// overwrite the true usage from heavy sessions).
const claudeUsageFilter = createUsageFilter();
try { claudeUsageFilter.seed(loadUsageCache().claude); } catch {}

function cacheAccountUsage(data) {
  try {
    const existing = loadUsageCache();
    const cur = existing.claude || {};
    existing.claude = {
      usage5h: data.usage5h || cur.usage5h || null,
      usage7d: data.usage7d || cur.usage7d || null,
      ts: Date.now(),
    };
    fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(existing));
  } catch {}
}

function cacheAgentUsage(provider, tokenData) {
  try {
    const existing = loadUsageCache();
    existing[provider] = { ...tokenData, ts: Date.now() };
    fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(existing));
  } catch {}
}

function loadUsageCache() {
  try { return JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

ipcMain.handle('get-usage-cache', () => loadUsageCache());

// --- Hub Config IPC handlers ---
// 配置 UI 和首次启动向导使用
const { getConfig, saveConfig, checkMissingConfig, clearConfigCache, getConfigPath, DEFAULTS } = require('./core/hub-config.js');

ipcMain.handle('get-hub-config', () => {
  const config = getConfig();
  return {
    proxy: config.proxy,
    deepseekApiKey: config.deepseekApiKey ? '***' + config.deepseekApiKey.slice(-4) : '',
    deepseekApiKeySet: !!config.deepseekApiKey,
    glmApiKey: config.glmApiKey ? '***' + config.glmApiKey.slice(-4) : '',
    glmApiKeySet: !!config.glmApiKey,
    glmBaseUrl: config.glmBaseUrl,
    glmModel: config.glmModel,
  };
});

ipcMain.handle('get-hub-config-raw', () => {
  // 返回完整配置（用于编辑），但 API key 仍然脱敏
  const config = getConfig();
  return {
    proxy: config.proxy,
    deepseekApiKey: config.deepseekApiKey || '',
    glmApiKey: config.glmApiKey || '',
    glmBaseUrl: config.glmBaseUrl,
    glmModel: config.glmModel,
  };
});

ipcMain.handle('save-hub-config', (_e, newConfig) => {
  // 读取现有 config.json（如果存在），合并更新
  const configPath = getConfigPath();
  let existing = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    existing = JSON.parse(raw);
  } catch {}

  // 合并配置
  const merged = {
    ...existing,
    proxy: { http: newConfig.proxy || DEFAULTS.proxy },
    providers: {
      ...(existing.providers || {}),
      deepseek: {
        ...(existing.providers?.deepseek || {}),
        api_key: newConfig.deepseekApiKey || undefined,
      },
      glm: {
        ...(existing.providers?.glm || {}),
        api_key: newConfig.glmApiKey || undefined,
        base_url: newConfig.glmBaseUrl || DEFAULTS.glm_base_url,
        model: newConfig.glmModel || DEFAULTS.glm_model,
      },
    },
  };

  // 清除空值
  if (!merged.providers.deepseek.api_key) delete merged.providers.deepseek.api_key;
  if (!merged.providers.glm.api_key) delete merged.providers.glm.api_key;

  saveConfig(merged);
  return { success: true };
});

ipcMain.handle('check-config-missing', () => {
  return checkMissingConfig();
});

ipcMain.handle('get-config-path', () => {
  return getConfigPath();
});

// --- Gemini/Codex ring-buffer usage scanner ---
// Periodically scans agent sessions' ring buffers for token/model patterns
// and emits status-event so the renderer can show context/usage badges.
const _agentLastStatus = new Map();
const _agentQuota = { gemini: null, codex: null };

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g, '');
}

function parseGeminiUsage(plain) {
  const result = {};
  // Gemini CLI footer 多种写法（不同版本 / locale）：
  //   (95% context left)  / (95% remaining) / · 95% context left / · 95% left
  //   N% context remaining / (N% 上下文剩余)（中文 locale）
  // 取最后一个匹配（buffer 末尾的 footer 才是当前实时数据，否则是历史滚动）
  const leftPatterns = [
    /\((\d+)%\s*context\s*left\)/gi,
    /\((\d+)%\s*context\s*remaining\)/gi,
    /\((\d+)%\s*left\)/gi,
    /\((\d+)%\s*remaining\)/gi,
    /·\s*(\d+)%\s*context\s*left/gi,
    /·\s*(\d+)%\s*left/gi,
    /(\d+)%\s*context\s*remaining/gi,
    /(\d+)%\s*上下文\s*剩余/gi,
  ];
  for (const re of leftPatterns) {
    let m;
    let last = null;
    while ((m = re.exec(plain)) !== null) last = m;
    if (last) {
      result.contextPct = 100 - parseInt(last[1], 10);
      break;
    }
  }
  // 旧主正则保留（顺手匹配 model + ctx）
  const leftMatch = plain.match(/(gemini[-\w.]+)\s*\((\d+)%\s*context\s*left\)/i);
  if (leftMatch) {
    result.model = { id: leftMatch[1], displayName: SessionManager.geminiDisplayName(leftMatch[1]) };
    if (result.contextPct == null) result.contextPct = 100 - parseInt(leftMatch[2], 10);
  }
  // Gemini CLI footer quota column: "N% used" — API quota, NOT context window
  const usedMatch = plain.match(/(gemini[-\w.]*[a-z])\s*(\d+)%\s*used/i);
  if (usedMatch) {
    if (!result.model) result.model = { id: usedMatch[1], displayName: SessionManager.geminiDisplayName(usedMatch[1]) };
    result.quotaPct = parseInt(usedMatch[2], 10);
  }
  if (!result.model) {
    const modelMatch = plain.match(/\b(gemini[-\w.]+)\b/i);
    if (modelMatch) result.model = { id: modelMatch[1], displayName: SessionManager.geminiDisplayName(modelMatch[1]) };
  }
  return result;
}

function parseCodexUsage(plain) {
  const result = {};
  // Codex CLI status bar: "Context 95% left"
  const ctxMatch = plain.match(/Context\s+(\d+)%\s+left/i);
  if (ctxMatch) {
    const remaining = parseInt(ctxMatch[1], 10);
    result.contextPct = 100 - remaining;
  }
  // Codex status bar: "gpt-5.4 medium" or "gpt-4.1-mini low"
  const modelMatch = plain.match(/\b(gpt-[\w.-]+|o\d-[\w.-]+)\b/i);
  if (modelMatch) {
    const id = modelMatch[1];
    result.model = { id, displayName: id };
  }
  // Exit summary: "Token usage: total=12,840 input=11,897 (+ 3,456 cached) output=943"
  const tokenMatch = plain.match(/Token usage:\s*total=([\d,]+)/i);
  if (tokenMatch) result.tokensUsed = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
  return result;
}

// --- Codex JSONL-based usage scanner ---
// Codex CLI writes authoritative rate_limits to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Each file contains token_count events with primary (5h) and secondary (7d) windows.
let _codexJsonlLastScan = 0;
let _codexJsonlCached = null;
const CODEX_JSONL_THROTTLE_MS = 30_000;

function scanCodexJsonlUsage() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const sessionsDir = path.join(home, '.codex', 'sessions');
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datePaths = [];
    datePaths.push(path.join(sessionsDir, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())));
    const yesterday = new Date(now.getTime() - 86400000);
    datePaths.push(path.join(sessionsDir, String(yesterday.getFullYear()), pad(yesterday.getMonth() + 1), pad(yesterday.getDate())));

    let newestEntry = null;
    for (const dir of datePaths) {
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')); } catch { continue; }
      const withStats = files.map(f => {
        const fp = path.join(dir, f);
        try { return { path: fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; }
      }).filter(Boolean);
      withStats.sort((a, b) => b.mtime - a.mtime);
      for (const file of withStats.slice(0, 3)) {
        const entry = extractCodexRateLimits(file.path);
        if (entry) { newestEntry = entry; break; }
      }
      if (newestEntry) break;
    }
    return newestEntry;
  } catch { return null; }
}

function extractCodexRateLimits(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count' && obj.payload.rate_limits) {
          const rl = obj.payload.rate_limits;
          const toMs = (t) => (typeof t === 'number' && t < 1e12) ? t * 1000 : t;
          const result = {};
          if (rl.primary && typeof rl.primary.used_percent === 'number') {
            result.usage5h = { pct: Math.round(rl.primary.used_percent), resetsAt: toMs(rl.primary.resets_at) };
          }
          if (rl.secondary && typeof rl.secondary.used_percent === 'number') {
            result.usage7d = { pct: Math.round(rl.secondary.used_percent), resetsAt: toMs(rl.secondary.resets_at) };
          }
          if (result.usage5h || result.usage7d) return result;
        }
      } catch { /* skip malformed lines */ }
    }
    return null;
  } catch { return null; }
}

function scanCodexJsonlUsageThrottled() {
  const now = Date.now();
  if (now - _codexJsonlLastScan < CODEX_JSONL_THROTTLE_MS && _codexJsonlCached) return _codexJsonlCached;
  _codexJsonlLastScan = now;
  _codexJsonlCached = scanCodexJsonlUsage();
  return _codexJsonlCached;
}

// Token-based rolling-window tracker for Gemini/Codex (fallback).
const AGENT_LIMITS = {
  gemini: { tokens5h: 2_000_000, tokens7d: 50_000_000 },
  codex:  { tokens5h: 1_000_000, tokens7d: 10_000_000 },
};
const _agentTokenLog = { gemini: [], codex: [] }; // [{ts, tokens}]

function recordAgentTokens(kind, tokens) {
  if (!_agentTokenLog[kind]) return;
  _agentTokenLog[kind].push({ ts: Date.now(), tokens });
}

function calcAgentUsage(kind) {
  const log = _agentTokenLog[kind];
  if (!log) return null;
  const now = Date.now();
  const H5 = 5 * 3600 * 1000;
  const D7 = 7 * 86400 * 1000;
  // Prune entries older than 7d
  while (log.length && log[0].ts < now - D7) log.shift();
  const tok5h = log.filter(e => e.ts >= now - H5).reduce((s, e) => s + e.tokens, 0);
  const tok7d = log.reduce((s, e) => s + e.tokens, 0);
  const lim = AGENT_LIMITS[kind];
  if (!lim) return null;
  if (tok5h === 0 && tok7d === 0) return null;
  return {
    usage5h: { pct: Math.min(100, Math.round(tok5h / lim.tokens5h * 100)), resetsAt: now + H5 },
    usage7d: { pct: Math.min(100, Math.round(tok7d / lim.tokens7d * 100)), resetsAt: now + D7 },
  };
}

function scanAgentSessions() {
  const allSessions = sessionManager.getAllSessions();
  for (const s of allSessions) {
    if (s.kind !== 'gemini' && s.kind !== 'codex') continue;
    if (s.status === 'dormant') continue;
    const buf = sessionManager.getSessionBuffer(s.id);
    if (!buf) continue;
    const plain = stripAnsi(buf);
    const parsed = s.kind === 'gemini' ? parseGeminiUsage(plain) : parseCodexUsage(plain);
    if (parsed.tokensUsed) {
      const prev = _agentLastStatus.get(s.id + ':tok');
      if (prev !== parsed.tokensUsed) {
        const delta = prev ? parsed.tokensUsed - prev : parsed.tokensUsed;
        if (delta > 0) recordAgentTokens(s.kind, delta);
        _agentLastStatus.set(s.id + ':tok', parsed.tokensUsed);
      }
    }
    // Gemini quotaPct → direct sidebar usage (real API quota from CLI footer)
    if (parsed.quotaPct != null) {
      const now = Date.now();
      const H5 = 5 * 3600 * 1000;
      const usageObj = { usage5h: { pct: parsed.quotaPct, resetsAt: now + H5 }, _ts: now };
      _agentQuota.gemini = usageObj;
    }
    if (!parsed.model && !parsed.tokensUsed && parsed.contextPct == null && parsed.quotaPct == null) continue;
    const prev = _agentLastStatus.get(s.id);
    const sig = JSON.stringify(parsed);
    if (prev === sig) continue;
    _agentLastStatus.set(s.id, sig);
    const payload = { sessionId: s.id };
    if (parsed.contextPct != null) payload.contextPct = parsed.contextPct;
    if (parsed.contextUsed != null) payload.contextUsed = parsed.contextUsed;
    if (parsed.contextMax != null) payload.contextMax = parsed.contextMax;
    if (parsed.model) payload.model = parsed.model;
    sendToRenderer('status-event', payload);
  }
  // Expire stale _agentQuota entries (no fresh CLI data for >10 min)
  const now = Date.now();
  for (const kind of ['gemini', 'codex']) {
    if (_agentQuota[kind] && _agentQuota[kind]._ts && now - _agentQuota[kind]._ts > 10 * 60 * 1000) {
      _agentQuota[kind] = null;
    }
  }
  // Build and broadcast per-provider usage.
  // Priority: Codex JSONL (authoritative) > ring buffer quota > token estimates.
  const agentData = {};
  // Codex: try JSONL first
  const codexJsonl = scanCodexJsonlUsageThrottled();
  if (codexJsonl) {
    agentData.codex = codexJsonl;
    cacheAgentUsage('codex', codexJsonl);
  } else if (_agentQuota.codex) {
    agentData.codex = _agentQuota.codex;
    cacheAgentUsage('codex', _agentQuota.codex);
  } else {
    const usage = calcAgentUsage('codex');
    if (usage) { agentData.codex = usage; cacheAgentUsage('codex', usage); }
  }
  // Gemini: quota from CLI footer > token estimates
  if (_agentQuota.gemini) {
    const gemData = { usage5h: _agentQuota.gemini.usage5h };
    const tokenUsage = calcAgentUsage('gemini');
    if (tokenUsage && tokenUsage.usage7d) gemData.usage7d = tokenUsage.usage7d;
    agentData.gemini = gemData;
    cacheAgentUsage('gemini', gemData);
  } else {
    const usage = calcAgentUsage('gemini');
    if (usage) { agentData.gemini = usage; cacheAgentUsage('gemini', usage); }
  }
  if (Object.keys(agentData).length > 0) sendToRenderer('agent-usage', agentData);
}

let _agentScanInterval = null;
function startAgentScanner() {
  if (_agentScanInterval) return;
  _agentScanInterval = setInterval(scanAgentSessions, 5000);
}

app.whenReady().then(async () => {
  const _home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  ensureHooksDeployed(path.join(_home, '.claude'));
  ensureHooksDeployed(path.join(_home, '.claude-deepseek'));
  ensureHooksDeployed(path.join(_home, '.claude-glm'));
  ensureCodexContextConfig();
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[hub] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
  } else {
    console.warn('[hub] hook server failed to bind — falling back to silence detection');
  }
  createWindow();
  startAgentScanner();
  // Mobile server starts after window — no need to block UI for phone pairing.
  try {
    mobileSrv = await createMobileServer({
      sessionManager,
      preferredPort: 3470,
      getDormantSessions: () => lastPersistedSessions,
    });
    console.log(`[mobile] listening on :${mobileSrv.port}`);
    global.__mobileSrv = mobileSrv;
  } catch (e) {
    console.error('[mobile] failed to start:', e);
    global.__mobileSrv = null;
  }
  // Push status to renderer after window is ready
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });
    });
  }
});

app.on('before-quit', async () => {
  stateStore.save({ version: 1, cleanShutdown: true, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings() }, { sync: true });
  if (mobileSrv) { try { await mobileSrv.close(); } catch {} }
  try {
    await meetingStore.flushAll();
    console.log('[hub] meeting-store flushed on quit');
  } catch (err) {
    console.warn('[hub] meeting-store flush failed:', err.message);
  }
});

app.on('window-all-closed', () => {
  hookServer.close();
  sessionManager.dispose();
  app.quit();
});
