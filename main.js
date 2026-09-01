const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, shell, Menu, Tray } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
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
const { WorkspaceService, normalizeKey: normalizeWorkspaceKey } = require('./core/workspace-service.js');
const stateStore = require('./core/state-store.js');
const { getHubDataDir, isIsolatedHub, getMeetingWorkspaceDir } = require('./core/data-dir.js');
const {
  appendManagedLaunchAudit,
  inspectManagedLaunchAudit,
  managedLaunchAuditPath,
} = require('./core/managed-launch-audit.js');
const { spawn } = require('child_process');
const {
  HUB_APP_USER_MODEL_ID,
  ensureWindowsShellIntegration,
  startWindowsShellIntegrationWatchdog,
} = require('./core/windows-shell-integration.js');
const {
  describeBrandingHealth,
  resolveHubLaunchExePath,
} = require('./core/hub-exe-branding.js');
const { isPackagedHubRuntime } = require('./core/electron-runtime-mode.js');
const { acquireLockAsync, releaseLockAsync } = require('./core/file-lock.js');
const {
  ensureClaudeHookIntegration,
  startClaudeHookIntegrationWatchdog,
} = require('./core/claude-hook-integration.js');
const hubControl = require('./core/hub-control.js');
const { MeetingRoomManager } = require('./core/meeting-room.js');
const meetingStore = require('./core/meeting-store.js');
const sessionStore = require('./core/session-store.js');
const { TranscriptTap } = require('./core/transcript-tap');
const { CompletionNotifier } = require('./core/completion-notifier.js');
const { normalizeEventTime } = require('./core/session-attention-state.js');
const { createUsageFilter } = require('./core/usage-filter.js');
const scenes = require('./core/group-chat-scenes.js');
const groupchat = require('./core/group-chat-orchestrator.js');
const cliReadyDetector = require('./core/group-chat-cli-ready-detector.js');
const lindangBridge = require('./core/lindang-bridge.js');
const { getConfig: getHubConfig } = require('./core/hub-config.js');
const {
  createFixtureProbe: createNetworkEgressFixtureProbe,
  createNetworkEgressMonitor,
} = require('./core/network-egress-monitor.js');
const {
  resolveCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
} = require('./core/codex-usage-scope.js');
const { ALL_AI_KINDS, isClaudeFamily, isCodexCliKind, isKimiCliKind, SLOT_IDS, KIND_LABELS, getSlotPromptName, getSlotDisplayLabel, slotIdToIndex, slotIndexToId } = require('./core/ai-kinds.js');
const { registerConfigIpc } = require('./main/ipc/config-handlers.js');
const { registerWorkbenchOperationsIpc } = require('./main/ipc/workbench-operations-handlers.js');
const { createWorkbenchOperationsService } = require('./core/workbench-operations.js');
const { registerPathIpc } = require('./main/ipc/path-handlers.js');
const { registerChatgptBridgeIpc } = require('./main/ipc/chatgpt-bridge-handlers.js');
const { registerSessionIpc } = require('./main/ipc/session-handlers.js');
const { registerWorkspaceIpc } = require('./main/ipc/workspace-handlers.js');
const { getTerminalBatchDelay, isBackgroundMember } = require('./main/terminal-output-policy.js');
const { TerminalOutputBatcher } = require('./main/terminal-output-batcher.js');
const { registerUsageIpc } = require('./main/ipc/usage-handlers.js');
const { registerMeetingIpc } = require('./main/ipc/meeting-handlers.js');
const { registerMeetingCreateIpc } = require('./main/ipc/meeting-create-handlers.js');
const { registerMeetingTimelineIpc } = require('./main/ipc/meeting-timeline-handlers.js');
const { registerTranscriptIpc } = require('./main/ipc/transcript-handlers.js');
const { registerCliStatusIpc } = require('./main/ipc/cli-status-handlers.js');
const { registerPromptInspectIpc } = require('./main/ipc/prompt-inspect-handlers.js');
const { registerPersistenceIpc } = require('./main/ipc/persistence-handlers.js');
const { registerAppUtilityIpc } = require('./main/ipc/app-utility-handlers.js');
const { registerProcessReclaimIpc } = require('./main/ipc/process-reclaim-handlers.js');
const { registerAutoSuspendIpc } = require('./main/ipc/auto-suspend-handlers.js');
const { registerGroupchatQueryIpc } = require('./main/ipc/groupchat-query-handlers.js');
const { registerGroupchatRecoveryIpc } = require('./main/ipc/groupchat-recovery-handlers.js');
const { registerGroupchatTurnIpc } = require('./main/ipc/groupchat-turn-handlers.js');
const { registerCommitteeIpc } = require('./main/ipc/committee-handlers.js');
const { createResumeSessionHandler, registerResumeSessionIpc } = require('./main/ipc/resume-session-handlers.js');
const { createGroupChatDispatcher } = require('./main/groupchat/dispatcher.js');
const { createCommitteeConductor } = require('./main/groupchat/committee-conductor.js');
const {
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
} = require('./main/session-auto-suspend.js');
const committeeHistory = require('./core/committee-history.js');
const { createAutoTitleManager } = require('./main/auto-title-manager.js');
const {
  parseCodexUsage,
  parseGeminiUsage,
  parseKimiUsage,
  stripAnsi,
} = require('./main/usage/agent-usage-parser.js');
const {
  expireCodexUsageWindows,
  readCodexAccountUsage,
  shouldPreferCodexLiveUsage,
} = require('./main/usage/codex-app-server-usage.js');
const { readKimiAccountUsage } = require('./main/usage/kimi-account-usage.js');
const { readDeepSeekAccountBalance } = require('./main/usage/deepseek-account-balance.js');
const {
  didClaudeSnapshotAdvance,
  selectClaudeStatuslineUsage,
} = require('./main/usage/claude-statusline-usage.js');
const {
  pruneCodexCliUsage,
  recordCodexCliUsage,
  selectCodexCliUsageForScope,
} = require('./main/usage/scoped-codex-cli-usage.js');
const {
  mergeCodexEntry,
  mergeUsageCacheSnapshots,
  readUsageCacheFile,
  writeMergedUsageCacheFile,
  writeMergedUsageCacheFileSync,
} = require('./main/usage/usage-cache-merge.js');

function isCodexBaseKind(kind) {
  return isCodexCliKind(kind);
}
const { readLastAssistantMessage } = require('./core/read-last-assistant.js');
const { readTranscriptTail } = require('./core/session-manager');
const { parseClaudeTranscriptToTurns } = require('./core/claude-transcript-parser.js');
const { TranscriptParserService } = require('./core/transcript-parser-service.js');
const { CodexJsonlUsageService } = require('./main/usage/codex-jsonl-usage-service.js');
const {
  claudeProjectRoots,
  findTranscriptByCCSessionId,
  healPersistedCwds,
} = require('./core/claude-transcript-locator.js');
const {
  DEFAULT_CODEX_SESSIONS_ROOT,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
  isUsableCodexRolloutPath,
  isCodexSubagentRolloutPath,
  readCodexRolloutMeta,
} = require('./core/codex-transcript-parser.js');
const { registerArchiveIpc } = require('./main/ipc/archive-handlers.js');
const { SessionSearchService } = require('./core/session-search-service.js');
const transcriptParserService = new TranscriptParserService();
const codexJsonlUsageService = new CodexJsonlUsageService();
function sessionSearchRoots(envName, defaults) {
  if (process.env.HUB_SESSION_SEARCH_DISABLE_NATIVE === '1') return [];
  const configured = String(process.env[envName] || '').trim();
  return configured
    ? configured.split(path.delimiter).map(value => value.trim()).filter(Boolean)
    : defaults;
}
const sessionSearchService = new SessionSearchService({
  cachePath: path.join(getHubDataDir(), 'cache', 'session-search-v2.json'),
  claudeRoots: sessionSearchRoots('HUB_SESSION_SEARCH_CLAUDE_ROOTS', claudeProjectRoots()),
  codexRoots: sessionSearchRoots('HUB_SESSION_SEARCH_CODEX_ROOTS', [DEFAULT_CODEX_SESSIONS_ROOT]),
  // 2026-08-28：补上 Kimi 与 Gemini。此前只有 claude/codex/meeting 三个适配器，
  // Kimi 的 45 个会话、Gemini 的 21 个会话正文一条都进不了索引。
  kimiRoots: sessionSearchRoots('HUB_SESSION_SEARCH_KIMI_ROOTS', [path.join(os.homedir(), '.kimi-code', 'sessions')]),
  geminiRoots: sessionSearchRoots('HUB_SESSION_SEARCH_GEMINI_ROOTS', [path.join(os.homedir(), '.gemini', 'tmp')]),
  meetingDir: path.join(getHubDataDir(), 'meetings'),
  refreshTtlMs: Number(process.env.HUB_SESSION_SEARCH_REFRESH_TTL_MS) || 10_000,
  // Production warms the persistent index after the latency-sensitive boot
  // path. Isolated Hubs stay opt-in so an unrelated E2E can never scan the
  // user's real native transcript roots merely because it launched the app.
  prewarmEnabled: process.env.HUB_SESSION_SEARCH_PREWARM === '1'
    || (process.env.HUB_SESSION_SEARCH_PREWARM !== '0' && !isIsolatedHub()),
});
const transcriptTap = new TranscriptTap({ parserService: transcriptParserService });
// AIGroupChatHub.exe is a branded copy of Electron's default-app host. Electron
// 41 reports app.isPackaged=true solely because the exe was renamed, while
// process.defaultApp remains true and argv still contains this source tree.
// Using app.isPackaged directly strips the app-root from Jump List launches and
// also points hook deployment at the wrong resources directory.
const HUB_IS_PACKAGED = isPackagedHubRuntime({
  appIsPackaged: app.isPackaged,
  defaultApp: process.defaultApp,
});
// Recovery can temporarily attach several listeners per group-chat seat.
try { transcriptTap.setMaxListeners(100); } catch {}

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
const HIDDEN_E2E_WINDOW_REQUESTED = process.env.CLAUDE_HUB_E2E === '1'
  && process.env.CLAUDE_HUB_E2E_WINDOW_MODE === 'hidden';
const HIDDEN_E2E_DATA_DIR_SAFE = isIsolatedHub()
  && path.resolve(getHubDataDir()).toLowerCase()
    !== path.resolve(path.join(os.homedir(), '.claude-session-hub')).toLowerCase();
if (HIDDEN_E2E_WINDOW_REQUESTED && !HIDDEN_E2E_DATA_DIR_SAFE) {
  throw new Error('hidden E2E window mode requires a non-production CLAUDE_HUB_DATA_DIR');
}

// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — keeps Hub-owned entries current and preserves unrelated hooks.
// claudeDirPath: target Claude config dir (e.g. ~/.claude or ~/.claude-deepseek)
function ensureHooksDeployed(claudeDirPath) {
  const claudeDir = claudeDirPath;
  const srcDir = HUB_IS_PACKAGED
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');
  const hookResult = ensureClaudeHookIntegration({
    claudeDir,
    sourceScriptsDir: srcDir,
    logger: console,
  });
  if (hookResult.errors.length) {
    console.warn(`[claude-hooks] ${claudeDir}: ${hookResult.errors.join('；')}`);
  }

  // Ensure .claude.json project trust — Claude Code 将"信任文件夹"状态
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
  // Isolated GUI/E2E instances must never rewrite the user's real ~/.gemini.
  // Their fake Gemini process does not need the persistent arena registration.
  if (isIsolatedHub()) return;
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
let claudeHookWatchdog = null;
let windowsShellWatchdog = null;

let mainWindow;
let agentLeagueTray = null;
let explicitHubQuitRequested = false;
const sessionManager = new SessionManager();
sessionManager.on('managed-launch', (record) => {
  appendManagedLaunchAudit(record, { logger: console });
});
const meetingManager = new MeetingRoomManager();
const workspaceService = new WorkspaceService();
let networkEgressProbe;
if (process.env.CLAUDE_HUB_E2E === '1' && process.env.CLAUDE_HUB_EGRESS_FIXTURE) {
  try {
    networkEgressProbe = createNetworkEgressFixtureProbe(
      JSON.parse(process.env.CLAUDE_HUB_EGRESS_FIXTURE),
    );
  } catch (error) {
    console.warn('[network-egress] invalid E2E fixture:', error && error.message);
  }
}
const networkEgressMonitor = createNetworkEgressMonitor({
  getProxy: () => getHubConfig().proxy,
  statePath: path.join(getHubDataDir(), 'network-egress-state.json'),
  ...(networkEgressProbe ? { probe: networkEgressProbe } : {}),
  logger: console,
});
const completionNotifier = new CompletionNotifier({
  getConfig: getHubConfig,
  getLogPath: () => path.join(getHubDataDir(), 'notification-delivery.jsonl'),
  logger: console,
});
// SessionManager 构造不接收依赖；kimi 会话 spawn 前的 AGENTS.md seed 需要它
// （core/session-manager.js 里 this.workspaceService.seedUngovernedAgentsFile）。
sessionManager.workspaceService = workspaceService;
const workspaceMigrationSessionIds = new Set();

// Deep-summary service singleton: instantiated from config-driven fallback chain.
// Providers tried in order; first one with a parseable response wins.

// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', (ev) => {
  const { hubSessionId, text, completedAt } = ev || {};
  const completionAt = normalizeEventTime(completedAt, Date.now());
  let session = sessionManager.getSession(hubSessionId);
  // Persist reply recency in main as well as renderer. This closes the gap where
  // a renderer reload/suspend between transcript completion and its IPC handler
  // left a dormant card anchored to the prompt time.
  if (session && completionAt >= (Number(session.lastCompletedAt) || 0)) {
    const updated = sessionManager.updateSessionMeta(hubSessionId, { lastCompletedAt: completionAt });
    if (updated) {
      session = updated;
      sessionStore.markDirty(hubSessionId, updated);
    }
  }
  Promise.resolve(completionNotifier.handleTurnComplete(ev || {}, session)).catch((error) => {
    console.warn('[completion-notifier] session completion handling failed:', error && error.message);
  });
  if (session && session.meetingId) {
    const turn = meetingManager.appendTurn(
      session.meetingId,
      hubSessionId,
      text,
      completionAt,
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
      completedAt: completionAt,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      durationMs: ev ? ev.durationMs : null,
      signalSource: ev ? ev.signalSource : null,
      turnId: ev ? ev.turnId || null : null,
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
  workspaceService,
});
const { maybeAutoTitleMeetingFromPrompt, maybeAutoTitleSessionFromPrompt } = autoTitleManager;
// Codex /goal auto-continuations can begin without a user_message event. Keep
// this lifecycle signal separate from prompt-submitted so it cannot trigger
// auto-title or notification prompt bookkeeping with synthetic text.
transcriptTap.on('turn-started', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  completionNotifier.noteTurnStarted(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-started-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      startedAt: ev.startedAt != null ? ev.startedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'task_started',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-started-event broadcast failed:', error && error.message);
  }
});

transcriptTap.on('turn-aborted', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  completionNotifier.noteTurnAborted(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-aborted-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      abortedAt: ev.abortedAt != null ? ev.abortedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'turn_aborted',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-aborted-event broadcast failed:', error && error.message);
  }
});

// Codex writes transport failures as task_complete.error. Forward the
// authoritative occurrence instead of relying only on PTY text, because the
// full-screen TUI can redraw an old error line during every later turn.
transcriptTap.on('turn-error', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  completionNotifier.noteTurnFailed(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-failed-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      failedAt: ev.completedAt != null ? ev.completedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'task_complete_error',
      turnId: ev.turnId || null,
      message: ev.message || 'Codex turn failed',
      errorInfo: ev.errorInfo || null,
      occurrenceId: ev.occurrenceId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-failed-event broadcast failed:', error && error.message);
  }
});

transcriptTap.on('prompt-submitted', (ev) => {
  const { hubSessionId, text, submittedAt } = ev || {};
  completionNotifier.notePromptSubmitted(ev || {});
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
      turnId: ev ? ev.turnId || null : null,
    });
  } catch (e) {
    console.warn('[codex prompt] prompt-submitted-event broadcast failed:', e && e.message);
  }
});

// Kimi's main wire stays quiet while an Agent/Coder sub-agent does the actual
// work. PTY byte bursts cannot be used as a status signal for Kimi because its
// interactive TUI redraws on ordinary typing. Forward the authoritative
// Agent tool.call/tool.result lifecycle instead, so the sidebar stays running
// for the whole background job rather than turning idle after the main step.
transcriptTap.on('background-work-changed', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('background-work-event', {
      ...ev,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : (ev.kind || null),
    });
  } catch (error) {
    console.warn('[kimi background] background-work-event broadcast failed:', error && error.message);
  }
});

// `contextMax` is the user's launch request. Codex can clamp it to the current
// model catalog and then applies its effective-window percentage. The actual
// runtime value arrives in token_count.model_context_window; persist it under a
// separate key so a later resume never turns the clamp into the next request.
transcriptTap.on('context-window-observed', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  const contextEffectiveMax = Number(ev.contextEffectiveMax);
  if (!Number.isInteger(contextEffectiveMax) || contextEffectiveMax <= 0) return;
  const observedAtValue = Number(ev.observedAt);
  const contextEffectiveObservedAt = Number.isFinite(observedAtValue) && observedAtValue > 0
    ? observedAtValue
    : Date.now();
  try {
    const current = sessionManager.getSession(ev.hubSessionId);
    if (!current) return;
    if (current.contextEffectiveMax === contextEffectiveMax
        && Number(current.contextEffectiveObservedAt) >= contextEffectiveObservedAt) return;
    const updated = sessionManager.updateSessionMeta(ev.hubSessionId, {
      contextEffectiveMax,
      contextEffectiveObservedAt,
    });
    if (!updated) return;
    void sessionStore.markDirtyImmediate(ev.hubSessionId, updated).catch((error) => {
      console.warn('[codex-context] per-session persist failed:', error && error.message);
    });
    const persisted = lastPersistedSessions.find(item => item && item.hubId === ev.hubSessionId);
    if (persisted) {
      persisted.contextEffectiveMax = contextEffectiveMax;
      persisted.contextEffectiveObservedAt = contextEffectiveObservedAt;
      persisted.updatedAt = Date.now();
    }
    sendToRenderer('session-updated', { session: updated });
  } catch (error) {
    console.warn('[codex-context] observation handling failed:', error && error.message);
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
    } else if ((ev.kind === 'gemini' || ev.kind === 'gemini-resume')
        && (ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot)) {
      const patch = {};
      if (ev.geminiChatId) patch.geminiChatId = ev.geminiChatId;
      if (ev.geminiProjectHash) patch.geminiProjectHash = ev.geminiProjectHash;
      if (ev.geminiProjectRoot) patch.geminiProjectRoot = ev.geminiProjectRoot;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    } else if (isKimiCliKind(ev.kind) && (ev.kimiSid || ev.wirePath || ev.sessionDir)) {
      const patch = {};
      if (ev.kimiSid) patch.kimiSid = ev.kimiSid;
      if (ev.sessionDir) patch.kimiSessionDir = ev.sessionDir;
      if (ev.wirePath) patch.transcriptPath = ev.wirePath;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
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
    } else if ((ev.kind === 'gemini' || ev.kind === 'gemini-resume')
        && (ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        geminiChatId: ev.geminiChatId,
        geminiProjectHash: ev.geminiProjectHash,
        geminiProjectRoot: ev.geminiProjectRoot,
      });
    } else if (isKimiCliKind(ev.kind) && (ev.kimiSid || ev.wirePath || ev.sessionDir)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        kimiSid: ev.kimiSid,
        kimiSessionDir: ev.sessionDir,
        transcriptPath: ev.wirePath,
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
  if (ev.kind === 'gemini') {
    if (ev.geminiChatId && cur.geminiChatId !== ev.geminiChatId) { cur.geminiChatId = ev.geminiChatId; changed = true; }
    if (ev.geminiProjectHash && cur.geminiProjectHash !== ev.geminiProjectHash) { cur.geminiProjectHash = ev.geminiProjectHash; changed = true; }
    if (ev.geminiProjectRoot && cur.geminiProjectRoot !== ev.geminiProjectRoot) { cur.geminiProjectRoot = ev.geminiProjectRoot; changed = true; }
  }
  if (isKimiCliKind(ev.kind)) {
    if (ev.kimiSid && cur.kimiSid !== ev.kimiSid) { cur.kimiSid = ev.kimiSid; changed = true; }
    if (ev.sessionDir && cur.kimiSessionDir !== ev.sessionDir) { cur.kimiSessionDir = ev.sessionDir; changed = true; }
    if (ev.wirePath && cur.transcriptPath !== ev.wirePath) { cur.transcriptPath = ev.wirePath; changed = true; }
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
    try { void sessionStore.markDirtyImmediate(ev.hubSessionId, cur); }
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
      geminiChatId: cur.geminiChatId,
      geminiProjectHash: cur.geminiProjectHash,
      geminiProjectRoot: cur.geminiProjectRoot,
      kimiSid: cur.kimiSid,
      kimiSessionDir: cur.kimiSessionDir,
    });
    console.log(`[群聊] persisted resume meta for ${ev.kind} session ${ev.hubSessionId.slice(0,8)}`);
  }
});

sessionManager.hookToken = HOOK_TOKEN;  // port set after listen

// Pin a stable AppUserModelID before creating the window so Windows keeps Hub's
// taskbar identity independent from electron.exe. Native toast notifications are
// intentionally disabled; this identity is still required by shell shortcuts and
// Explorer taskbar reconstruction. win32-only.
if (process.platform === 'win32' && !isIsolatedHub()) {
  app.setAppUserModelId(HUB_APP_USER_MODEL_ID); // = package.json build.appId
}

// Windows drops the window HICON whenever the taskbar identity is rebuilt, and
// the button then falls back to electron.exe's own icon — the Electron atom.
//
// 2026-08-08：b4fd5d5 已经预见到这点，但只挂了 'show'/'restore'，而这两个事件
// 对一个**始终可见**的窗口永远不会触发。实测链条：系统 08-06 14:11 启动 →
// Hub 14:17 起来图标正常 → explorer.exe 08-07 19:56:47 崩溃重启（Application
// Error 1000/1001 三条）→ 任务栏重建、HICON 丢失 → 08-08 17:40 截图已是原子图标，
// 期间窗口一直开着，没有任何事件把图标补回去。
// 所以除事件外，还要在 shell watchdog 的每一拍无条件重贴一次。setIcon 幂等，
// NativeImage 缓存后单次开销就是一个 WM_SETICON，15 秒一次可以忽略。
let _cachedHubWindowIcon = null;
function getHubWindowIcon() {
  if (_cachedHubWindowIcon && !_cachedHubWindowIcon.isEmpty()) return _cachedHubWindowIcon;
  _cachedHubWindowIcon = nativeImage.createFromPath(path.join(__dirname, 'claude-wx.ico'));
  return _cachedHubWindowIcon;
}
function reassertHubWindowIcon() {
  if (process.platform !== 'win32') return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const icon = getHubWindowIcon();
  if (!icon || icon.isEmpty()) return false;
  mainWindow.setIcon(icon);
  return true;
}

function keepIsolatedE2EWindowHidden() {
  return HIDDEN_E2E_WINDOW_REQUESTED && HIDDEN_E2E_DATA_DIR_SAFE;
}

function focusPrimaryWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // A hidden isolated E2E still exercises the real BrowserWindow/webContents,
  // but must never flash a Hub look-alike onto the user's production desktop.
  // Requiring both flags keeps normal and production launches unchanged.
  if (keepIsolatedE2EWindowHidden()) return true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  reassertHubWindowIcon();
  return true;
}

module.exports.focusPrimaryWindow = focusPrimaryWindow;

function shouldKeepAgentLeagueInBackground() {
  if (explicitHubQuitRequested || process.env.CLAUDE_HUB_DISABLE_LEAGUE_BACKGROUND === '1') return false;
  if (!agentLeagueBridge || !agentLeagueBridge.store) return false;
  try {
    const schedule = agentLeagueBridge.store.getSchedule();
    const activeRun = typeof agentLeagueBridge.getRunState === 'function' ? agentLeagueBridge.getRunState() : null;
    return schedule.keepAliveOnClose !== false && (schedule.enabled === true || !!activeRun);
  } catch (error) {
    console.warn('[agent-league] failed to evaluate background keepalive:', error && error.message);
    return false;
  }
}

function destroyAgentLeagueTray() {
  if (!agentLeagueTray) return false;
  try { agentLeagueTray.destroy(); } catch {}
  agentLeagueTray = null;
  return true;
}

function showHubFromAgentLeagueTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.restore?.();
  mainWindow.focus();
  destroyAgentLeagueTray();
}

function ensureAgentLeagueTray() {
  if (agentLeagueTray || !app.isReady()) return agentLeagueTray;
  const iconPath = path.join(__dirname, 'claude-wx.ico');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 20, height: 20 });
  agentLeagueTray = new Tray(icon);
  agentLeagueTray.setToolTip(`AI 群聊 Hub · Agent 联赛后台守护 · PID ${process.pid}`);
  const updateMenu = () => {
    let scheduleLabel = 'Agent 联赛后台守护中';
    try {
      const state = agentLeagueBridge && agentLeagueBridge.store && agentLeagueBridge.store.getSchedule();
      const run = agentLeagueBridge && agentLeagueBridge.getRunState && agentLeagueBridge.getRunState();
      scheduleLabel = run
        ? `Agent 联赛：${run.mode === 'weekly' ? '周度沉淀' : '盘前决策'}运行中`
        : `Agent 联赛：等待 ${state && (state.decisionTime || state.runTime) || '08:30'}`;
    } catch {}
    agentLeagueTray.setContextMenu(Menu.buildFromTemplate([
      { label: `打开 AI 群聊 Hub（PID ${process.pid}）`, click: showHubFromAgentLeagueTray },
      { label: scheduleLabel, enabled: false },
      { type: 'separator' },
      {
        label: '退出此 Hub（未完成任务可由其他 Hub 接班）',
        click: () => {
          explicitHubQuitRequested = true;
          void beginGracefulHubShutdown('tray-explicit-quit');
        },
      },
    ]));
  };
  updateMenu();
  agentLeagueTray.on('click', showHubFromAgentLeagueTray);
  agentLeagueTray.on('right-click', updateMenu);
  return agentLeagueTray;
}

function createWindow() {
  // Load the icon as a NativeImage so we can pass it to BrowserWindow AND
  // re-apply via setIcon — on Windows the constructor `icon` alone sometimes
  // misses the taskbar; the explicit setIcon nails it.
  const iconPath = path.join(__dirname, 'claude-wx.ico');
  const winIcon = getHubWindowIcon();

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
    // Windows can drop the source-mode HICON after the taskbar identity is
    // rebuilt (shortcut repair, Explorer refresh, multi-window regrouping).
    // These two cover the "window was hidden and came back" case; the
    // always-visible case is handled by the watchdog tick (see
    // reassertHubWindowIcon above).
    mainWindow.on('show', reassertHubWindowIcon);
    mainWindow.on('restore', reassertHubWindowIcon);
    mainWindow.on('focus', reassertHubWindowIcon);
  } else {
    console.warn('[icon] failed to load', iconPath);
  }

  let hasShown = false;
  const showMainWindow = () => {
    if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;
    hasShown = true;
    if (keepIsolatedE2EWindowHidden()) {
      traceStartup('main window kept hidden for isolated E2E');
      return;
    }
    mainWindow.maximize();
    mainWindow.show();
  };
  ipcMain.once('renderer-sidebar-ready', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    traceStartup('did-finish-load');
    sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });
    // Phase 2b：boot 后由 main 循环引擎扫描未完成循环并自动续跑（main 驱动 + 自动 wake 成员）。once 守卫 + 延迟(等 session 恢复) + try，绝不影响启动。
    if (!global.__loopResumeScanned) {
      global.__loopResumeScanned = true;
      setTimeout(() => {
        try { if (global.__loopEngine) global.__loopEngine.resumePending(); }
        catch (e) { console.warn('[loop] boot resume failed:', e && e.message); }
      }, 8000);
    }
  });
  setTimeout(showMainWindow, 4000);

  // 主 webContents 导航防护（2026-05-17 道雪，2026-07-31 收紧）：renderer 若误把链接
  //   交给浏览器默认导航，会让主 webContents 整个跳走、Hub shell 和操作按钮一起消失。
  //   旧逻辑放行了所有 file://，所以本地 HTML 正好能绕过保护。主窗口现在只允许加载
  //   自己的 renderer/index.html；其他本地文件重新投递给 Hub preview webview。
  //   webview 内部导航走 guest webContents，不受这里影响。
  const hubShellPath = path.resolve(path.join(__dirname, 'renderer', 'index.html'));
  const isHubShellUrl = (urlStr) => {
    try {
      const u = new URL(urlStr);
      return u.protocol === 'file:'
        && path.resolve(fileURLToPath(u)).toLowerCase() === hubShellPath.toLowerCase();
    } catch { return false; }
  };
  const routeBlockedMainNavigation = (urlStr) => {
    try {
      const u = new URL(urlStr);
      if (u.protocol === 'file:') {
        const targetPath = fileURLToPath(u);
        console.warn('[nav-guard] block local file from main webContents -> preview', targetPath);
        sendToRenderer('preview-local-file', targetPath);
        return;
      }
      if (u.protocol === 'about:' || u.protocol === 'chrome:' || u.protocol === 'devtools:') {
        console.warn('[nav-guard] block internal protocol from main webContents:', urlStr);
        return;
      }
    } catch {}
    console.log('[nav-guard] block main webContents navigate to', urlStr, '→ openExternal');
    shell.openExternal(urlStr).catch((e) => console.warn('[nav-guard] openExternal failed:', e && e.message));
  };
  const interceptNavigate = (event, urlStr) => {
    if (isHubShellUrl(urlStr)) return;
    event.preventDefault();
    routeBlockedMainNavigation(urlStr);
  };
  mainWindow.webContents.on('will-navigate', interceptNavigate);
  mainWindow.webContents.on('will-redirect', interceptNavigate);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeBlockedMainNavigation(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (shutdownDrainState === 'drained' || shutdownDrainState === 'finalizing') return;
    if (shouldKeepAgentLeagueInBackground()) {
      event.preventDefault();
      try {
        // Create the recovery affordance first. If Windows refuses the tray
        // icon, keep the window visible instead of hiding the user's only way
        // back into the still-running Hub.
        ensureAgentLeagueTray();
        mainWindow.hide();
        console.log(`[agent-league] Hub window hidden; scheduler remains alive in tray (pid=${process.pid})`);
      } catch (error) {
        destroyAgentLeagueTray();
        mainWindow.show();
        console.error('[agent-league] tray keepalive failed; close cancelled:', error && error.message);
      }
      return;
    }
    event.preventDefault();
    void beginGracefulHubShutdown('window-close-requested');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

let groupChatDispatcher = null;
let sessionAutoSuspendScheduler = null;
let agentLeagueBridge = null;
const meetingTerminalActivitySentAt = new Map();
const terminalOutputBatcher = new TerminalOutputBatcher({
  emit: ({ sessionId, data, seq }) => {
    sendToRenderer('terminal-data', { sessionId, data, seq });
  },
});

sessionManager.onData = (sessionId, data, seq) => {
  // 未聚焦的群聊成员**降频转发，不再丢弃**。旧实现直接 return，让 xterm 在未聚焦
  // 期间收不到任何数据，切过去只能靠回灌一段截断的 ANSI 流重建画面 —— 对 alt-screen
  // TUI 来说基本只剩最后一屏，用户表现为"滚不上去 / 渲染卡住"。
  // 详见 main/terminal-output-policy.js 顶部。
  const delay = getTerminalBatchDelay(sessionManager, sessionId);
  if (isBackgroundMember(sessionManager, sessionId)) {
    // 房间列表的轻量活动指示仍然限流，2 次/秒足够，不受输出节奏影响。
    const now = Date.now();
    if (now - (meetingTerminalActivitySentAt.get(sessionId) || 0) >= 500) {
      meetingTerminalActivitySentAt.set(sessionId, now);
      sendToRenderer('meeting-terminal-activity', { sessionId });
    }
  }
  terminalOutputBatcher.push(sessionId, data, seq, delay);
};

sessionManager.onSessionClosed = (sessionId, meetingId, exitInfo) => {
  const isWorkspaceMigration = workspaceMigrationSessionIds.has(sessionId);
  completionNotifier.noteSessionClosed({ sessionId });
  terminalOutputBatcher.flush(sessionId);
  meetingTerminalActivitySentAt.delete(sessionId);
  if (!isWorkspaceMigration) groupChatDispatcher?.markProcessExitForSession(sessionId, exitInfo);
  // 让投研等原生 PTY 编排者能在用户关闭窗口或 CLI 异常退出时释放跨 Hub 租约。
  sessionManager.emit('session-exited', { sessionId, meetingId, exitInfo: exitInfo || null });

  try { transcriptTap.unregisterSession(sessionId); } catch {}
  // 群聊 cli-ready monotonic guard 清理（独立模块，详见 core/group-chat-cli-ready-detector.js）
  try { cliReadyDetector.cleanup(sessionId); } catch {}
  sendToRenderer('session-closed', { sessionId });
  if (meetingId && !isWorkspaceMigration) {
    const updated = meetingManager.removeSubSession(meetingId, sessionId);
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  }
};

sessionManager.onSessionSuspended = (sessionId, meetingId, session, exitInfo) => {
  completionNotifier.noteSessionClosed({ sessionId });
  terminalOutputBatcher.flush(sessionId);
  meetingTerminalActivitySentAt.delete(sessionId);
  groupChatDispatcher?.markProcessExitForSession(sessionId, { ...(exitInfo || {}), suspended: true });
  sessionManager.emit('session-exited', {
    sessionId,
    meetingId,
    exitInfo: { ...(exitInfo || {}), suspended: true },
  });
  try { transcriptTap.unregisterSession(sessionId); } catch {}
  try { cliReadyDetector.cleanup(sessionId); } catch {}
  // Keep meeting membership and persisted metadata intact. The renderer turns
  // the existing card into a dormant entry that the normal resume path wakes.
  sendToRenderer('session-suspended', { sessionId, session });
};

// Register a freshly-spawned session with the transcript tap so the appropriate
// backend starts watching its CLI-native transcript file. DeepSeek normally
// routes to Codex; transcriptKind keeps pre-migration Claude sessions resumable.
function registerSessionForTap(session) {
  if (!session || !session.id) return;
  try {
    transcriptTap.registerSession(session.id, session.transcriptKind || session.kind, {
      cwd: session.cwd,
      transcriptPath: session.transcriptPath || undefined,
      sessionsRoot: session.codexSessionsRoot || undefined,
      codexSid: session.codexSid || undefined,
      kimiSid: session.kimiSid || undefined,
      sessionDir: session.kimiSessionDir || undefined,
      registeredAt: session.createdAt || Date.now(),
      allowMtimeFallback: !!session.codexAllowMtimeFallback,
      requirePromptMatch: !!session.meetingId,
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
  // 子进程劫持防护：在会话里再跑一个 `claude`（跑测试、批处理、脚本探针）时，
  // 子进程会继承 CLAUDE_HUB_SESSION_ID，它的 Stop hook 会把本卡片重绑到子进程的
  // transcript 上；子进程目录一旦被清理，卡片视图就 ENOENT 打不开。
  // hook 上报的 cwd 与会话 cwd 不一致时一律不重绑（卡片仍可用 ccSessionId 回退查找）。
  if (fields.cwd && current.cwd && normalizeWorkspaceKey(fields.cwd) !== normalizeWorkspaceKey(current.cwd)) {
    console.warn('[hook] ignored transcript rebind from a nested CLI:',
      `session=${String(hubSessionId).slice(0, 8)} reported=${fields.cwd} expected=${current.cwd}`);
    return null;
  }
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
  isCodexSubagentRolloutPath,
  isIsolatedHub,
  kindLabels: KIND_LABELS,
  meetingManager,
  path,
  registerSessionForTap,
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
  workspaceService,
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
  onGroupChatComplete: (event) => completionNotifier.handleGroupChatComplete(
    event,
    meetingManager.getMeeting(event && event.meetingId),
  ),
  sendToRenderer,
  sessionManager,
  transcriptTap,
});

registerGroupchatTurnIpc(ipcMain, {
  dispatchGroupChatTurn: groupChatDispatcher.dispatchGroupChatTurn,
  interruptGroupChatTurn: groupChatDispatcher.interruptMeetingTurn,
  stopLoop: (meetingId) => (global.__loopEngine ? global.__loopEngine.stopLoop(meetingId) : false),
});

// Phase 2b：main 进程循环引擎（崩溃续跑 + 成员 wake），复用 dispatcher。try 包裹，绝不影响启动。
try {
  global.__loopEngine = require('./main/groupchat/loop-engine.js').createLoopEngine({
    getDispatcher: () => groupChatDispatcher,
    meetingManager, sessionManager, sendToRenderer,
    writeReport: (html) => {
      try {
        const fsx = require('fs'), pathx = require('path'), osx = require('os');
        const dir = pathx.join(osx.homedir(), 'Desktop', 'claude-artifacts');
        fsx.mkdirSync(dir, { recursive: true });
        const f = pathx.join(dir, 'loop-report-' + Date.now() + '.html');
        fsx.writeFileSync(f, html, 'utf8');
        return f;
      } catch (e) { return null; }
    },
    logger: console,
  });
  require('./main/ipc/loop-handlers.js').registerLoopIpc(ipcMain, { loopEngine: global.__loopEngine });
} catch (e) { console.warn('[loop] engine init failed:', e && e.message); }

sessionAutoSuspendScheduler = createSessionAutoSuspendScheduler({
  sessionManager,
  getProtectedSessionIds: () => collectProtectedSessionIds({
    agentLeagueBridge,
    groupChatDispatcher,
    loopEngine: global.__loopEngine,
    meetingManager,
  }),
  logger: console,
});

// 自动休眠预演。参数与后台巡检完全一致（复用 scheduler 内部的 sweepOptions），
// 所以「预演说会休眠」和「实际会休眠」不会漂移。
registerAutoSuspendIpc(ipcMain, {
  getScheduler: () => sessionAutoSuspendScheduler,
  logger: console,
});

// 投委会五幕编排（task#5）：叠加在 research 群聊之上，复用 dispatcher 的并行发言 + 委员解析。
const committeeConductor = createCommitteeConductor({
  dispatchTurn: groupChatDispatcher.dispatchGroupChatTurn,
  getGroupMembers: (meetingId) => {
    const meeting = meetingManager.getMeeting(meetingId);
    return meeting ? groupChatDispatcher.groupMembersForMeeting(meeting) : [];
  },
  emitProgress: (meetingId, payload) => sendToRenderer('committee:progress', { meetingId, ...payload }),
  log: (m) => console.log(m),
  // 点6：闭庭后把末轮 + 主席发言喂回该 meeting 的群聊 orchestrator（写 messages 供 buildDelta 传递）。
  // 阶段二：投委会每幕发言写进群聊 messages（带幕次 meta）→ 群聊气泡渲染 + 末轮/主席喂回 AI（点6）。
  appendSpeeches: (meetingId, items, actMeta) => {
    try {
      const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      return orch && typeof orch.appendCommitteeSpeeches === 'function' ? orch.appendCommitteeSpeeches(items, actMeta) : 0;
    } catch (e) { console.log('[committee] appendSpeeches threw: ' + (e && e.message)); return 0; }
  },
  // 点3a「过往投委会」：闭庭后持久化整场 record（标的/每幕发言/双榜/主席报告）供历史回看。
  persistHistory: (record) => { try { return committeeHistory.saveRecord(getHubDataDir(), record); } catch (e) { console.log('[committee] persistHistory threw: ' + (e && e.message)); return null; } },
});
registerCommitteeIpc(ipcMain, { committeeConductor, history: committeeHistory, getHubDataDir });

// 初心投研（chuxin-research）服务桥 — 2026-07-23 Kimi 移植：独立功能，仅注册 IPC，不改主流程
const chuxinBridge = require('./main/ipc/chuxin-handlers.js').registerChuxinIpc(ipcMain, {
  getHookPort: () => hookPort,
  getHubDataDir,
  hookToken: HOOK_TOKEN,
  registerSessionForTap,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});

// 初心 Agent 投资联赛：每个参赛者绑定一个可见的普通 Hub Session，
// 账户/交易/进化状态全部落在各自 Markdown 文件夹中。
agentLeagueBridge = require('./main/ipc/agent-league-handlers.js').registerAgentLeagueIpc(ipcMain, {
  getHookPort: () => hookPort,
  getHubDataDir,
  hookToken: HOOK_TOKEN,
  registerSessionForTap,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});
if (process.env.CLAUDE_HUB_E2E === '1') {
  ipcMain.handle('debug:agent-league-background-state', () => ({
    ok: true,
    pid: process.pid,
    windowVisible: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    trayActive: !!agentLeagueTray,
    scheduler: agentLeagueBridge && agentLeagueBridge.schedulerSafety,
    runtimeAvailable: !!(agentLeagueBridge && agentLeagueBridge.runtimeStore),
  }));
  ipcMain.handle('debug:agent-league-close-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return {
      ok: true,
      windowVisible: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      trayActive: !!agentLeagueTray,
    };
  });
  ipcMain.handle('debug:agent-league-explicit-quit', () => {
    explicitHubQuitRequested = true;
    setImmediate(() => { void beginGracefulHubShutdown('e2e-explicit-quit'); });
    return { ok: true };
  });
}

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

registerPromptInspectIpc(ipcMain, {
  sessionManager,
});

registerTranscriptIpc(ipcMain, {
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutByCwd,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  // 分支会话补分支前历史时要找祖先；祖先常常已经休眠，只剩落盘记录。
  getPersistedSessions: () => lastPersistedSessions,
  isCodexCliKind,
  isUsableCodexRolloutPath,
  parseClaudeTranscriptToTurns,
  parseCodexRolloutToTurns,
  sessionManager,
  transcriptTap,
  transcriptParserService,
  updateSessionTranscriptBinding,
});

// build-injection IPC 历史用于 blackboard 用户输入合成注入子会话(meeting-blackboard.js)。
// Module C 后 blackboard 已删除,该 handler 不再被任何前端代码调用,清理。

const resumeSession = createResumeSessionHandler({
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  fs,
  getHookPort: () => hookPort,
  getHubDataDir,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isCodexBaseKind,
  isCodexSubagentRolloutPath,
  meetingManager,
  os,
  path,
  readCodexRolloutMeta,
  readTranscriptTail: (kind, sourcePath, n) => readTranscriptTail(kind, sourcePath, n, {
    parserService: transcriptParserService,
  }),
  registerSessionForTap,
  resolveCodexSessionsRoot: (meta = {}) => {
    // Meeting Codex deliberately shares the ordinary ~/.codex history. A
    // standalone resume follows its persisted subscription profile instead of
    // accidentally looking only in the currently selected account.
    if (meta.meetingId) return DEFAULT_CODEX_SESSIONS_ROOT;
    const config = getHubConfig();
    return resolveCodexUsageScope({
      ...config,
      ...(meta.codexProfile ? { codexSubscriptionProfile: meta.codexProfile } : {}),
    }, {
      hubDataDir: getHubDataDir(),
      homeDir: os.homedir(),
    }).sessionsRoot;
  },
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
});

registerSessionIpc(ipcMain, {
  getPersistedSessions: () => lastPersistedSessions,
  getTerminalOutputBatchStats: () => terminalOutputBatcher.snapshotStats(),
  meetingManager,
  registerSessionForTap,
  resumeSession,
  sendToRenderer,
  sessionManager,
  workspaceService,
});

ipcMain.handle('debug:get-managed-launch-audit', (_event, request = {}) => {
  const sessionId = request && typeof request.sessionId === 'string' ? request.sessionId : null;
  const limit = request && Number.isInteger(Number(request.limit)) ? Number(request.limit) : 100;
  const persisted = inspectManagedLaunchAudit({ sessionId, limit });
  return {
    auditPath: managedLaunchAuditPath(),
    auditHealth: {
      exists: persisted.exists,
      malformedLines: persisted.malformedLines,
      readError: persisted.readError,
    },
    live: sessionManager.getManagedLaunchAudit(sessionId),
    persisted: persisted.records,
  };
});

registerWorkspaceIpc(ipcMain, {
  allowFallbackResume: process.env.HUB_WORKSPACE_E2E_ALLOW_FALLBACK_RESUME === '1',
  dialog,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  sendToRenderer,
  sessionManager,
  shell,
  resumeSession,
  workspaceMigrationSessionIds,
  workspaceService,
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
// 2026-07-29 三方审查（Kimi 发现）：healPersistedCwds 自 2026-05 引入以来只被 import、
// 从未调用——药一直在手边没吃。workspace 从 ~/Workspaces 迁到 C:\Vibe 之后，state.json
// 里存的还是旧路径，唤醒这类休眠会话会静默回落 Home（见 session-manager 的 cwdFellBack）。
// transcript 的 jsonl 头里存着 CLI 当时真正用过的 cwd；只有该目录现在仍真实存在时
// 才能用于自愈（归档复制不会改写 jsonl，里面也可能是已经失效的旧 scratch）。
//
// 注意适用范围：它靠 ccSessionId 定位 transcript，所以只覆盖 Claude / DeepSeek。
// Codex 有 rollout 元数据、Kimi 有 session_index 各自对账，回落留痕才是它们的兜底。
// healPersistedCwds 就地改内存对象；修正成功后用完整 boot snapshot 异步落盘，避免用户
// 什么都不操作就退出时修复丢失。不能传历史语义不明的局部 state，这里显式带齐
// meetings / immersiveByMeeting，和正常持久化路径保持同一数据面。
// 只对账「可疑」的那些，不全量扫：实测 920 条会话全量对账要 873 ms，而 Hub 启动链上
// 加一秒同步 IO 是这仓库的头号痛点，不值得。可疑 = ①cwd 已不存在（迁移遗留）
// ②cwd 正好是 Home（回落的落点，最可能是被静默改写的）。实测这两类合计只有个位数。
// healPersistedCwds 是就地改对象，传子集同样会改到 lastPersistedSessions 里的那批引用。
try {
  const homeDir = path.resolve(process.env.USERPROFILE || process.env.HOME || '.').toLowerCase();
  const suspect = lastPersistedSessions.filter(s => {
    if (!s || !s.ccSessionId || !s.cwd) return false;
    if (path.resolve(s.cwd).toLowerCase() === homeDir) return true;
    try { return !fs.statSync(s.cwd).isDirectory(); } catch { return true; }
  });
  const healed = suspect.length ? healPersistedCwds(suspect) : 0;
  if (healed > 0) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: Array.isArray(bootState.meetings) ? bootState.meetings : [],
      immersiveByMeeting: (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
        ? bootState.immersiveByMeeting : {},
    });
    console.log(`[群聊] boot cwd 自愈：${suspect.length} 条可疑中修正 ${healed} 条（已排队持久化）`);
  }
} catch (error) {
  console.warn('[群聊] healPersistedCwds failed:', error && error.message);
}
// Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meeting 状态（持久化）
//   key = meetingId，value = boolean（true=沉浸，false=调试）。
//   每个 stateStore.save 调用都把这份 dict 一起写回，避免被覆盖。
let _immersiveByMeeting = (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
  ? bootState.immersiveByMeeting : {};
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
let lastPersistedMeetings = bootMeetings;
for (const m of bootMeetings) {
  meetingManager.restoreMeeting(m);
}

registerMeetingTimelineIpc(ipcMain, {
  meetingManager,
  sendToRenderer,
});

function buildSessionSearchSnapshot() {
  const sessionsById = new Map();
  for (const session of lastPersistedSessions || []) {
    const id = session && (session.hubId || session.id);
    if (id) sessionsById.set(String(id), { ...session, hubId: String(id), status: 'dormant' });
  }
  for (const session of sessionManager.getAllSessions()) {
    const id = session && (session.hubId || session.id);
    if (id) sessionsById.set(String(id), { ...sessionsById.get(String(id)), ...session, hubId: String(id) });
  }
  return {
    sessions: [...sessionsById.values()],
    meetings: typeof meetingManager.getSearchMetadata === 'function'
      ? meetingManager.getSearchMetadata()
      : [],
  };
}

registerArchiveIpc(ipcMain, {
  searchService: sessionSearchService,
  getSearchSnapshot: buildSessionSearchSnapshot,
});
// Let the renderer and hook server finish their latency-sensitive boot path
// before the worker starts walking transcript directories. Querying search
// earlier still starts the same worker on demand and reports visible progress.
const sessionSearchPrewarmDelayMs = Math.max(
  250,
  Number(process.env.HUB_SESSION_SEARCH_PREWARM_DELAY_MS) || 5_000,
);
const sessionSearchPrewarmTimer = setTimeout(() => {
  void (async () => {
    const lockPath = path.join(getHubDataDir(), 'cache', 'session-search-prewarm.lock');
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch {}
    const lock = await acquireLockAsync(lockPath, { retries: 0, staleMs: 30 * 60 * 1000 });
    if (!lock) return;
    try {
      await sessionSearchService.prewarm(buildSessionSearchSnapshot());
    } catch (error) {
      console.warn('[session-search] background prewarm failed:', error && error.message);
    } finally {
      await releaseLockAsync(lock, lockPath);
    }
  })().catch(error => {
    console.warn('[session-search] background prewarm lock failed:', error && error.message);
  });
}, sessionSearchPrewarmDelayMs);
sessionSearchPrewarmTimer.unref?.();

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
  getLastPersistedMeetings: () => lastPersistedMeetings,
  getLastPersistedSessionIds: () => _lastPersistedSessionIds,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  meetingStore,
  sessionStore,
  setLastPersistedMeetingIds: (ids) => { _lastPersistedMeetingIds = ids; },
  setLastPersistedMeetings: (meetings) => { lastPersistedMeetings = meetings; },
  setLastPersistedSessionIds: (ids) => { _lastPersistedSessionIds = ids; },
  setLastPersistedSessions: (sessions) => { lastPersistedSessions = sessions; },
  stateStore,
});

registerResumeSessionIpc(ipcMain, { resumeSession });

const imageDir = path.join(getHubDataDir(), 'images');
registerAppUtilityIpc(ipcMain, {
  clipboard,
  crypto,
  fs,
  getHookPort: () => hookPort,
  getMainWindow: () => mainWindow,
  getNetworkEgressStatus: options => networkEgressMonitor.getStatus(options),
  acknowledgeNetworkEgressChange: () => networkEgressMonitor.acknowledgeForeignChange(),
  imageDir,
  path,
});

// 全机残留回收。多个 Hub 实例共用同一个数据目录，所以任何一个实例打开这张卡片
// 看到的都是「整台电脑」的情况，而不只是自己名下那点进程。
// v1 只读：出清单 + 生成可审阅的预演脚本，Hub 自己不杀任何进程。
registerProcessReclaimIpc(ipcMain, {
  getSessionManager: () => sessionManager,
  getDataDir: () => getHubDataDir(),
  logger: console,
});

// 驾驶舱 UI 删了，但这个服务还留着：工作台「最近文件」卡的 Git 变更来自它的 overview。
const workbenchOperationsService = createWorkbenchOperationsService({
  dataDir: getHubDataDir(),
  getConfig: getHubConfig,
});
registerWorkbenchOperationsIpc(ipcMain, {
  service: workbenchOperationsService,
  logger: console,
});

registerPathIpc(ipcMain);
registerChatgptBridgeIpc(ipcMain, { sessionManager });

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires lifecycle hooks. Forwards compact observations to the renderer's
// RuntimeTruth reducer; the hook request never blocks on transcript parsing
// except for the final Stop preview fallback.
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  // 2026-05-16 道雪：防卡死 — 外部 HTTP 救援入口，tools/hub-escape.ps1 调
  const isEscapeHome = req.method === 'POST' && req.url === '/api/escape-home';
  // Plan 2: 3 个新聚合 endpoint（走 research-mcp/query.py 而非 LinDangAgent.data_query.py）
  const isResearchStockStatic = req.method === 'POST' && req.url === '/api/research/stock-static';
  const isResearchStockMarket = req.method === 'POST' && req.url === '/api/research/stock-market';
  const isResearchStockNews = req.method === 'POST' && req.url === '/api/research/stock-news';
  const isResearchStockSentiment = req.method === 'POST' && req.url === '/api/research/stock-sentiment';
  const isResearchStockScan = req.method === 'POST' && req.url === '/api/research/stock-scan';
  const isResearchKlineSimilarity = req.method === 'POST' && req.url === '/api/research/kline-similarity';
  const isResearchFetch = isResearchStockStatic || isResearchStockMarket || isResearchStockNews || isResearchStockSentiment || isResearchStockScan
    || isResearchKlineSimilarity;
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
    // Research mode MCP callbacks (loopback)：stock_static / stock_market / stock_news / scan_* 系列。
    if (isResearchFetch) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      const { meetingId, kind, symbol, depth, mode, scan_type, only_subject_stock,
              window: ksWindow, top_k: ksTopK, method: ksMethod, feature: ksFeature, exclude_self_recent: ksExclude } = parsed;
      const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
      const chuxinResearch = chuxinBridge
        && typeof chuxinBridge.isAuthorizedResearchScope === 'function'
        && chuxinBridge.isAuthorizedResearchScope(meetingId);
      const agentLeagueResearch = agentLeagueBridge
        && typeof agentLeagueBridge.isAuthorizedResearchScope === 'function'
        && agentLeagueBridge.isAuthorizedResearchScope(meetingId);
      if ((!meeting || meeting.scene !== 'research') && !chuxinResearch && !agentLeagueResearch) {
        res.writeHead(400); res.end('{"error":"not research mode"}'); return;
      }
      const t0 = Date.now();
      let result;
      try {
        if (isResearchStockStatic) {
          result = await lindangBridge.fetchStatic(symbol, depth);
        } else if (isResearchStockMarket) {
          result = await lindangBridge.fetchMarket(symbol, depth, mode);
        } else if (isResearchStockNews) {
          result = await lindangBridge.fetchNews(symbol, depth);
        } else if (isResearchStockSentiment) {
          result = await lindangBridge.fetchSentiment(symbol, depth, only_subject_stock);
        } else if (isResearchStockScan) {
          result = await lindangBridge.fetchScan(scan_type, depth);
        } else if (isResearchKlineSimilarity) {
          result = await lindangBridge.fetchKlineSimilarity(symbol, {
            window: ksWindow, top_k: ksTopK, method: ksMethod,
            feature: ksFeature, exclude_self_recent: ksExclude,
          });
        } else {
          result = { ok: false, error: 'unknown research endpoint' };
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
        const event = req.url.slice('/api/hook/'.length);
        const eventAt = Date.now();
        // Prefer the UserPromptSubmit payload's `prompt` field when present —
        // it's the just-submitted text and doesn't depend on CC having flushed
        // the new transcript entry to disk. For Stop events (no `prompt` in
        // payload) fall back to reading the transcript JSONL tail (async —
        // long transcripts used to block the main-process event loop).
        let latestUserMessage = null;
        if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
          latestUserMessage = parsed.prompt;
        } else if (event === 'stop' && parsed.transcriptPath) {
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
            cwd: parsed.cwd,
          });
        }
        if (event === 'stop' && parsed.transcriptPath) {
          transcriptTap.notifyClaudeStop(parsed.sessionId, parsed.transcriptPath).catch(() => {});
        }
        if (event === 'prompt' && latestUserMessage) {
          maybeAutoTitleSessionFromPrompt({
            hubSessionId: parsed.sessionId,
            text: latestUserMessage,
            submittedAt: eventAt,
            signalSource: 'hook_prompt',
          });
        }
        sendToRenderer('hook-event', {
          event,
          eventAt,
          sessionId: parsed.sessionId,
          claudeSessionId: parsed.claudeSessionId,
          cwd: parsed.cwd,
          latestUserMessage,
          backgroundTasks: Array.isArray(parsed.backgroundTasks) ? parsed.backgroundTasks : [],
          sessionCrons: Array.isArray(parsed.sessionCrons) ? parsed.sessionCrons : [],
          error: parsed.error || null,
          errorDetails: parsed.errorDetails || null,
          lastAssistantMessage: parsed.lastAssistantMessage || null,
          notificationType: parsed.notificationType || null,
          message: parsed.message || null,
          title: parsed.title || null,
          toolName: parsed.toolName || null,
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
const STATUSLINE_CACHE_FILE = path.join(getHubDataDir(), 'statusline-cache.json');
let _usageCacheMemory = null;
let _usageCacheWriteTimer = null;
let _usageCacheWriteQueue = Promise.resolve();

function scheduleUsageCacheWrite() {
  if (_usageCacheWriteTimer) clearTimeout(_usageCacheWriteTimer);
  _usageCacheWriteTimer = setTimeout(() => {
    _usageCacheWriteTimer = null;
    const snapshot = JSON.parse(JSON.stringify(_usageCacheMemory || {}));
    _usageCacheWriteQueue = _usageCacheWriteQueue.then(async () => {
      const merged = await writeMergedUsageCacheFile(USAGE_CACHE_FILE, snapshot);
      // Keep newer in-process updates that arrived while this write waited on
      // another Hub's lock; the next scheduled write will persist them.
      _usageCacheMemory = mergeUsageCacheSnapshots(merged, _usageCacheMemory || {}, Date.now());
    }).catch(error => console.warn('[usage-cache] async write failed:', error && error.message));
  }, 100);
  _usageCacheWriteTimer.unref?.();
}

function flushUsageCacheSync() {
  if (_usageCacheWriteTimer) {
    clearTimeout(_usageCacheWriteTimer);
    _usageCacheWriteTimer = null;
  }
  if (_usageCacheMemory === null) return;
  _usageCacheMemory = writeMergedUsageCacheFileSync(USAGE_CACHE_FILE, _usageCacheMemory);
}

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
      ts: data.ts || Date.now(),
    };
    _usageCacheMemory = existing;
    scheduleUsageCacheWrite();
  } catch {}
}

function loadStatuslineCache() {
  try { return JSON.parse(fs.readFileSync(STATUSLINE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

function refreshClaudeAccountUsageFromStatuslineCache() {
  const before = loadUsageCache().claude || null;
  const snapshot = selectClaudeStatuslineUsage(loadStatuslineCache());
  if (!snapshot) {
    return {
      data: before,
      changed: false,
      observedAt: before && (before.observedAt || before.ts) || 0,
      source: 'statusline-cache',
    };
  }
  const filtered = claudeUsageFilter.filter(snapshot.usage5h, snapshot.usage7d);
  if (filtered.anyAccepted) {
    cacheAccountUsage({
      usage5h: filtered.usage5h,
      usage7d: filtered.usage7d,
      ts: snapshot.ts,
    });
  }
  const data = loadUsageCache().claude || null;
  return {
    data,
    changed: didClaudeSnapshotAdvance(before, { ...data, observedAt: snapshot.ts }),
    observedAt: snapshot.ts,
    source: snapshot.source,
  };
}

function cacheAgentUsage(provider, tokenData, scope = null) {
  try {
    const existing = loadUsageCache();
    const scoped = provider === 'codex' && scope
      ? attachCodexUsageScope(tokenData, scope)
      : tokenData;
    const observedAt = tokenData && (tokenData.observedAt || tokenData._ts) || Date.now();
    existing[provider] = { ...scoped, ts: observedAt };
    _usageCacheMemory = existing;
    scheduleUsageCacheWrite();
  } catch {}
}

function readUsageCacheDisk() {
  return readUsageCacheFile(USAGE_CACHE_FILE);
}

function loadUsageCache() {
  const disk = readUsageCacheDisk();
  _usageCacheMemory = _usageCacheMemory === null
    ? disk
    : mergeUsageCacheSnapshots(disk, _usageCacheMemory, Date.now());
  return { ..._usageCacheMemory };
}

function currentCodexUsageScope() {
  return resolveCodexUsageScope(getHubConfig(), {
    hubDataDir: getHubDataDir(),
    homeDir: os.homedir(),
  });
}

let _codexLiveUsage = null;

async function refreshCodexAccountUsageLive() {
  const scope = currentCodexUsageScope();
  if (scope.backend !== 'subscription') {
    throw new Error('Codex API 模式没有订阅配额窗口');
  }
  const config = getHubConfig();
  const raw = await readCodexAccountUsage({
    home: scope.home,
    proxy: config.proxy,
    cwd: os.homedir(),
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  _codexLiveUsage = attachCodexUsageScope(payload, scope);
  cacheAgentUsage('codex', payload, scope);
  return _codexLiveUsage;
}

async function refreshKimiAccountUsageLive() {
  const raw = await readKimiAccountUsage({
    home: process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'),
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  cacheAgentUsage('kimi', payload);
  return payload;
}

async function refreshDeepSeekAccountBalanceLive() {
  const raw = await readDeepSeekAccountBalance({
    apiKey: getHubConfig().deepseekApiKey,
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  cacheAgentUsage('deepseek', payload);
  return payload;
}

function loadUsageCacheForCurrentConfig() {
  const scoped = filterUsageCacheForCodexScope(loadUsageCache(), currentCodexUsageScope());
  if (scoped.codex && scoped.codex.source === 'app-server') {
    scoped.codex = expireCodexUsageWindows(scoped.codex, Date.now());
  }
  return scoped;
}

try {
  const cachedCodex = loadUsageCacheForCurrentConfig().codex;
  if (cachedCodex && cachedCodex.source === 'app-server') _codexLiveUsage = cachedCodex;
} catch {}

registerUsageIpc(ipcMain, {
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  loadUsageCacheForCurrentConfig,
  refreshClaudeAccountUsage: refreshClaudeAccountUsageFromStatuslineCache,
  refreshCodexAccountUsage: () => refreshCodexUsageIfDue(true),
  refreshDeepSeekAccountBalance: refreshDeepSeekAccountBalanceLive,
  refreshKimiAccountUsage: refreshKimiAccountUsageLive,
  scanAgentSessions,
});

registerConfigIpc(ipcMain, {
  attachCodexUsageScope,
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  clearSessionManagerConfigCache,
  currentCodexUsageScope,
  getCompletionNotificationHealth: () => completionNotifier.getHealth(),
  meetingManager,
  scanAgentSessions,
  sendToRenderer,
  sessionManager,
  testCompletionNotification: (payload) => completionNotifier.sendTest(payload),
});

// --- 梦境系统（Dream Consolidation）+ 记忆面板 ---
// IPC 为面板提供只读巡检数据与手动触发；调度器每天到点自动跑一轮沉淀。
// 写入一律走 dream-consolidation 的快照+changelog 通道，可回溯可回滚。
const { registerMemoryIpc } = require('./main/ipc/memory-handlers.js');
registerMemoryIpc(ipcMain, { workspaceService, logger: console });
const { startDreamScheduler } = require('./core/dream-consolidation.js');
startDreamScheduler({
  hubDataDir: getHubDataDir(),
  workspaceRoot: workspaceService.getWorkspaceRoot(),
  getHubConfig,
  logger: console,
});

// --- Gemini/Codex/Kimi ring-buffer usage scanner ---
// Periodically scans agent sessions' ring buffers for token/model patterns
// and emits status-event so the renderer can show context/usage badges.
const _agentLastStatus = new Map();
const _agentQuota = { gemini: null };
const _codexCliQuotaBySession = new Map();
const CODEX_CLI_USAGE_FRESH_MS = 2 * 60 * 1000;

// --- Codex JSONL-based usage scanner ---
// Codex CLI writes rate-limit snapshots to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// They are a passive fallback; manual refresh uses app-server for the selected profile.
// Each file contains token_count events with primary (5h) and secondary (7d) windows.
let _codexJsonlLastScan = 0;
let _codexJsonlCached = null;
const _codexJsonlCachedByRoot = new Map();
const CODEX_JSONL_THROTTLE_MS = 5_000;
const CODEX_JSONL_CANDIDATE_LIMIT = 20;

async function scanCodexJsonlUsage(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  try {
    const result = await codexJsonlUsageService.scan(sessionsDir, {
      minObservedAt: opts.minObservedAt || 0,
      candidateLimit: CODEX_JSONL_CANDIDATE_LIMIT,
    });
    return result.data;
  } catch {
    return null;
  }
}

async function scanCodexJsonlUsageThrottled(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  const now = Date.now();
  const key = [
    path.resolve(sessionsDir || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase(),
    Math.floor(Number(opts.minObservedAt) || 0),
  ].join('|');
  const cached = _codexJsonlCachedByRoot.get(key);
  if (!opts.force && cached && now - cached.ts < CODEX_JSONL_THROTTLE_MS) return cached.data;
  const data = await scanCodexJsonlUsage(sessionsDir, opts);
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

async function scanAgentSessions(opts = {}) {
  const force = !!opts.force;
  const allSessions = sessionManager.getAllSessions();
  for (const s of allSessions) {
    const runtimeKind = s.transcriptKind || s.kind;
    const isOpenAiCodex = s.kind === 'codex' || s.kind === 'codex-resume';
    if (runtimeKind !== 'gemini' && !isCodexBaseKind(runtimeKind) && !isKimiCliKind(runtimeKind)) continue;
    if (s.status === 'dormant') continue;
    const buf = sessionManager.getSessionBuffer(s.id);
    if (!buf) continue;
    const plain = stripAnsi(buf);
    const parsed = runtimeKind === 'gemini'
      ? parseGeminiUsage(plain)
      : isKimiCliKind(runtimeKind)
        ? parseKimiUsage(plain)
        : parseCodexUsage(plain);
    if (isOpenAiCodex && (parsed.usage5h || parsed.usage7d)) {
      const usageSig = JSON.stringify({ usage5h: parsed.usage5h || null, usage7d: parsed.usage7d || null });
      const usageKey = s.id + ':codex-cli-usage';
      if (_agentLastStatus.get(usageKey) !== usageSig) {
        _agentLastStatus.set(usageKey, usageSig);
        recordCodexCliUsage(
          _codexCliQuotaBySession,
          s,
          parsed,
          Date.now(),
          DEFAULT_CODEX_SESSIONS_ROOT,
        );
      }
    }
    if (parsed.tokensUsed) {
      const prev = _agentLastStatus.get(s.id + ':tok');
      if (prev !== parsed.tokensUsed) {
        const delta = prev ? parsed.tokensUsed - prev : parsed.tokensUsed;
        const scopeKey = isOpenAiCodex
          ? agentUsageScopeKey(s.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT)
          : null;
        if (delta > 0) recordAgentTokens(isOpenAiCodex ? 'codex' : runtimeKind, delta, scopeKey);
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
  // Expire stale CLI quota entries (no fresh CLI data for >10 min).
  const now = Date.now();
  if (_agentQuota.gemini && _agentQuota.gemini._ts && now - _agentQuota.gemini._ts > 10 * 60 * 1000) {
    _agentQuota.gemini = null;
  }
  pruneCodexCliUsage(_codexCliQuotaBySession, now, 10 * 60 * 1000);
  // Build and broadcast per-provider usage.
  // Manual app-server reads are authoritative for the selected profile. Newer
  // CLI/JSONL snapshots may supersede them only when the weekly reset boundary
  // proves they belong to the same account/window.
  const agentData = {};
  // Codex: visible `/usage` output is the freshest user-triggered source.
  // Fall back to JSONL token_count snapshots, then local token estimates.
  const codexScope = currentCodexUsageScope();
  const freshCodexCliUsage = selectCodexCliUsageForScope(_codexCliQuotaBySession, codexScope, {
    now,
    maxAgeMs: CODEX_CLI_USAGE_FRESH_MS,
    defaultSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  });
  const cachedCodexCliUsage = selectCodexCliUsageForScope(_codexCliQuotaBySession, codexScope, {
    now,
    maxAgeMs: 10 * 60 * 1000,
    defaultSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  });
  const codexJsonl = freshCodexCliUsage ? null : await scanCodexJsonlUsageThrottled(codexScope.sessionsRoot, {
    force,
    minObservedAt: codexScope.authSinceMs || 0,
  });
  if (freshCodexCliUsage) {
    const payload = { ...freshCodexCliUsage, source: 'cli-usage', observedAt: freshCodexCliUsage._ts, _ts: freshCodexCliUsage._ts };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else if (codexJsonl) {
    const payload = { ...codexJsonl, source: 'jsonl', _ts: codexJsonl.observedAt || now };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else if (cachedCodexCliUsage) {
    const payload = { ...cachedCodexCliUsage, source: 'cli', observedAt: cachedCodexCliUsage._ts, _ts: cachedCodexCliUsage._ts };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else {
    const usage = calcAgentUsage('codex', codexScope.sessionsRoot);
    if (usage) {
      const payload = { ...usage, source: 'estimate', observedAt: now, _ts: now };
      agentData.codex = attachCodexUsageScope(payload, codexScope);
      cacheAgentUsage('codex', payload, codexScope);
    } else {
      agentData.codex = attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, codexScope);
    }
  }
  const inMemoryLiveForScope = _codexLiveUsage && _codexLiveUsage.scopeKey === codexScope.scopeKey
    ? expireCodexUsageWindows(_codexLiveUsage, now)
    : null;
  const diskForScope = loadUsageCacheForCurrentConfig().codex;
  const cachedLiveForScope = diskForScope && diskForScope.source === 'app-server'
    ? expireCodexUsageWindows(diskForScope, now)
    : null;
  const liveForScope = mergeCodexEntry(cachedLiveForScope, inMemoryLiveForScope, now);
  if (shouldPreferCodexLiveUsage(liveForScope, agentData.codex, now)) {
    agentData.codex = liveForScope;
    cacheAgentUsage('codex', liveForScope, codexScope);
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
  return agentData;
}

let _agentScanInterval = null;
let _agentScanInFlight = null;
let _deepseekBalanceRefreshInFlight = null;
let _deepseekBalanceLastAttempt = 0;
let _kimiUsageRefreshInFlight = null;
let _kimiUsageLastAttempt = 0;
let _codexUsageRefreshInFlight = null;
let _codexUsageLastAttempt = 0;
const DEEPSEEK_BALANCE_REFRESH_MS = 5 * 60 * 1000;
const KIMI_USAGE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;

function refreshCodexUsageIfDue(force = false) {
  const now = Date.now();
  if (_codexUsageRefreshInFlight) return _codexUsageRefreshInFlight;
  if (!force && now - _codexUsageLastAttempt < CODEX_USAGE_REFRESH_MS) return null;
  _codexUsageLastAttempt = now;
  _codexUsageRefreshInFlight = refreshCodexAccountUsageLive()
    .then((codex) => {
      sendToRenderer('agent-usage', { codex });
      return codex;
    })
    .finally(() => { _codexUsageRefreshInFlight = null; });
  return _codexUsageRefreshInFlight;
}

function refreshDeepSeekBalanceIfDue(force = false) {
  const now = Date.now();
  if (_deepseekBalanceRefreshInFlight) return _deepseekBalanceRefreshInFlight;
  if (!force && now - _deepseekBalanceLastAttempt < DEEPSEEK_BALANCE_REFRESH_MS) return null;
  _deepseekBalanceLastAttempt = now;
  _deepseekBalanceRefreshInFlight = refreshDeepSeekAccountBalanceLive()
    .then((deepseek) => {
      sendToRenderer('agent-usage', { deepseek });
      return deepseek;
    })
    .catch(() => null)
    .finally(() => { _deepseekBalanceRefreshInFlight = null; });
  return _deepseekBalanceRefreshInFlight;
}

function refreshKimiUsageIfDue(force = false) {
  const now = Date.now();
  if (_kimiUsageRefreshInFlight) return _kimiUsageRefreshInFlight;
  if (!force && now - _kimiUsageLastAttempt < KIMI_USAGE_REFRESH_MS) return null;
  _kimiUsageLastAttempt = now;
  _kimiUsageRefreshInFlight = refreshKimiAccountUsageLive()
    .then((kimi) => {
      sendToRenderer('agent-usage', { kimi });
      return kimi;
    })
    .catch(() => null)
    .finally(() => { _kimiUsageRefreshInFlight = null; });
  return _kimiUsageRefreshInFlight;
}

function startAgentScanner() {
  if (_agentScanInterval) return;
  const run = () => {
    if (_agentScanInFlight) return _agentScanInFlight;
    _agentScanInFlight = scanAgentSessions()
      .catch(error => console.warn('[usage-scan] failed:', error && error.message))
      .finally(() => { _agentScanInFlight = null; });
    return _agentScanInFlight;
  };
  void run();
  void refreshCodexUsageIfDue(true).catch(() => null);
  refreshDeepSeekBalanceIfDue(true);
  refreshKimiUsageIfDue(true);
  _agentScanInterval = setInterval(() => {
    void run();
    const codexRefresh = refreshCodexUsageIfDue(false);
    if (codexRefresh) void codexRefresh.catch(() => null);
    refreshDeepSeekBalanceIfDue(false);
    refreshKimiUsageIfDue(false);
  }, 5000);
}

app.whenReady().then(async () => {
  traceStartup('app.whenReady');
  // Source-mode Electron has no installed exe identity of its own. Keep a
  // branded Start Menu shortcut + Jump List relaunch task bound to the Hub
  // AUMID, or Windows can cache a bare electron.exe relaunch command. Isolated
  // E2E Hubs must never touch this production Shell registration.
  if (process.platform === 'win32' && !isIsolatedHub()) {
    const hubIconPath = path.join(__dirname, 'claude-wx.ico');
    const hubProductVersion = (() => {
      try { return require('./package.json').version || ''; } catch { return ''; }
    })();
    const brandingOptions = {
      execPath: process.execPath,
      icoPath: hubIconPath,
      productVersion: hubProductVersion,
    };

    const startShellIntegration = (execPath) => {
      const windowsShellOptions = {
        app,
        shell,
        appRoot: __dirname,
        execPath,
        isPackaged: HUB_IS_PACKAGED,
        iconPath: hubIconPath,
      };
      const shellResult = ensureWindowsShellIntegration(windowsShellOptions);
      if (shellResult.legacyBackupPath) {
        console.warn(`[windows-shell] retired broken Electron shortcut: ${shellResult.legacyBackupPath}`);
      }
      if (windowsShellWatchdog) windowsShellWatchdog.stop();
      // The canonical shortcut was observed disappearing hours after a successful
      // repair, leaving an otherwise valid .ico rendered as Windows' white-page
      // placeholder. Re-check the tiny Shell Link every 15s and repair drift.
      windowsShellWatchdog = startWindowsShellIntegrationWatchdog({
        ...windowsShellOptions,
        // 每一拍无条件重贴窗口图标：Explorer 重启丢 HICON 时快捷方式是好的，
        // 健康检查不会失败，onRepair 不会触发（详见 reassertHubWindowIcon 注释）。
        onTick: reassertHubWindowIcon,
        onRepair: reassertHubWindowIcon,
      });
      return windowsShellOptions.execPath;
    };

    // 快捷方式先指向当前可用的启动器：品牌化副本在就用它，不在就回落 electron.exe。
    let hubLaunchExePath = startShellIntegration(resolveHubLaunchExePath(brandingOptions));

    // 品牌化副本缺失或过期时后台重建。electron.exe 220MB+，读+改资源+写一整遍
    // 要好几秒，绝不能在主进程同步跑；用 ELECTRON_RUN_AS_NODE 起子进程。
    // 只新增/替换 AIGroupChatHub.exe，永不触碰 electron.exe（node_modules 完整性铁律）。
    const brandingState = describeBrandingHealth(brandingOptions);
    if (!brandingState.healthy && brandingState.expected) {
      console.log(`[hub-brand] ${brandingState.message}，后台重建中`);
      const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'brand-hub-exe.js')], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let childLog = '';
      child.stdout.on('data', d => { childLog += d.toString(); });
      child.stderr.on('data', d => { childLog += d.toString(); });
      child.on('error', err => console.warn(`[hub-brand] spawn 失败：${err.message}`));
      child.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[hub-brand] 重建失败 (exit ${code})，快捷方式继续用 electron.exe\n${childLog.trim()}`);
          return;
        }
        const rebuiltExePath = resolveHubLaunchExePath(brandingOptions);
        if (rebuiltExePath === hubLaunchExePath) return;
        // 重建成功：把快捷方式和 Jump List 重指到品牌化 exe。下次从桌面启动，
        // 窗口类图标就是橙色 logo，Explorer 再怎么重建任务栏都摸不到 Electron 原子。
        hubLaunchExePath = startShellIntegration(rebuiltExePath);
        console.log(`[hub-brand] 已重建并重指快捷方式：${rebuiltExePath}`);
      });
      child.unref();
    }
  }
  const _home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  // Isolated E2E must not mutate or poll production ~/.claude settings. Real
  // Claude integration tests provide their own config explicitly; ordinary
  // renderer/PTY tests need no hook deployment at all.
  const claudeDirs = isIsolatedHub()
    ? []
    : ['.claude', '.claude-deepseek'].map(dir => path.join(_home, dir));
  const hookSourceScriptsDir = HUB_IS_PACKAGED
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');
  traceStartup('deploy hooks start');
  // 2026-05-05 道雪：所有 Claude family 隔离配置目录都必须部署 Stop hook，否则
  //   该家族 sub session 完成时 CC 不调 hook → notifyClaudeStop 永不触发 →
  //   ClaudeTap.JsonlTail 永不启动 → stop_reason 主路径 + idle 兜底全失效 →
  //   群聊卡片自动同步死，只能等 5min 硬 timeout 或用户手动点提取。
  //   scripts/session-hub-hook.py 也不存在。与 findTranscriptByCCSessionId 的
  //   candidateRoots 列表对齐，单一真理源应在 ai-kinds.js（后续可重构）。
  for (const claudeDir of claudeDirs) ensureHooksDeployed(claudeDir);
  // settings.json can be rewritten by Claude settings/plugin changes while the
  // Hub keeps running. A one-time boot merge is therefore insufficient: the
  // screenshot incident had UserPromptSubmit=[] and no Hub Stop hook five
  // hours after launch. Periodically repair only Hub-owned entries.
  if (claudeDirs.length) {
    claudeHookWatchdog = startClaudeHookIntegrationWatchdog({
      claudeDirs,
      sourceScriptsDir: hookSourceScriptsDir,
      logger: console,
    });
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

  // 2026-06-05 联邦记忆下线：claude-memory-loader 只做 readFileSync，无需预热

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
  sessionAutoSuspendScheduler.start();
});

let shutdownDrainState = 'idle';
let shutdownDrainPromise = null;
let finalShutdownCleanupDone = false;
let hookServerClosedForShutdown = false;

function closeHookServerForShutdown() {
  if (hookServerClosedForShutdown) return;
  hookServerClosedForShutdown = true;
  try { hookServer.close(); } catch (error) {
    console.warn('[shutdown] hook server close failed:', error && error.message);
  }
}

async function runFinalShutdownCleanup() {
  if (finalShutdownCleanupDone) return { clean: true, errors: [] };
  finalShutdownCleanupDone = true;
  const errors = [];
  const capture = (label, action) => {
    try { action(); }
    catch (error) { errors.push({ label, message: error && error.message ? error.message : String(error) }); }
  };
  capture('completion-notifier', () => completionNotifier.dispose());
  capture('session-auto-suspend', () => sessionAutoSuspendScheduler?.stop());
  capture('claude-hook-watchdog', () => claudeHookWatchdog?.stop());
  claudeHookWatchdog = null;
  capture('windows-shell-watchdog', () => windowsShellWatchdog?.stop());
  windowsShellWatchdog = null;
  capture('terminal-output-batcher', () => terminalOutputBatcher.dispose({ flush: true }));
  clearTimeout(sessionSearchPrewarmTimer);
  const workerResults = await Promise.allSettled([
    transcriptParserService.close(),
    sessionSearchService.close(),
    codexJsonlUsageService.close(),
  ]);
  workerResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push({
        label: ['transcript-parser', 'session-search', 'codex-usage'][index],
        message: result.reason && result.reason.message ? result.reason.message : String(result.reason),
      });
    }
  });
  capture('transcript-tap', () => transcriptTap.dispose());
  // 原生投研 PTY 的全局租约属于 Hub 进程生命周期。退出时同步释放，
  // 让另一台/另一个 Hub 可以立即恢复同一个 native session；崩溃场景
  // 仍由 registry 的过期租约兜底。
  if (chuxinBridge && typeof chuxinBridge.releaseAllOwnership === 'function') {
    capture('chuxin-ownership', () => chuxinBridge.releaseAllOwnership());
  }
  if (agentLeagueBridge && typeof agentLeagueBridge.stopScheduler === 'function') {
    capture('agent-league-scheduler', () => agentLeagueBridge.stopScheduler());
  }
  capture('agent-league-tray', () => destroyAgentLeagueTray());
  // 2026-05-07 道雪：退出时保证三层都同步落盘——state.json（lock + merge）、
  //   per-meeting JSON、per-session JSON。任意一层丢了，下次 boot 的 selfHeal
  //   都能从另一层恢复。
  capture('usage-cache', () => flushUsageCacheSync());
  try {
    meetingStore.flushAll();
    console.log('[群聊] meeting-store flushed on quit');
  } catch (err) {
    errors.push({ label: 'meeting-store', message: err && err.message ? err.message : String(err) });
    console.warn('[群聊] meeting-store flush failed:', err.message);
  }
  try {
    sessionStore.flushAll();
    console.log('[hub] session-store flushed on quit');
  } catch (err) {
    errors.push({ label: 'session-store', message: err && err.message ? err.message : String(err) });
    console.warn('[hub] session-store flush failed:', err.message);
  }

  const clean = errors.length === 0;
  try {
    stateStore.save({ version: 1, cleanShutdown: clean, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings(), immersiveByMeeting: _immersiveByMeeting }, { sync: true });
  } catch (error) {
    errors.push({ label: 'state-store', message: error && error.message ? error.message : String(error) });
  }

  // 2026-05-16 道雪：清理自己的控制文件。unlinkSelf 内部已 try/catch + warn 非 ENOENT 错误，
  // 不外抛，所以这里裸调即可，不再加外层 catch（避免盖住内部 warn）。
  capture('hub-control', () => hubControl.unlinkSelf(getHubDataDir(), process.pid));
  if (errors.length) console.error('[shutdown] cleanup completed with errors:', errors);
  return { clean: errors.length === 0, errors };
}

function restoreWindowAfterFailedShutdown() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (process.env.CLAUDE_HUB_E2E_WINDOW_MODE !== 'hidden') {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (error) {
    console.error('[shutdown] failed to preserve a retryable Hub window:', error && error.message);
  }
}

function beginGracefulHubShutdown(reason) {
  if (shutdownDrainPromise) return shutdownDrainPromise;

  shutdownDrainState = 'draining';
  console.log(`[shutdown] draining PTYs before Electron teardown (${reason})`);
  // Freeze Agent League dispatch before SessionManager starts terminating PTYs.
  // Active tasks remain durable/orphan-recoverable and the phase lease is only
  // released by final cleanup after every PTY exit callback has settled.
  if (agentLeagueBridge && typeof agentLeagueBridge.beginHandoff === 'function') {
    try { agentLeagueBridge.beginHandoff(reason); }
    catch (error) { console.warn('[shutdown] agent league handoff preparation failed:', error && error.message); }
  }
  shutdownDrainPromise = sessionManager.disposeGracefully({ logger: console, warnAfterMs: 5000, drainTimeoutMs: 15_000 })
    .then(async (result) => {
      if (!result || result.safeToQuit !== true) {
        shutdownDrainState = 'idle';
        shutdownDrainPromise = null;
        console.error('[shutdown] PTY drain did not reach a safe state; close was cancelled and may be retried', result);
        restoreWindowAfterFailedShutdown();
        return result;
      }
      closeHookServerForShutdown();
      const cleanup = await runFinalShutdownCleanup();
      process.__hubShutdownCleanupClean = cleanup.clean === true;
      shutdownDrainState = 'drained';
      console.log(`[shutdown] PTY drain complete: ${result.drainedPtyCount} session(s), ${result.durationMs}ms`);
      if (!cleanup.clean) console.error('[shutdown] exiting with cleanShutdown=false because cleanup reported errors');
      // Re-enter app.quit only after every node-pty onExit callback completed
      // while the Node environment was still alive.
      app.quit();
      return { ...result, cleanup };
    })
    .catch((error) => {
      shutdownDrainState = 'idle';
      shutdownDrainPromise = null;
      console.error('[shutdown] PTY drain failed; refusing unsafe Electron teardown:', error && error.stack || error);
      restoreWindowAfterFailedShutdown();
      return { safeToQuit: false, error: error && error.message ? error.message : String(error) };
    });
  return shutdownDrainPromise;
}

app.on('before-quit', (event) => {
  if (shutdownDrainState === 'drained' || shutdownDrainState === 'finalizing') {
    shutdownDrainState = 'finalizing';
    return;
  }
  event.preventDefault();
  void beginGracefulHubShutdown('before-quit');
});

app.on('window-all-closed', () => {
  void beginGracefulHubShutdown('window-all-closed');
});
