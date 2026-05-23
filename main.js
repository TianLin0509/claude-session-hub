const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

// 2026-05-16 道雪：防卡死后门 — 默认开 Chromium CDP 端口（OS 自动分配）。
//   实际分配的端口在启动后写入 <dataDir>/control/<pid>.json 的 cdpPort 字段，
//   救援脚本 tools/hub-escape.ps1 + Playwright/DevTools 可 attach 进 Hub。
//   设环境变量 CLAUDE_HUB_NO_CDP=1 可关闭。
//   必须在 app.whenReady() 之前 appendSwitch 才生效。
//   注：如果启动命令行已经传了 --remote-debugging-port（E2E 测试用 hub-launcher 的场景），
//   不重复 append，避免 Chromium argv 冲突。
const _hasCdpSwitch = process.argv.some(a => a.startsWith('--remote-debugging-port'));
if (process.env.CLAUDE_HUB_NO_CDP !== '1' && !_hasCdpSwitch) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
const { SessionManager, clearSessionManagerConfigCache } = require('./core/session-manager.js');
const stateStore = require('./core/state-store.js');
const { getHubDataDir, isIsolatedHub, getMeetingWorkspaceDir } = require('./core/data-dir.js');
const hubControl = require('./core/hub-control.js');
const { MeetingRoomManager } = require('./core/meeting-room.js');
const meetingStore = require('./core/meeting-store.js');
const sessionStore = require('./core/session-store.js');
const { TranscriptTap } = require('./core/transcript-tap');
const { createUsageFilter } = require('./core/usage-filter.js');
const transcriptTap = new TranscriptTap();
// Resend & Auto-Recovery（2026-05-03）—— patch-listener 注册表（见 line 834 附近）会让
//   transcriptTap 在 5 分钟 patch 窗口内挂多个 listener。3 sub × 1 watcher/sub × 多轮重叠
//   ＞ Node 默认 10 个会触发 MaxListenersExceededWarning。提升上限到 100 安全冗余。
try { transcriptTap.setMaxListeners(100); } catch {}
const scenes = require('./core/group-chat-scenes.js');
const groupchat = require('./core/group-chat-orchestrator.js');
const cliReadyDetector = require('./core/group-chat-cli-ready-detector.js');
const lindangBridge = require('./core/lindang-bridge.js');
const { getConfig: getHubConfig } = require('./core/hub-config.js');
const packyBalance = require('./core/packy-balance.js');
const {
  resolveCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
} = require('./core/codex-usage-scope.js');
const { ALL_AI_KINDS, isClaudeFamily, isCodexCliKind, isClaudeWebKind, SLOT_IDS, KIND_LABELS, getSlotPromptName, getSlotDisplayLabel, slotIdToIndex, slotIndexToId } = require('./core/ai-kinds.js');
const { registerConfigIpc } = require('./main/ipc/config-handlers.js');
const { registerPathIpc } = require('./main/ipc/path-handlers.js');
const { registerSessionIpc } = require('./main/ipc/session-handlers.js');
const { registerUsageIpc } = require('./main/ipc/usage-handlers.js');
const { registerMeetingIpc } = require('./main/ipc/meeting-handlers.js');
const { registerMeetingCreateIpc } = require('./main/ipc/meeting-create-handlers.js');
const { registerMeetingTimelineIpc } = require('./main/ipc/meeting-timeline-handlers.js');
const { registerTranscriptIpc } = require('./main/ipc/transcript-handlers.js');
const codexAppRegistry = require('./core/codex-app-registry.js');
const { registerCliStatusIpc } = require('./main/ipc/cli-status-handlers.js');
const { registerPersistenceIpc } = require('./main/ipc/persistence-handlers.js');
const { registerAppUtilityIpc } = require('./main/ipc/app-utility-handlers.js');
const { registerGroupchatQueryIpc } = require('./main/ipc/groupchat-query-handlers.js');
const { registerGroupchatRecoveryIpc } = require('./main/ipc/groupchat-recovery-handlers.js');
const { registerGroupchatTurnIpc } = require('./main/ipc/groupchat-turn-handlers.js');
const { registerResumeSessionIpc } = require('./main/ipc/resume-session-handlers.js');
const { createGroupChatDispatcher } = require('./main/groupchat/dispatcher.js');
const { createAutoTitleManager } = require('./main/auto-title-manager.js');
const {
  extractCodexRateLimits,
  parseCodexUsage,
  parseGeminiUsage,
  stripAnsi,
} = require('./main/usage/agent-usage-parser.js');

function isCodexBaseKind(kind) {
  return isCodexCliKind(kind);
}
const { readLastAssistantMessage } = require('./core/read-last-assistant.js');
const { readTranscriptTail } = require('./core/session-manager');
const { parseClaudeTranscriptToTurns } = require('./core/claude-transcript-parser.js');
const {
  findTranscriptByCCSessionId,
  healPersistedCwds,
} = require('./core/claude-transcript-locator.js');
const {
  DEFAULT_CODEX_SESSIONS_ROOT,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
} = require('./core/codex-transcript-parser.js');
const { registerArchiveIpc } = require('./main/ipc/archive-handlers.js');

// === EPIPE 防护（隔离 Hub 启动必需）===
// PowerShell `& exe ...` + run_in_background 启动模式下，parent 退出后
// stdout/stderr 管道关闭。任何 console.log/warn/error 写入会触发 EPIPE，
// 未捕获时整个 Electron 主进程崩溃（红色 "JavaScript error" dialog）。
// 真实触发点：listenWithFallback 端口被占用时 console.warn → EPIPE → uncaught。
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.on('uncaughtException', (e) => {
  if (e && e.code === 'EPIPE') return;
  throw e;
});

const STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
const STARTUP_T0 = Date.now();
function traceStartup(msg) {
  if (!STARTUP_TRACE) return;
  console.log(`[startup +${Date.now() - STARTUP_T0}ms] ${msg}`);
}

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
      console.log(`[群聊] deployed ${file} -> ${dest}`);
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
    console.log('[群聊] settings.json updated with hook config');
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
          console.log(`[群聊] .claude.json trust fixed: ${projectDir}`);
        }
      }
      if (trustChanged) {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
        console.log('[群聊] .claude.json trust state updated');
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
    console.log('[群聊] codex config.toml patched with context-remaining');
  } catch (e) {
    console.warn('[群聊] codex config patch failed:', e.message);
  }
}

// Ensure Gemini CLI has arena-research MCP server registered. Gemini reads
// ~/.gemini/settings.json and auto-launches mcpServers entries on startup.
// We register the server with stdio transport, NO env field — the server
// inherits ARENA_* env from the gemini parent process. When gemini is started
// without ARENA_* env (user's standalone gemini, or non-research group chat),
// the server enters STUB mode and exposes no tools.
function ensureGeminiMcpInstalled() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const geminiDir = path.join(home, '.gemini');
  if (!fs.existsSync(geminiDir)) return;
  const settingsPath = path.join(geminiDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch { settings = {}; }
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {};
  }
  const researchMcpPath = path.resolve(__dirname, 'core', 'research-mcp-server.js');
  const desiredResearch = {
    command: process.execPath,
    args: [researchMcpPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  let dirty = false;
  if (JSON.stringify(settings.mcpServers['arena-research']) !== JSON.stringify(desiredResearch)) {
    settings.mcpServers['arena-research'] = desiredResearch;
    dirty = true;
  }
  if (!dirty) return;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[群聊] arena-research MCP installed into Gemini settings.json');
  } catch (e) {
    console.warn('[群聊] gemini mcp install failed:', e.message);
  }
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

let mainWindow;
const sessionManager = new SessionManager();
const meetingManager = new MeetingRoomManager();

// Deep-summary service singleton: instantiated from config-driven fallback chain.
// Providers tried in order; first one with a parseable response wins.

// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', (ev) => {
  const { hubSessionId, text, completedAt } = ev || {};
  const session = sessionManager.getSession(hubSessionId);
  if (session && session.meetingId) {
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
  }

  // spec2/S3：把 turn-complete 广播给 renderer，供历史会话/侧边栏卡片实时刷新。
  // 注意：这里独立于上面的 meeting timeline 逻辑——非群聊的普通会话也要广播。
  try {
    let transcriptPath = ev && ev.transcriptPath ? ev.transcriptPath : null;
    if (!transcriptPath && session && session.transcriptPath) {
      transcriptPath = session.transcriptPath;
    }
    if (!transcriptPath && session && session.ccSessionId) {
      try { transcriptPath = findTranscriptByCCSessionId(session.ccSessionId); } catch {}
    }
    sendToRenderer('turn-complete-event', {
      hubSessionId,
      ccSessionId: session ? session.ccSessionId : null,
      transcriptPath,
      text,
      completedAt: completedAt != null ? completedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      durationMs: ev ? ev.durationMs : null,
      signalSource: ev ? ev.signalSource : null,
    });
  } catch (e) {
    console.warn('[spec2/S3] turn-complete-event broadcast failed:', e && e.message);
  }
});

const autoTitleManager = createAutoTitleManager({
  allAiKinds: ALL_AI_KINDS,
  getHubConfig,
  kindLabels: KIND_LABELS,
  meetingManager,
  sendToRenderer,
  sessionManager,
});
const { maybeAutoTitleMeetingFromPrompt, maybeAutoTitleSessionFromPrompt } = autoTitleManager;
transcriptTap.on('prompt-submitted', (ev) => {
  const { hubSessionId, text, submittedAt } = ev || {};
  if (!hubSessionId) return;
  const session = sessionManager.getSession(hubSessionId);
  maybeAutoTitleSessionFromPrompt(ev);
  try {
    sendToRenderer('prompt-submitted-event', {
      hubSessionId,
      transcriptPath: ev ? ev.transcriptPath : null,
      text,
      submittedAt: submittedAt != null ? submittedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev ? ev.signalSource : null,
    });
  } catch (e) {
    console.warn('[codex prompt] prompt-submitted-event broadcast failed:', e && e.message);
  }
});

// Persist resume meta when transcript-tap binds a sub-session to its native CLI sid.
transcriptTap.on('session-bound', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  try {
    if (isCodexCliKind(ev.kind) && (ev.codexSid || ev.rolloutPath)) {
      const current = sessionManager.getSession(ev.hubSessionId);
      const patch = {};
      if (ev.codexSid) patch.codexSid = ev.codexSid;
      if (ev.rolloutPath) patch.transcriptPath = ev.rolloutPath;
      if (current && current.codexSessionsRoot) patch.codexSessionsRoot = current.codexSessionsRoot;
      if (current && current.codexAllowMtimeFallback) patch.codexAllowMtimeFallback = true;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    } else if (ev.kind === 'codex-app' && ev.threadId) {
      sessionManager.updateSessionMeta(ev.hubSessionId, { codexAppThreadId: ev.threadId });
    }
  } catch {}
  // Find the session in lastPersistedSessions and merge new fields.
  const idx = lastPersistedSessions.findIndex(s => s.hubId === ev.hubSessionId);
  if (idx < 0) {
    if (isCodexCliKind(ev.kind) && (ev.codexSid || ev.rolloutPath)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        codexSid: ev.codexSid,
        transcriptPath: ev.rolloutPath,
        codexSessionsRoot: sessionManager.getSession(ev.hubSessionId)?.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!sessionManager.getSession(ev.hubSessionId)?.codexAllowMtimeFallback,
      });
    } else if (ev.kind === 'codex-app' && ev.threadId) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        codexAppThreadId: ev.threadId,
      });
    }
    return;
  }
  const cur = lastPersistedSessions[idx];
  let changed = false;
  if (isCodexCliKind(ev.kind) && ev.codexSid && cur.codexSid !== ev.codexSid) {
    cur.codexSid = ev.codexSid;
    changed = true;
  }
  if (isCodexCliKind(ev.kind) && ev.rolloutPath && cur.transcriptPath !== ev.rolloutPath) {
    cur.transcriptPath = ev.rolloutPath;
    changed = true;
  }
  const liveSession = isCodexCliKind(ev.kind) ? sessionManager.getSession(ev.hubSessionId) : null;
  if (isCodexCliKind(ev.kind) && liveSession && liveSession.codexSessionsRoot && cur.codexSessionsRoot !== liveSession.codexSessionsRoot) {
    cur.codexSessionsRoot = liveSession.codexSessionsRoot;
    changed = true;
  }
  if (isCodexCliKind(ev.kind) && liveSession && liveSession.codexAllowMtimeFallback && cur.codexAllowMtimeFallback !== true) {
    cur.codexAllowMtimeFallback = true;
    changed = true;
  }
  if (ev.kind === 'codex-app' && ev.threadId && cur.codexAppThreadId !== ev.threadId) {
    cur.codexAppThreadId = ev.threadId;
    changed = true;
  }
  if (ev.kind === 'gemini') {
    if (ev.geminiChatId && cur.geminiChatId !== ev.geminiChatId) { cur.geminiChatId = ev.geminiChatId; changed = true; }
    if (ev.geminiProjectHash && cur.geminiProjectHash !== ev.geminiProjectHash) { cur.geminiProjectHash = ev.geminiProjectHash; changed = true; }
    if (ev.geminiProjectRoot && cur.geminiProjectRoot !== ev.geminiProjectRoot) { cur.geminiProjectRoot = ev.geminiProjectRoot; changed = true; }
  }
  if (changed) {
    cur.updatedAt = Date.now();  // 让后续 stateStore merge 用最新版本胜出
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
      immersiveByMeeting: _immersiveByMeeting,
    });
    // 2026-05-07 道雪：sid 类字段一旦确定就立刻 sync 写 per-session JSON。
    //   不靠 200ms debounce，不靠 state.json 防抖 500ms——任何一个 race / crash
    //   都不会再让 Codex/Gemini 的 transcript 关联丢失。
    try { sessionStore.markDirtySync(ev.hubSessionId, cur); }
    catch (e) { console.warn('[hub] sessionStore sync persist failed:', e.message); }

    // Spec 3 · W12：广播给 renderer 让 sessions Map 即刻同步（之前只写磁盘，
    // renderer 内存不更新 → codex/gemini 的 resume meta 必须 reboot 才生效）
    sendToRenderer('session-meta-updated', {
      hubSessionId: ev.hubSessionId,
      kind: ev.kind,
      codexSid: cur.codexSid,
      transcriptPath: cur.transcriptPath,
      codexSessionsRoot: cur.codexSessionsRoot,
      codexAllowMtimeFallback: !!cur.codexAllowMtimeFallback,
      codexAppThreadId: cur.codexAppThreadId,
      geminiChatId: cur.geminiChatId,
      geminiProjectHash: cur.geminiProjectHash,
      geminiProjectRoot: cur.geminiProjectRoot,
    });
    console.log(`[群聊] persisted resume meta for ${ev.kind} session ${ev.hubSessionId.slice(0,8)}`);
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
  // 2026-05-03 道雪：标题带 PID，方便桌面同时存在多个 Hub 窗口（生产+测试）时
  //   一眼区分哪个对应哪个 PID — 调试时不再需要 Get-Process 反查。
  const _hubTitle = `AI 群聊 Hub：PID ${process.pid}${_pkgVersion ? ` v${_pkgVersion}` : ''}`;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: _hubTitle,
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
  // index.html 的 <title>AI 群聊 Hub</title> 在页面加载完成后会触发 page-title-updated 覆盖
  // BrowserWindow.title — preventDefault 阻止覆盖，保留带 PID 的标题
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); });

  if (!winIcon.isEmpty()) {
    mainWindow.setIcon(winIcon);
  } else {
    console.warn('[icon] failed to load', iconPath);
  }

  let hasShown = false;
  const showMainWindow = () => {
    if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;
    hasShown = true;
    mainWindow.maximize();
    mainWindow.show();
  };
  ipcMain.once('renderer-sidebar-ready', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    traceStartup('did-finish-load');
    sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });
  });
  setTimeout(showMainWindow, 4000);

  // 主 webContents 导航防护（2026-05-17 道雪）：renderer 若误把 https 链接渲染成
  //   <a> 或 location.href = url，会让主 webContents 整个 navigate 走，preload IPC
  //   失效、Hub 卡死。把外部协议一律转发系统浏览器，主窗口只允许 file://。
  //   webview 内部导航走 webview 的 webContents，不受这里影响。
  const isInternalNavUrl = (urlStr) => {
    try {
      const u = new URL(urlStr);
      return u.protocol === 'file:' || u.protocol === 'about:' || u.protocol === 'chrome:' || u.protocol === 'devtools:';
    } catch { return true; }
  };
  const interceptNavigate = (event, urlStr) => {
    if (isInternalNavUrl(urlStr)) return;
    event.preventDefault();
    console.log('[nav-guard] block main webContents navigate to', urlStr, '→ openExternal');
    shell.openExternal(urlStr).catch((e) => console.warn('[nav-guard] openExternal failed:', e && e.message));
  };
  mainWindow.webContents.on('will-navigate', interceptNavigate);
  mainWindow.webContents.on('will-redirect', interceptNavigate);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalNavUrl(url)) return { action: 'allow' };
    shell.openExternal(url).catch((e) => console.warn('[nav-guard] openExternal failed:', e && e.message));
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

let groupChatDispatcher = null;

sessionManager.onData = (sessionId, data) => {
  sendToRenderer('terminal-data', { sessionId, data });
};

sessionManager.onSessionClosed = (sessionId, meetingId, exitInfo) => {
  groupChatDispatcher?.markProcessExitForSession(sessionId, exitInfo);

  try { transcriptTap.unregisterSession(sessionId); } catch {}
  // 群聊 cli-ready monotonic guard 清理（独立模块，详见 core/group-chat-cli-ready-detector.js）
  try { cliReadyDetector.cleanup(sessionId); } catch {}
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
  try {
    transcriptTap.registerSession(session.id, session.kind, {
      cwd: session.cwd,
      transcriptPath: session.transcriptPath || undefined,
      sessionsRoot: session.codexSessionsRoot || undefined,
      codexSid: session.codexSid || undefined,
      allowMtimeFallback: !!session.codexAllowMtimeFallback,
    });
  }
  catch (e) {
    // silent-failure-hunter L2（2026-05-04 道雪）：注册失败 → watcher 收不到 turn-complete L1
    //   信号 → 群聊等到 180s 软提醒才感知该家"卡住"。日志方便定位根因。
    console.warn('[tap] registerSession failed for', session.id.slice(0, 8), session.kind, ':', e && e.message);
  }
}

function updateSessionTranscriptBinding(hubSessionId, fields = {}) {
  if (!hubSessionId) return null;
  const next = {};
  if (fields.ccSessionId) next.ccSessionId = fields.ccSessionId;
  if (fields.transcriptPath) next.transcriptPath = fields.transcriptPath;
  if (Object.keys(next).length === 0) return null;
  const current = sessionManager.getSession(hubSessionId);
  if (!current) return null;
  const changed = Object.keys(next).some(k => current[k] !== next[k]);
  if (!changed) return current;
  const updated = sessionManager.updateSessionMeta(hubSessionId, next);
  if (updated) {
    sendToRenderer('session-updated', { session: updated });
    sendToRenderer('session-meta-updated', { hubSessionId, ...next });
  }
  return updated || null;
}

registerMeetingCreateIpc(ipcMain, {
  fs,
  getHookPort: () => hookPort,
  getHubDataDir,
  getMeetingWorkspaceDir,
  getSlotPromptName,
  groupchat,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isCodexBaseKind,
  isIsolatedHub,
  kindLabels: KIND_LABELS,
  meetingManager,
  path,
  registerSessionForTap,
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
});

registerMeetingIpc(ipcMain, {
  deleteImmersiveByMeeting: (meetingId) => { delete _immersiveByMeeting[meetingId]; },
  getHubDataDir,
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedSessions: () => lastPersistedSessions,
  groupchat,
  meetingManager,
  scenes,
  sendToRenderer,
  sessionManager,
  sessionStore,
  slotIds: SLOT_IDS,
  stateStore,
});

// =====================================================================
// Group Chat Mode dispatch
// =====================================================================
groupChatDispatcher = createGroupChatDispatcher({
  cliReadyDetector,
  getHubDataDir,
  groupchat,
  isCodexBaseKind,
  kindLabels: KIND_LABELS,
  maybeAutoTitleMeetingFromPrompt,
  meetingManager,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});

registerGroupchatTurnIpc(ipcMain, {
  dispatchGroupChatTurn: groupChatDispatcher.dispatchGroupChatTurn,
});

registerGroupchatQueryIpc(ipcMain, {
  getHubDataDir,
  groupchat,
  transcriptTap,
});

registerGroupchatRecoveryIpc(ipcMain, {
  getHubDataDir,
  getActiveWatchers: groupChatDispatcher.getActiveWatchers,
  groupchat,
  groupChatWatcher: groupChatDispatcher.getGroupChatWatcher(),
  meetingManager,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});
registerCliStatusIpc(ipcMain, {
  cliReadyDetector,
  sessionManager,
});

registerTranscriptIpc(ipcMain, {
  codexAppRegistry,
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutByCwd,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  isCodexCliKind,
  parseClaudeTranscriptToTurns,
  parseCodexRolloutToTurns,
  sessionManager,
  transcriptTap,
  updateSessionTranscriptBinding,
});

// build-injection IPC 历史用于 blackboard 用户输入合成注入子会话(meeting-blackboard.js)。
// Module C 后 blackboard 已删除,该 handler 不再被任何前端代码调用,清理。

registerArchiveIpc(ipcMain);

registerSessionIpc(ipcMain, {
  registerSessionForTap,
  sendToRenderer,
  sessionManager,
});

// --- Dormant session persistence ---
// On boot we read state.json; those entries become dormant (sidebar entries
// with no live PTY). User clicks dormant session → resume-session IPC spawns
// PTY with `claude --resume <ccSessionId>`.
//
// 2026-05-07 道雪：boot 走 loadAndSelfHeal，扫 sessions/ + meetings/ 目录把孤儿
// 条目（state.json 已丢但 per-id JSON 仍在）合并回来。多 Hub 并发覆盖、
// state.json 损坏、外部清理工具误删这三类灾难都能自我修复。
const bootState = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
// loadAndSelfHeal 内部已经把 cleanShutdown 翻成 false（运行中状态），
//   bootWasCleanShutdown 是它额外暴露的"原始盘上值"，告知是否上次优雅退出。
const bootWasClean = !!bootState.bootWasCleanShutdown;
let lastPersistedSessions = Array.isArray(bootState.sessions) ? bootState.sessions : [];
// Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meeting 状态（持久化）
//   key = meetingId，value = boolean（true=沉浸，false=调试）。
//   每个 stateStore.save 调用都把这份 dict 一起写回，避免被覆盖。
let _immersiveByMeeting = (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
  ? bootState.immersiveByMeeting : {};
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
for (const m of bootMeetings) {
  meetingManager.restoreMeeting(m);
}

registerMeetingTimelineIpc(ipcMain, {
  meetingManager,
  sendToRenderer,
});

// 2026-05-07：loadAndSelfHeal 内部已经写过一次 cleanShutdown=false 的快照，
//   这里不再重复写。原本的"flip flag immediately on boot"语义由 selfHeal 承担。

// 跟踪上一次 persist 的 hubId/meetingId 集合，用于 diff 出"用户主动移除"的条目。
//   stateStore.markRemovedSession 把 id 推到 state-store 的 removed set，
//   merge 时显式删除——不依赖"内存里没有 = 删了"，避免多 Hub 启动期间互相把对方
//   未感知到的条目抹掉。
let _lastPersistedSessionIds = new Set(lastPersistedSessions.map(s => s.hubId).filter(Boolean));
let _lastPersistedMeetingIds = new Set(bootMeetings.map(m => m && m.id).filter(Boolean));

registerPersistenceIpc(ipcMain, {
  bootWasClean,
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedMeetingIds: () => _lastPersistedMeetingIds,
  getLastPersistedSessionIds: () => _lastPersistedSessionIds,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  meetingStore,
  sessionStore,
  setLastPersistedMeetingIds: (ids) => { _lastPersistedMeetingIds = ids; },
  setLastPersistedSessionIds: (ids) => { _lastPersistedSessionIds = ids; },
  setLastPersistedSessions: (sessions) => { lastPersistedSessions = sessions; },
  stateStore,
});

registerResumeSessionIpc(ipcMain, {
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  fs,
  getHookPort: () => hookPort,
  getHubDataDir,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isClaudeWebKind,
  isCodexBaseKind,
  meetingManager,
  os,
  path,
  readTranscriptTail,
  registerSessionForTap,
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
});

const imageDir = path.join(getHubDataDir(), 'images');
registerAppUtilityIpc(ipcMain, {
  clipboard,
  crypto,
  fs,
  getHookPort: () => hookPort,
  getMainWindow: () => mainWindow,
  imageDir,
  Notification,
  path,
});

registerPathIpc(ipcMain);

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires Stop / UserPromptSubmit hooks. Forwards to renderer as IPC events.
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  // 2026-05-16 道雪：防卡死 — 外部 HTTP 救援入口，tools/hub-escape.ps1 调
  const isEscapeHome = req.method === 'POST' && req.url === '/api/escape-home';
  const isResearchFetchStock = req.method === 'POST' && req.url === '/api/research/fetch-stock';
  const isResearchFetchField = req.method === 'POST' && req.url === '/api/research/fetch-field';
  const isResearchFetchConcept = req.method === 'POST' && req.url === '/api/research/fetch-concept';
  const isResearchFetchSector = req.method === 'POST' && req.url === '/api/research/fetch-sector';
  // Plan 2: 3 个新聚合 endpoint（走 research-mcp/query.py 而非 LinDangAgent.data_query.py）
  const isResearchStockStatic = req.method === 'POST' && req.url === '/api/research/stock-static';
  const isResearchStockMarket = req.method === 'POST' && req.url === '/api/research/stock-market';
  const isResearchStockNews = req.method === 'POST' && req.url === '/api/research/stock-news';
  const isResearchFetch = isResearchFetchStock || isResearchFetchField || isResearchFetchConcept || isResearchFetchSector
    || isResearchStockStatic || isResearchStockMarket || isResearchStockNews;
  // plan 2026-05-05 阶段 0: 群聊记忆 MCP 回调（loopback）。
  if (!isHook && !isStatus && !isResearchFetch && !isEscapeHome) {
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
    // 2026-05-16 道雪：外部 HTTP 救援 — tools/hub-escape.ps1 调这条路由触发 escapeToHome()
    if (isEscapeHome) {
      if (parsed.token !== HOOK_TOKEN) {
        console.warn('[escape-home] 403 wrong token from', req.socket && req.socket.remoteAddress);
        res.writeHead(403); res.end('{}'); return;
      }
      // 检查 renderer 真的可达 — mainWindow.isDestroyed() 不够，renderer 进程 crash 时
      // webContents.send 会静默 drop。这种场景下回 503 让 ps1 提示"需手动重启 Hub"。
      const rendererReachable = mainWindow && !mainWindow.isDestroyed()
        && mainWindow.webContents && !mainWindow.webContents.isCrashed();
      if (!rendererReachable) {
        console.warn('[escape-home] renderer unreachable (destroyed or crashed) — endpoint returns 503');
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, pid: process.pid, error: 'renderer unreachable' }));
        return;
      }
      console.log('[escape-home] HTTP triggered');
      // 2026-05-17 道雪：主 webContents 可能已被外部 URL navigate 走（renderer 跑的
      //   是远程网页，preload IPC 失效，sendToRenderer('escape-home') 收不到）。
      //   此时直接 loadFile 拉回 index.html — Hub 主进程没死，session 子进程没丢，
      //   只是 renderer 重新初始化从 state.json 恢复。
      const currentUrl = mainWindow.webContents.getURL();
      const navigatedAway = !currentUrl.startsWith('file:') || !currentUrl.includes('/renderer/index.html');
      if (navigatedAway) {
        console.warn('[escape-home] main webContents has been navigated to', currentUrl, '→ loadFile back to index.html');
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, pid: process.pid, recovered: 'loadFile', from: currentUrl }));
        return;
      }
      sendToRenderer('escape-home');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    // Research mode MCP callbacks (loopback)：fetch_lindang_stock / fetch_concept_stocks / fetch_sector_overview
    if (isResearchFetch) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      const { meetingId, kind, symbol, name, concept, top_n, sector, op } = parsed;
      const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
      if (!meeting || meeting.scene !== 'research') {
        res.writeHead(400); res.end('{"error":"not research mode"}'); return;
      }
      const t0 = Date.now();
      let result;
      try {
        if (isResearchFetchStock) {
          result = await lindangBridge.fetchStock(symbol, name);
        } else if (isResearchFetchField) {
          result = await lindangBridge.fetchField(op, symbol);
        } else if (isResearchFetchConcept) {
          result = await lindangBridge.fetchConcept(concept, top_n || 10);
        } else if (isResearchStockStatic) {
          result = await lindangBridge.fetchStatic(symbol);
        } else if (isResearchStockMarket) {
          result = await lindangBridge.fetchMarket(symbol);
        } else if (isResearchStockNews) {
          result = await lindangBridge.fetchNews(symbol);
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
        if (parsed.claudeSessionId || parsed.transcriptPath) {
          updateSessionTranscriptBinding(parsed.sessionId, {
            ccSessionId: parsed.claudeSessionId,
            transcriptPath: parsed.transcriptPath,
          });
        }
        if (event === 'stop' && parsed.transcriptPath) {
          transcriptTap.notifyClaudeStop(parsed.sessionId, parsed.transcriptPath).catch(() => {});
        }
        if (event === 'prompt' && latestUserMessage) {
          maybeAutoTitleSessionFromPrompt({
            hubSessionId: parsed.sessionId,
            text: latestUserMessage,
            submittedAt: Date.now(),
            signalSource: 'hook_prompt',
          });
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
        console.warn(`[群聊] hook server bind failed on :${port} (${e.code}): ${e.message}`);
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

function cacheAgentUsage(provider, tokenData, scope = null) {
  try {
    const existing = loadUsageCache();
    const scoped = provider === 'codex' && scope
      ? attachCodexUsageScope(tokenData, scope)
      : tokenData;
    existing[provider] = { ...scoped, ts: Date.now() };
    fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(existing));
  } catch {}
}

function cachePackyAccount(data) {
  try {
    const existing = loadUsageCache();
    existing.packy = { ...data, ts: Date.now() };
    fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(existing));
  } catch {}
}

function loadUsageCache() {
  try { return JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function currentCodexUsageScope() {
  return resolveCodexUsageScope(getHubConfig(), {
    hubDataDir: getHubDataDir(),
    homeDir: os.homedir(),
  });
}

function loadUsageCacheForCurrentConfig() {
  return filterUsageCacheForCodexScope(loadUsageCache(), currentCodexUsageScope());
}

// PackyAPI 账户(余额 + 消耗)异步拉取 + 缓存。
// 调用方:启动后台 timer + IPC 'refresh-packy-account'(用户设置改 cookie 时强制刷新)。
async function fetchAndCachePackyAccount() {
  const cfg = getHubConfig();
  const cookie = cfg.packySessionCookie || '';
  // sk- key 用于查"今日消耗"(独立路径,即使没 cookie 也有数据)。
  // codex 与 gpt 共享 codex 分组 key;kimi/qwen 共享 bailian key。去重交给 fetchAggregated。
  const tokenKeys = [cfg.codexApiKey, cfg.gptApiKey, cfg.kimiApiKey, cfg.qwenApiKey].filter(Boolean);
  if (!cookie && tokenKeys.length === 0) {
    cachePackyAccount({ enabled: false });
    return { enabled: false };
  }
  const proxy = cfg.proxy || '';
  const data = await packyBalance.fetchAggregated({ cookie, tokenKeys, proxy });
  // cache 与 IPC payload 必须都带 enabled: true。漏 enabled 会让 renderer 直接覆盖
  // packyAccountData 后 renderPackyRow 走 !data.enabled 分支显示"未接入"——
  // 启动时从 cache 加载有 enabled,5min 自动刷新触发 IPC 后立刻翻车。
  const payload = { ...data, enabled: true };
  cachePackyAccount(payload);
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('packy-account-updated', payload); } catch {}
  }
  return payload;
}

registerUsageIpc(ipcMain, {
  fetchAndCachePackyAccount,
  loadUsageCacheForCurrentConfig,
});

registerConfigIpc(ipcMain, {
  attachCodexUsageScope,
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  clearSessionManagerConfigCache,
  currentCodexUsageScope,
  fetchAndCachePackyAccount,
  scanAgentSessions,
  sendToRenderer,
});

// --- Gemini/Codex ring-buffer usage scanner ---
// Periodically scans agent sessions' ring buffers for token/model patterns
// and emits status-event so the renderer can show context/usage badges.
const _agentLastStatus = new Map();
const _agentQuota = { gemini: null, codex: null };

// --- Codex JSONL-based usage scanner ---
// Codex CLI writes authoritative rate_limits to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Each file contains token_count events with primary (5h) and secondary (7d) windows.
let _codexJsonlLastScan = 0;
let _codexJsonlCached = null;
const _codexJsonlCachedByRoot = new Map();
const CODEX_JSONL_THROTTLE_MS = 30_000;

function scanCodexJsonlUsage(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT) {
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

function scanCodexJsonlUsageThrottled(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT) {
  const now = Date.now();
  const key = path.resolve(sessionsDir || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase();
  const cached = _codexJsonlCachedByRoot.get(key);
  if (cached && now - cached.ts < CODEX_JSONL_THROTTLE_MS) return cached.data;
  const data = scanCodexJsonlUsage(sessionsDir);
  _codexJsonlCachedByRoot.set(key, { ts: now, data });
  _codexJsonlLastScan = now;
  _codexJsonlCached = data;
  return data;
}

// Token-based rolling-window tracker for Gemini/Codex (fallback).
const AGENT_LIMITS = {
  gemini: { tokens5h: 2_000_000, tokens7d: 50_000_000 },
  codex:  { tokens5h: 1_000_000, tokens7d: 10_000_000 },
};
const _agentTokenLog = { gemini: [], codex: [] }; // [{ts, tokens}]

function agentUsageScopeKey(sessionsRoot) {
  return path.resolve(sessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase();
}

function recordAgentTokens(kind, tokens, scopeKey = null) {
  if (!_agentTokenLog[kind]) return;
  _agentTokenLog[kind].push({ ts: Date.now(), tokens, scopeKey });
}

function calcAgentUsage(kind, scopeOrRoot = null) {
  const log = _agentTokenLog[kind];
  if (!log) return null;
  const now = Date.now();
  const H5 = 5 * 3600 * 1000;
  const D7 = 7 * 86400 * 1000;
  // Prune entries older than 7d
  while (log.length && log[0].ts < now - D7) log.shift();
  const scopeKey = scopeOrRoot ? agentUsageScopeKey(scopeOrRoot) : null;
  const scopedLog = scopeKey ? log.filter(e => e.scopeKey === scopeKey) : log;
  const tok5h = scopedLog.filter(e => e.ts >= now - H5).reduce((s, e) => s + e.tokens, 0);
  const tok7d = scopedLog.reduce((s, e) => s + e.tokens, 0);
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
    if (s.kind !== 'gemini' && !isCodexBaseKind(s.kind)) continue;
    if (s.status === 'dormant') continue;
    const buf = sessionManager.getSessionBuffer(s.id);
    if (!buf) continue;
    const plain = stripAnsi(buf);
    const parsed = s.kind === 'gemini' ? parseGeminiUsage(plain) : parseCodexUsage(plain);
    if (parsed.tokensUsed) {
      const prev = _agentLastStatus.get(s.id + ':tok');
      if (prev !== parsed.tokensUsed) {
        const delta = prev ? parsed.tokensUsed - prev : parsed.tokensUsed;
        const scopeKey = isCodexBaseKind(s.kind)
          ? agentUsageScopeKey(s.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT)
          : null;
        if (delta > 0) recordAgentTokens(isCodexBaseKind(s.kind) ? 'codex' : s.kind, delta, scopeKey);
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
  const codexScope = currentCodexUsageScope();
  const codexJsonl = scanCodexJsonlUsageThrottled(codexScope.sessionsRoot);
  if (codexJsonl) {
    agentData.codex = attachCodexUsageScope({ ...codexJsonl, source: 'jsonl' }, codexScope);
    cacheAgentUsage('codex', codexJsonl, codexScope);
  } else if (_agentQuota.codex) {
    agentData.codex = attachCodexUsageScope({ ..._agentQuota.codex, source: 'cli' }, codexScope);
    cacheAgentUsage('codex', _agentQuota.codex, codexScope);
  } else {
    const usage = calcAgentUsage('codex', codexScope.sessionsRoot);
    if (usage) {
      agentData.codex = attachCodexUsageScope({ ...usage, source: 'estimate' }, codexScope);
      cacheAgentUsage('codex', usage, codexScope);
    } else {
      agentData.codex = attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, codexScope);
    }
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
  traceStartup('app.whenReady');
  const _home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  traceStartup('deploy hooks start');
  // 2026-05-05 道雪：所有 Claude family 隔离配置目录都必须部署 Stop hook，否则
  //   该家族 sub session 完成时 CC 不调 hook → notifyClaudeStop 永不触发 →
  //   ClaudeTap.JsonlTail 永不启动 → stop_reason 主路径 + idle 兜底全失效 →
  //   群聊卡片自动同步死，只能等 5min 硬 timeout 或用户手动点提取。
  //   原版漏了 packy 3 家（gpt/kimi/qwen），settings.json 完全没 hook 注册，
  //   scripts/session-hub-hook.py 也不存在。与 findTranscriptByCCSessionId 的
  //   candidateRoots 列表对齐，单一真理源应在 ai-kinds.js（后续可重构）。
  for (const dir of ['.claude', '.claude-deepseek', '.claude-glm',
                     '.claude-packy-gpt', '.claude-packy-kimi', '.claude-packy-qwen']) {
    ensureHooksDeployed(path.join(_home, dir));
  }
  traceStartup('deploy hooks done');
  traceStartup('codex config start');
  ensureCodexContextConfig();
  traceStartup('codex config done');
  traceStartup('gemini mcp install start');
  ensureGeminiMcpInstalled();
  traceStartup('gemini mcp install done');
  traceStartup('createWindow start');
  createWindow();
  traceStartup('createWindow done');
  traceStartup('hook listen start');
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[群聊] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
  } else {
    console.warn('[群聊] hook server failed to bind — falling back to silence detection');
  }
  traceStartup(`hook listen done (${hookPort || 'none'})`);
  sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });

  // 2026-05-16 道雪：写 per-PID 控制文件（含 hookPort + cdpPort + HOOK_TOKEN）。
  //   救援脚本 tools/hub-escape.ps1 通过 <dataDir>/control/<pid>.json 发现 Hub
  //   端口和 token。CDP 端口从 <userData>/DevToolsActivePort 读取（Chromium 写入）。
  try {
    const dataDir = getHubDataDir();
    let cdpPort = null;
    if (process.env.CLAUDE_HUB_NO_CDP !== '1') {
      // Chromium 只在 --remote-debugging-port=0（OS 自动分配）时才写 DevToolsActivePort 文件；
      // 当 CLI 已传明确端口（E2E hub-launcher 场景）时直接从 argv 解析。
      if (_hasCdpSwitch) {
        const m = process.argv.find(a => a.startsWith('--remote-debugging-port='));
        if (m) {
          const p = parseInt(m.split('=')[1], 10);
          if (!isNaN(p) && p > 0) cdpPort = p;
        }
      } else {
        cdpPort = await hubControl.readDevToolsActivePort(app.getPath('userData'));
        if (!cdpPort) console.warn('[hub-control] DevToolsActivePort not ready within 3s — CDP backdoor may be unreachable');
      }
    }
    const removed = hubControl.cleanStale(dataDir);
    if (removed.length) console.log(`[hub-control] cleaned stale entries for pids: ${removed.join(', ')}`);
    hubControl.writeControlFile({
      pid: process.pid,
      hookPort,
      cdpPort,
      token: HOOK_TOKEN,
      dataDir,
      startedAt: Date.now(),
    });
    console.log(`[hub-control] control file written: pid=${process.pid} hookPort=${hookPort} cdpPort=${cdpPort}`);
  } catch (e) {
    console.warn('[hub-control] init failed:', e.message);
  }

  traceStartup('startAgentScanner');
  startAgentScanner();
  // PackyAPI 账户(余额 + 消耗)— 启动 1.5s 后首次拉取,之后每 5 分钟刷新一次。
  // 延后启动避免拖慢首屏;失败静默不影响其他功能。
  setTimeout(() => { fetchAndCachePackyAccount().catch(() => {}); }, 1500);
  setInterval(() => { fetchAndCachePackyAccount().catch(() => {}); }, 5 * 60 * 1000);
});

app.on('before-quit', async () => {
  // 2026-05-07 道雪：退出时保证三层都同步落盘——state.json（lock + merge）、
  //   per-meeting JSON、per-session JSON。任意一层丢了，下次 boot 的 selfHeal
  //   都能从另一层恢复。
  stateStore.save({ version: 1, cleanShutdown: true, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings(), immersiveByMeeting: _immersiveByMeeting }, { sync: true });
  try {
    await meetingStore.flushAll();
    console.log('[群聊] meeting-store flushed on quit');
  } catch (err) {
    console.warn('[群聊] meeting-store flush failed:', err.message);
  }
  try {
    sessionStore.flushAll();
    console.log('[hub] session-store flushed on quit');
  } catch (err) {
    console.warn('[hub] session-store flush failed:', err.message);
  }

  // 2026-05-16 道雪：清理自己的控制文件。unlinkSelf 内部已 try/catch + warn 非 ENOENT 错误，
  // 不外抛，所以这里裸调即可，不再加外层 catch（避免盖住内部 warn）。
  hubControl.unlinkSelf(getHubDataDir(), process.pid);
});

app.on('window-all-closed', () => {
  hookServer.close();
  sessionManager.dispose();
  app.quit();
});
