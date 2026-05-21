const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
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
const cliReadyDetector = require('./core/group-chat-cli-ready-detector.js');
const lindangBridge = require('./core/lindang-bridge.js');
const { getConfig: getHubConfig } = require('./core/hub-config.js');
const packyBalance = require('./core/packy-balance.js');
const {
  resolveCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
} = require('./core/codex-usage-scope.js');
const { ALL_AI_KINDS, isClaudeFamily, SLOT_IDS, KIND_LABELS, getSlotPromptName, getSlotDisplayLabel, slotIdToIndex, slotIndexToId } = require('./core/ai-kinds.js');

function isCodexCliKind(kind) {
  return kind === 'codex' || kind === 'codex-resume' || kind === 'codex-web' || kind === 'codex-web-resume';
}

function isCodexBaseKind(kind) {
  return isCodexCliKind(kind);
}
const { readLastAssistantMessage } = require('./core/read-last-assistant.js');
const { parseClaudeTranscriptToTurns } = require('./core/claude-transcript-parser.js');
const {
  DEFAULT_CODEX_SESSIONS_ROOT,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
} = require('./core/codex-transcript-parser.js');

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

// Find the project directory holding a given CC session's JSONL by globbing
// ~/.claude/projects/<slug>/<ccSessionId>.jsonl across all project slugs.
// Returns the full path, or null if not found.
function findTranscriptByCCSessionId(ccSessionId) {
  if (!ccSessionId) return null;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  // 枚举所有 CLAUDE_FAMILY 隔离配置目录（与 core/ai-kinds.js CLAUDE_FAMILY 对齐）：
  //   claude/claude-resume → ~/.claude
  //   deepseek → ~/.claude-deepseek
  //   glm → ~/.claude-glm
  //   gpt/kimi/qwen → ~/.claude-packy-{gpt,kimi,qwen}
  // 缺一个目录会让对应家族的 transcript 全找不到（spec 2 卡片视图空白）。
  const candidateRoots = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.claude-deepseek', 'projects'),
    path.join(home, '.claude-glm', 'projects'),
    path.join(home, '.claude-packy-gpt', 'projects'),
    path.join(home, '.claude-packy-kimi', 'projects'),
    path.join(home, '.claude-packy-qwen', 'projects'),
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
      console.log(`[群聊] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
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

const _autoTitleInFlight = new Set();
const _autoMeetingTitleInFlight = new Set();
const AUTO_TITLE_BASE_KINDS = new Set([...ALL_AI_KINDS, 'claude-web', 'codex-web']);
const AUTO_TITLE_LABELS = Object.values(KIND_LABELS)
  .map(label => String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');
const AUTO_TITLE_SESSION_RE = new RegExp(`^(?:${AUTO_TITLE_LABELS})(?: Resume)? \\d+$`, 'i');
const AUTO_TITLE_MEETING_RE = /^(?:通用|投研|开发|AI 群聊) #\d+$/;

function fallbackSessionTitleFromPrompt(text, kind) {
  const clean = String(text || '')
    .replace(/[#*_`>\[\](){}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const baseKind = String(kind || '').replace(/-resume$/, '');
  const prefix = KIND_LABELS[baseKind] || '会话';
  if (!clean) return '';
  return `${prefix} · ${clean.slice(0, 18)}`;
}

function fallbackMeetingTitleFromPrompt(text, meeting) {
  const clean = String(text || '')
    .replace(/[#*_`>\[\](){}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return `群聊 · ${clean.slice(0, 18)}`;
}

function postJsonForAutoTitle(endpoint, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeoutMs,
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => req.destroy(new Error(`auto-title timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateSessionTitleFromPrompt(text, scope = 'session') {
  const cfg = getHubConfig();
  const prompt = String(text || '').trim().slice(0, 1200);
  if (!prompt) return '';
  if (!cfg.deepseekApiKey) return '';
  const system = scope === 'meeting'
    ? '你是房间命名器。根据用户在 AI 群聊中的第一句话生成中文短标题，8到16个汉字或等长短语，不要引号，不要解释。'
    : '你是会话命名器。根据用户第一句话生成中文短标题，8到16个汉字或等长短语，不要引号，不要解释。';
  const { status, body } = await postJsonForAutoTitle('https://api.deepseek.com/chat/completions', {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 40,
  }, { authorization: `Bearer ${cfg.deepseekApiKey}` }, 8000);
  if (status !== 200) throw new Error(`DeepSeek HTTP ${status}`);
  const parsed = JSON.parse(body);
  const raw = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  return String(raw || '').replace(/["'“”‘’\r\n]/g, '').trim().slice(0, 30);
}

function isAutoTitleSessionKind(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  return AUTO_TITLE_BASE_KINDS.has(base);
}

function isGenericAutoSessionTitle(title) {
  return !title || AUTO_TITLE_SESSION_RE.test(String(title).trim());
}

function isGenericAutoMeetingTitle(title) {
  return !title || AUTO_TITLE_MEETING_RE.test(String(title).trim());
}

function maybeAutoTitleSessionFromPrompt(ev) {
  const { hubSessionId, text } = ev || {};
  if (!hubSessionId || !text || _autoTitleInFlight.has(hubSessionId)) return;
  const session = sessionManager.getSession(hubSessionId);
  if (!session || session.meetingId || session.userRenamed) return;
  if (!isAutoTitleSessionKind(session.kind)) return;
  if (session.autoTitleGenerated) return;
  if (!isGenericAutoSessionTitle(session.title)) return;
  _autoTitleInFlight.add(hubSessionId);
  setTimeout(async () => {
    try {
      const latest = sessionManager.getSession(hubSessionId);
      if (!latest || latest.userRenamed || latest.autoTitleGenerated || latest.meetingId) return;
      if (!isAutoTitleSessionKind(latest.kind) || !isGenericAutoSessionTitle(latest.title)) return;
      let title = '';
      try { title = await generateSessionTitleFromPrompt(text); } catch (e) {
        console.warn('[auto-title] AI title failed:', e && e.message);
      }
      if (!title) title = fallbackSessionTitleFromPrompt(text, (latest.kind || '').replace(/-resume$/, ''));
      if (!title) return;
      const updated = sessionManager.updateSessionMeta(hubSessionId, {
        title,
        autoTitleGenerated: true,
      });
      if (updated) sendToRenderer('session-updated', { session: updated });
    } finally {
      _autoTitleInFlight.delete(hubSessionId);
    }
  }, 0);
}

function maybeAutoTitleMeetingFromPrompt(meetingId, text) {
  if (!meetingId || !text || _autoMeetingTitleInFlight.has(meetingId)) return;
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting || meeting.userRenamed || meeting.autoTitleGenerated) return;
  if (!meeting.autoTitlePending && !isGenericAutoMeetingTitle(meeting.title)) return;
  _autoMeetingTitleInFlight.add(meetingId);
  setTimeout(async () => {
    try {
      const latest = meetingManager.getMeeting(meetingId);
      if (!latest || latest.userRenamed || latest.autoTitleGenerated) return;
      if (!latest.autoTitlePending && !isGenericAutoMeetingTitle(latest.title)) return;
      let title = '';
      try { title = await generateSessionTitleFromPrompt(text, 'meeting'); } catch (e) {
        console.warn('[auto-title] meeting AI title failed:', e && e.message);
      }
      if (!title) title = fallbackMeetingTitleFromPrompt(text, latest);
      if (!title) return;
      const updated = meetingManager.updateMeeting(meetingId, {
        title,
        autoTitleGenerated: true,
        autoTitlePending: false,
      });
      if (updated) sendToRenderer('meeting-updated', { meeting: updated });
    } finally {
      _autoMeetingTitleInFlight.delete(meetingId);
    }
  }, 0);
}

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

sessionManager.onData = (sessionId, data) => {
  sendToRenderer('terminal-data', { sessionId, data });
};

sessionManager.onSessionClosed = (sessionId, meetingId, exitInfo) => {
  // Stage 2 P1-1：把 PTY 退出作为 L2 完成信号通知群聊 watcher。
  //   如果该 sid 当前正在 turn 等待中（_activeWatchers 命中），调 markProcessExit
  //   让 watcher 立即 settle（completed if exit=0 else errored），不再被任何
  //   "永远不来"的 L1 信号或 30min 过渡 timeout 拖住。
  const watcher = _activeWatchers.get(sessionId);
  if (watcher) {
    // node-pty 的 exitInfo 是 { exitCode, signal }，watcher 接受 { code, signal }——做名称适配
    const adapted = exitInfo
      ? { code: typeof exitInfo.exitCode === 'number' ? exitInfo.exitCode : null, signal: exitInfo.signal }
      : { code: null };
    console.log(`[group-chat] PTY exit detected for sid=${sessionId.slice(0, 8)} (code=${adapted.code} signal=${adapted.signal || 'none'}), notifying watcher`);
    try { watcher.markProcessExit(adapted); } catch (e) {
      console.warn('[group-chat] markProcessExit threw:', e.message);
    }
  }

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

// meeting-create-modal（2026-05-01）：把 add-meeting-sub IPC 的核心逻辑抽出来，
//   create-meeting 内部循环也复用，避免重复 sceneObj/promptFile 计算。
async function _addMeetingSubInternal(meetingId, kind, opts = {}) {
  const meeting = meetingManager.getMeeting(meetingId);
  let sessionOpts = { ...(opts || {}), meetingId };
  // opts.model 透传给 sessionManager（让 Claude/Codex/DeepSeek/GLM/Gemini 用对应 model）
  if (opts && opts.model) sessionOpts.model = opts.model;

  // 群聊 slot 化（2026-05-03 道雪 / 2026-05-17 修复）：每个 sub 按加入顺序分配 slot id
  //   (pikachu/charmander/squirtle)。slot 仅识别前 3 个 sub；第 4+ sub 视为额外，slotId=null。
  //   2026-05-17 修复：原代码 `if (meeting.groupChat)` 分支不赋 slotId，删圆桌后所有 meeting
  //   ?? groupChat?????? slotId ????? per-slot ???
  //   现在 slotId 计算与 title 命名解耦——slotId 总按 subCount 计算；title 命名按 groupChat 区分。
  let slotId = null;
  if (meeting) {
    const currentSubCount = (meeting.subSessions || []).length;
    if (currentSubCount < SLOT_IDS.length) {
      slotId = SLOT_IDS[currentSubCount];
    }
    if (!sessionOpts.title) {
      if (meeting.groupChat) {
        const label = KIND_LABELS[kind] || kind || 'AI';
        sessionOpts.title = `${label} ${currentSubCount + 1}`;
      } else if (slotId) {
        sessionOpts.title = getSlotPromptName(slotId); // "皮卡丘" / "小火龙" / "杰尼龟"
      }
    }
  }

  // 阶段乙（2026-05-03 道雪）：隔离 hub 模式下，sub session cwd 走
  //   <HUB_DATA_DIR>/workspaces/<meetingId>/。
  // 2026-05-12：生产 hub 也走独立 workspace（~/.arena/groupchat/<id>/ 或
  //   group-chat scoped workspace），加载 ~/.arena/CLAUDE.md 作项目地图，
  //   避免 sub-session cwd 落在 USERPROFILE 上（沙箱化 + 文件隔离）。
  //   不覆盖调用方显式传入的 opts.cwd（保留 add-meeting-sub 自定义入口）。
  if (!sessionOpts.cwd) {
    let workspaceDir = null;
    if (isIsolatedHub()) {
      workspaceDir = getMeetingWorkspaceDir(meetingId);
    } else if (meeting) {
      const homeDir = process.env.USERPROFILE || process.env.HOME || '.';
      const bucket = 'groupchat';
      workspaceDir = path.join(homeDir, '.arena', bucket, meetingId);
    }
    if (workspaceDir) {
      try {
        fs.mkdirSync(workspaceDir, { recursive: true });
        sessionOpts.cwd = workspaceDir;
      } catch (e) {
        console.warn(`[meeting-sub] workspace mkdir failed for ${meetingId}: ${e.message}; sub will use default cwd`);
      }
    }
  }


  // 群聊保持极简 prompt，但 research 场景仍需要挂载 stock MCP 工具。
  // 注意：上面的历史分支被 if(false) 关闭，避免恢复 BASE_RULES/COVENANT 大 prompt；
  // 这里只注入 MCP，不写 appendSystemPromptFile / codexInstructionFile。
  if (meeting && meeting.groupChat && meeting.scene === 'research' && hookPort) {
    const hubDataDir = getHubDataDir();
    if (isClaudeFamily(kind)) {
      sessionOpts.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, meetingId, hookPort, HOOK_TOKEN, kind);
    } else if (kind === 'gemini') {
      sessionOpts.extraEnv = {
        ...(sessionOpts.extraEnv || {}),
        ELECTRON_RUN_AS_NODE: '1',
        ARENA_MEETING_ID: meetingId,
        ARENA_HUB_PORT: String(hookPort),
        ARENA_HOOK_TOKEN: HOOK_TOKEN,
        ARENA_AI_KIND: 'gemini',
      };
    } else if (isCodexBaseKind(kind)) {
      sessionOpts.codexBypassApprovals = true;
      sessionOpts.codexMcpEntries = [scenes.buildResearchMcpEntryForCodex(meetingId, hookPort, HOOK_TOKEN)];
    }
  } else if (meeting && meeting.groupChat && meeting.scene === 'research' && !hookPort) {
    console.warn('[群聊] research scene in meeting ' + meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
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
}

ipcMain.handle('create-meeting', async (_e, opts) => {
  // opts: { mode?, scene?, slots?: [{index, kind, model}, ...], title? }
  //   meeting-create-modal（2026-05-01）：当 slots 数组传入时，立即按 slot 顺序
  //   逐个 _addMeetingSubInternal(kind, model)，并把 slotSpecs 落盘。renderer 旧路径
  //   不传 slots → 仍只 createMeeting，由 renderer 后续逐个 add-meeting-sub（向后兼容）。
  //   2026-05-05 道雪：title 由 modal 房名输入框填入，非空覆盖默认编号 title；
  //   留空/未传则 createMeeting 内部走 `通用 #N` 等默认编号路径。
  const safe = { ...(opts || {}) };
  safe.groupChat = true;
  const hasCustomTitle = typeof safe.title === 'string' && safe.title.trim().length > 0;
  safe.autoTitlePending = !hasCustomTitle;
  safe.userRenamed = hasCustomTitle;
  if (Array.isArray(safe.slots) && safe.slots.length > 0) {
    safe.slotSpecs = safe.slots.map(s => ({
      index: typeof s.index === 'number' ? s.index : null,
      kind: s.kind, model: s.model || null,
    }));
    if (safe.groupChat && !Array.isArray(safe.participants)) {
      safe.participants = safe.slots.map((_, i) => i);
    }
  }
  const meeting = meetingManager.createMeeting(safe);

  if (Array.isArray(safe.slots) && safe.slots.length > 0) {
    // 不抢先 sendToRenderer('meeting-created')—— 那样 renderer 先看到空 subSessions 列表，
    // 之后每个 add-sub 触发 'meeting-updated' 才补 sub，会造成 0→1→2→3 的视觉抖动。
    // 改成 add-sub 完成后再发 'meeting-created' 一次性带齐 subSessions（modal 走这条路径）。
    //
    // E1 silent failure 修复 (2026-05-03)：
    //   旧代码 add-sub 失败仅 console.warn 吞掉，全失败时仍返回非空 meeting，
    //   renderer selectMeeting() 进入空房间——用户感知"按钮不响应预期"的根因。
    //   修复：收集 errors。全失败→closeMeeting + throw（让 IPC 在 renderer 端 reject）；
    //         部分失败→额外发 meeting-created-with-errors 事件让 UI 显示警告。
    const errors = [];
    for (const slot of safe.slots) {
      try {
        await _addMeetingSubInternal(meeting.id, slot.kind, { model: slot.model });
      } catch (e) {
        errors.push({ slot, message: e && e.message || String(e) });
        console.warn('[create-meeting] add-sub failed for slot', slot, e && e.message);
      }
    }
    const finalMeeting = meetingManager.getMeeting(meeting.id);
    const subCount = finalMeeting ? (finalMeeting.subSessions || []).length : 0;
    if (subCount === 0) {
      // 全失败：清理空 meeting + 抛错给 renderer
      try { meetingManager.closeMeeting(meeting.id); } catch (e) { console.warn('[create-meeting] close empty meeting failed:', e.message); }
    try { groupchat.cleanup?.(getHubDataDir(), meeting.id); } catch {}
      const detail = errors.map(er => `· ${er.slot.kind}（${er.slot.model || 'default'}）：${er.message}`).join('\n');
      throw new Error('所有子会话创建失败：\n' + (detail || '（未知原因）'));
    }
    meetingManager.setSlotSpecs(meeting.id, safe.slotSpecs);
    if (errors.length > 0) {
      // 部分失败：UI 显示警告条
      sendToRenderer('meeting-created-with-errors', { meeting: finalMeeting, errors });
    }
    sendToRenderer('meeting-created', { meeting: finalMeeting });
  } else {
    // 老路径（renderer 后续会自己 add-meeting-sub）保持先发的语义不变
    sendToRenderer('meeting-created', { meeting });
  }

  // 返回最终 meeting（含 subSessions + slotSpecs）
  return meetingManager.getMeeting(meeting.id) || meeting;
});

ipcMain.handle('add-meeting-sub', async (_e, args = {}) => {
  // 兼容老 payload { meetingId, kind, opts } + 新 payload { meetingId, kind, model, opts }
  const { meetingId, kind, model } = args;
  const opts = args.opts || {};
  if (model && !opts.model) opts.model = model;
  return _addMeetingSubInternal(meetingId, kind, opts);
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
    // 2026-05-07：关掉的子会话立刻 removed，避免下一轮 persist-sessions diff 没赶上时
    //   state.json 还残留 dormant 条目。
    stateStore.markRemovedSession(sid);
    sessionStore.deleteSessionFile(sid);
    sessionStore.cancelDirty(sid);
  }
  groupchat.cleanup?.(getHubDataDir(), meetingId);
  // 2026-05-07：会议在 state.json 里也要标记 removed
  stateStore.markRemovedMeeting(meetingId);
  // immersive 状态从 dict 一并清掉（避免 state.json 越长越大）
  delete _immersiveByMeeting[meetingId];
  sendToRenderer('meeting-closed', { meetingId });
  return true;
});

// Arch refactor 2026-05-02: 沉浸/调试模式切换已删除。群聊只有一种视图。
// 这两个 handler 保留为 no-op：避免老 state.json (含 immersiveByMeeting 字段)
// 在 renderer 调 get-immersive-mode 时报 'No handler registered'。新 renderer
// 永远不调这两个 IPC，但保留 handler 兼容老前端代码（已嵌进 dist 的版本）。
ipcMain.handle('get-immersive-mode', () => {
  return { immersive: false };
});

ipcMain.handle('save-immersive-mode', () => {
  return { ok: true };
});

// free-mode（2026-05-04）— 切换 meeting.mode 'pilot' ⇄ 'free'
//   inProgress=true 时拒绝（Q9=A：避免半轮发言后改语义）
//   切到 free 模式时若 meeting.participants===null，首次初始化为 [0,1,2]
ipcMain.handle('groupchat:set-participants', async (_e, { meetingId, participants } = {}) => {
  if (!meetingId) throw new Error('Missing meetingId');
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
  if (!meeting.groupChat) throw new Error('Meeting is not a group chat');
  if (!Array.isArray(participants)) throw new Error(`participants must be array, got ${typeof participants}`);
  const max = Array.isArray(meeting.subSessions) ? meeting.subSessions.length : 0;
  const seen = new Set();
  for (const x of participants) {
    if (!Number.isInteger(x) || x < 0 || x >= max) {
      throw new Error(`Invalid group participant index: ${JSON.stringify(x)}`);
    }
    seen.add(x);
  }
  const validated = [...seen].sort((a, b) => a - b);

  // FIX(T4 HIGH): 用 setter 写回 Map 原始对象（getMeeting 返回浅拷贝，赋值不写回）
  meetingManager.setParticipants(meetingId, validated);

  let persistWarning = null;
  try {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
      immersiveByMeeting: _immersiveByMeeting,
    });
  } catch (e) {
    console.warn('[groupchat] set-participants persist failed:', e.message);
    persistWarning = `state.json 持久化失败：${e.message}（meeting 已存到 per-meeting JSON，重启后仍生效）`;
  }

  sendToRenderer('meeting-updated', { meeting: meetingManager.getMeeting(meetingId) });
  return persistWarning ? { ok: true, persistWarning } : { ok: true };
});

// =====================================================================
// Group Chat Mode (Sprint 2): fanout / debate / summary 三种轮次
// =====================================================================
const groupchat = require('./core/group-chat-orchestrator.js');
const groupChatWatcher = require('./core/group-chat-watcher.js');
groupChatWatcher.init({ sessionManager, cliReadyDetector, transcriptTap });
let _groupChatInProgress = new Set(); // 同一群聊单一并发：set of meetingId

// Resend & Auto-Recovery（2026-05-03）—— per-sid patch-listener 注册表
//   防跨轮污染：dispatchGroupChatTurn 入口先 cancelPatchListenersForSid(sid)
//   保证一个 sub 永远只有最新一轮的 patch listener 在监听。watcher.cancelPatch()
//   把 patchCancelled=true 后续 settle 不再挂新 listener；已挂的 patch listener
//   通过 watcher 内部的 _cleanupPatch 自然清理。
const _patchListenersBySid = new Map(); // sid → Set<watcher>

function registerPatchListener(sid, watcher) {
  if (!_patchListenersBySid.has(sid)) _patchListenersBySid.set(sid, new Set());
  _patchListenersBySid.get(sid).add(watcher);
}
function cancelPatchListenersForSid(sid) {
  const set = _patchListenersBySid.get(sid);
  if (!set) return;
  for (const w of set) {
    try { w.cancelPatch?.(); } catch (e) { console.warn('[patch] cancelPatch threw:', e && e.message); }
  }
  set.clear();
}
function unregisterPatchListener(sid, watcher) {
  const set = _patchListenersBySid.get(sid);
  if (set) set.delete(watcher);
}

// 方案 F · 2026-05-02：计算单个 sub 视角的"调度上下文" spec，喂给 build*Prompt
// / checkHostShellTakeover）已抽到 core/group-chat-watcher.js（groupChatWatcher）。
// 调用方走 groupChatWatcher.X。dispatchGroupChatTurn 与 _gcWaitTurnComplete 仍在 main.js
// 这里（依赖闭包过深，留下次专项 → core/group-chat-dispatcher.js）。




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
const pasteTrappedDetector = require('./core/paste-trapped-detector.js');

// paste-trapped 监控注册表（2026-05-05 道雪 P0 2A）：dispatch sendToPty 看似 ok 但
//   marker 卡输入框时主动确诊。Codex 先自动补 Enter（只补 \r，不重发 prompt），
//   仍卡住再推 send-stuck IPC。
//   key = sid，value = setInterval id。watcher settle / sendToPty stuck / hard timeout
//   任一触发都要清。
const _pasteTrappedMonitors = new Map();
const PASTE_TRAPPED_TICK_MS = 3000;
const PASTE_TRAPPED_HARD_TIMEOUT_MS = 60_000;
const PASTE_TRAPPED_CODEX_ENTER_RETRIES = 2;

function _startPasteTrappedMonitor(sid, kind, meetingId) {
  if (_pasteTrappedMonitors.has(sid)) return;
  pasteTrappedDetector.start(sid, Date.now());
  const startedAt = Date.now();
  const monitor = { intervalId: null, enterRetries: 0 };
  const intervalId = setInterval(() => {
    try {
      if (Date.now() - startedAt >= PASTE_TRAPPED_HARD_TIMEOUT_MS) {
        _stopPasteTrappedMonitor(sid);
        return;
      }
      const buf = sessionManager.getSessionBuffer(sid) || '';
      const activity = sessionManager.getGroupChatLastActivity(sid);
      const r = pasteTrappedDetector.tick(sid, buf, activity);
      if (r === 'stuck') {
        if (isCodexBaseKind(kind) && monitor.enterRetries < PASTE_TRAPPED_CODEX_ENTER_RETRIES) {
          monitor.enterRetries += 1;
          console.warn(`[paste-trapped] codex(${sid.slice(0,8)}) paste marker stable; sending retry Enter #${monitor.enterRetries}`);
          try {
            sessionManager.writeToSession(sid, '\r');
            const meeting = meetingManager.getMeeting(meetingId);
            if (meeting && meeting.groupChat) {
              const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
              const turnNum = orch && orch.state && orch.state.currentTurn;
              if (turnNum) orch.setSendStatus(turnNum, sid, 'enter_retry');
            }
          } catch (e) {
            console.warn('[paste-trapped] codex retry Enter threw:', e && e.message);
          }
          // 重新开始 3s 时间门 + marker 稳定观察，避免连续补 Enter 抢在 TUI 重绘前。
          pasteTrappedDetector.start(sid, Date.now());
          return;
        }
        console.warn(`[paste-trapped] confirmed stuck for ${kind}(${sid.slice(0,8)}) — pushing groupchat-send-stuck IPC`);
        try {
          const meeting = meetingManager.getMeeting(meetingId);
          if (meeting && meeting.groupChat) {
            const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
            const turnNum = orch && orch.state && orch.state.currentTurn;
            if (turnNum) orch.setSendStatus(turnNum, sid, 'stuck');
          }
        } catch (e) { console.warn('[paste-trapped] setSendStatus threw:', e && e.message); }
        sendToRenderer('groupchat-send-stuck', { meetingId, sid, kind });
        _stopPasteTrappedMonitor(sid);
      } else if (r === 'ok') {
        // marker 消失 = paste 已被 \r 提交（或 streaming 内容覆盖输入框区域），停 monitor
        _stopPasteTrappedMonitor(sid);
      }
      // 'unknown' → 继续 tick
    } catch (e) {
      console.warn('[paste-trapped] tick threw:', e && e.message);
    }
  }, PASTE_TRAPPED_TICK_MS);
  intervalId.unref?.();
  monitor.intervalId = intervalId;
  _pasteTrappedMonitors.set(sid, monitor);
}

function _stopPasteTrappedMonitor(sid) {
  const entry = _pasteTrappedMonitors.get(sid);
  const intervalId = entry && typeof entry === 'object' ? entry.intervalId : entry;
  if (intervalId) {
    clearInterval(intervalId);
    _pasteTrappedMonitors.delete(sid);
  }
  try { pasteTrappedDetector.stop(sid); } catch {}
}

// FIX-D（2026-05-01）：宿主 shell prompt 心跳检测——CLI 自我退出（Codex 自动更新 / Gemini OAuth
//   异常 / Claude 内部 panic 等）后 PTY 控制权回到宿主 shell（PowerShell / bash），但 PTY 进程
//   本身没退，markProcessExit 不会触发。watcher 因此只能等 5min 硬 timeout。
//   解决：每 10s 检查 PTY ring buffer 末尾是否回到宿主 shell prompt，连续 2 次命中视为 CLI 已死，
//   立即 markProcessExit({ code: -1, signal: 'cli_self_exit' }) 让 watcher 切 errored。
//   核心检测函数抽到 core/host-shell-detector.js 方便单测。
const _HOST_SHELL_HEARTBEAT_MS = 10 * 1000;
const _HOST_SHELL_CONSECUTIVE_HITS = 2;
const _CODEX_AUTO_EXTRACT_DELAY_MS = 3 * 1000;
const _CODEX_AUTO_EXTRACT_INTERVAL_MS = 2 * 1000;

function _gcWaitTurnComplete(sid, label, opts = {}) {
  const { meetingId, mode, turnNum, onPartial } = opts;
  const disableHardTimeout = opts.disableHardTimeout === true;

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
        sendToRenderer('groupchat-soft-alert', {
          meetingId, turnNum, mode, sid, label, level,
        });
      } catch {}
    },
    // Resend & Auto-Recovery（2026-05-03）— onTurnPatched：watcher settle 后 5min 内
    //   transcriptTap 再 emit turn-complete（且文本更长）则 patch lastTurn。
    //   防护 #2：不覆盖 manual_extracted（用户手动提取的内容是权威，patch 不许覆盖）。
    //   闭包用 meetingId（来自 opts）→ 通过 meetingManager + scenes 拿 sceneObj → orch。
    //   turnNum 也从 opts 闭包读取。
    onTurnPatched: ({ sid: patchedSid, text, status }) => {
      try {
        const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
        const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
        // 防护 #2：不覆盖 manual_extracted 状态（spec 要求）
        const turn = orch.state.turns.find(t => t.n === turnNum);
        const currentStatus = turn?.byStatus?.[patchedSid];
        const finalStatus = (currentStatus === 'manual_extracted') ? 'manual_extracted' : status;
        orch.patchTurnResult(turnNum, patchedSid, { text, status: finalStatus });
        sendToRenderer('groupchat-turn-patched', {
          meetingId, turnNum, sid: patchedSid, charCount: (text || '').length,
        });
      } catch (e) {
        console.warn('[patch] onTurnPatched threw:', e && e.message);
      }
    },
  });
  _activeWatchers.set(sid, watcher);
  // Resend & Auto-Recovery（2026-05-03）— 注册到全局 patch-listener 表
  //   下一轮 dispatch 同 sid 时通过 cancelPatchListenersForSid 强制 cancel 老 patch listener
  registerPatchListener(sid, watcher);

  // streaming partial 流式推送（保留现有体验，每 1500ms 推一次终端实时文本）
  // Card optimization Task 5+6（2026-05-01）：onPartial 现在收到 { sid, label, status, blocks, source, text }
  //   — blocks 让 renderer 结构化渲染（thinking/tool_use 高亮）；text 是兼容字段。
  // fix（2026-05-01 多方审查反馈）：tap 没数据时 result.blocks 为空 + source='placeholder'，
  //   仍然推一次 partial 让 renderer 切到 streaming 状态显示"💭 思考中…"占位（避免卡片
  //   一直停在 idle / initializing）。同时 watcher 自身已发 status 信号，partial 是补充。
  let streamTimer = null;
  if (typeof onPartial === 'function') {
    streamTimer = setInterval(() => {
      if (watcher.isSettled()) { clearInterval(streamTimer); streamTimer = null; return; }
      const session = sessionManager.getSession(sid);
      const kind = session?.kind || 'unknown';
      const result = groupChatWatcher.extractStreamingText(sid, kind);
      const hasContent = result.text.length > 10 || result.blocks.length > 0;
      // B1（2026-05-03 道雪）：每次心跳都计算 cleanBufLen 让 renderer 显示"已输出约 N 字"
      //   placeholder 路径改为每次都推（原 placeholderEmitted=true 后只推一次）。
      //   代价：60s 群聊每家多 ~40 次 IPC（~120 次/3 sub），远小于真 streaming 的事件量。
      const buf = sessionManager.getSessionBuffer(sid) || '';
      const cleanBufLen = groupChatWatcher.cleanBufLen(buf);
      if (hasContent) {
        try {
          onPartial({
            sid, label, status: 'streaming',
            blocks: result.blocks, source: result.source, text: result.text,
            cleanBufLen,
          });
        } catch {}
      } else {
        try {
          onPartial({
            sid, label, status: 'streaming',
            blocks: [], source: 'placeholder', text: '',
            cleanBufLen,
          });
        } catch {}
      }
    }, 1500);
  }

  // 过渡期硬 timeout（FIX-B 已 30min→5min）。
  // AI 群聊允许长时间自由发言，不能因为固定 5min 把已在 shell 输出中的慢回答落成空气泡。
  let hardTimeout = null;
  if (!disableHardTimeout) {
    hardTimeout = setTimeout(() => {
      if (watcher.isSettled()) return;
      console.warn(`[group-chat] transitional hard timeout (5min) hit for ${label}(${sid.slice(0, 8)}), forcing skip`);
      watcher.skip();
    }, RT_TRANSITIONAL_HARD_TIMEOUT_MS);
    hardTimeout.unref?.();
  }

  // FIX-D（2026-05-01）：宿主 shell prompt 心跳检测，10-15s 内识别 CLI 自我退出
  let hostShellHits = 0;
  const hostShellHeartbeat = setInterval(() => {
    if (watcher.isSettled()) { clearInterval(hostShellHeartbeat); return; }
    if (groupChatWatcher.checkHostShellTakeover(sid)) {
      hostShellHits += 1;
      if (hostShellHits >= _HOST_SHELL_CONSECUTIVE_HITS) {
        console.warn(`[group-chat] host shell prompt detected for ${label}(${sid.slice(0, 8)}) on hit #${hostShellHits} — CLI self-exited, marking errored`);
        try { watcher.markProcessExit({ code: -1, signal: 'cli_self_exit' }); }
        catch (e) { console.warn('[group-chat] markProcessExit (heartbeat) threw:', e.message); }
      }
    } else {
      hostShellHits = 0;
    }
  }, _HOST_SHELL_HEARTBEAT_MS);
  hostShellHeartbeat.unref?.();

  let codexAutoExtractTimer = null;
  const waitSession = sessionManager.getSession(sid);
  if (isCodexBaseKind(waitSession?.kind)) {
    const sincePromptTs = Math.max(0, _startTs - 1000);
    let autoExtractBusy = false;
    codexAutoExtractTimer = setInterval(async () => {
      if (watcher.isSettled()) {
        clearInterval(codexAutoExtractTimer);
        codexAutoExtractTimer = null;
        return;
      }
      if (Date.now() - _startTs < _CODEX_AUTO_EXTRACT_DELAY_MS) return;
      if (autoExtractBusy) return;
      autoExtractBusy = true;
      try {
        const extracted = await transcriptTap.extractLatestTurn(sid, sincePromptTs);
        if (extracted?.extractMode === 'final_answer' && extracted.text) {
          console.log(`[group-chat] codex auto-extract final_answer for ${label}(${sid.slice(0, 8)}) ${extracted.text.length} chars`);
          watcher.completeFromTranscript(extracted.text, 'codex_auto_extract_final_answer');
        }
      } catch (e) {
        console.warn('[group-chat] codex auto-extract failed:', e && e.message);
      } finally {
        autoExtractBusy = false;
      }
    }, _CODEX_AUTO_EXTRACT_INTERVAL_MS);
    codexAutoExtractTimer.unref?.();
  }

  return watcher.wait().then(result => {
    if (hardTimeout) clearTimeout(hardTimeout);
    clearInterval(hostShellHeartbeat);
    if (codexAutoExtractTimer) clearInterval(codexAutoExtractTimer);
    if (streamTimer) clearInterval(streamTimer);
    _activeWatchers.delete(sid);
    // 2026-05-05 P0 2A：watcher settle = turn 收尾，paste-trapped 监控不再需要
    _stopPasteTrappedMonitor(sid);
    // 305s 后清理 _patchListenersBySid 中的 watcher 引用（与 watcher 内部 patch 窗口 300s 对齐 + 5s 余量）。
    //   防 watcher settle 后 ref 永远留在 main.js 全局表（dead ref 累积内存压力）。
    //   不能立即 unregister——cancelPatchListenersForSid 需要在新一轮 dispatch 时
    //   还能找到老 watcher 取消其 patch listener。305s 后 watcher 自己已 cleanup，
    //   ref 留着也无意义，此时 unregister 干净。
    setTimeout(() => {
      try { unregisterPatchListener(sid, watcher); }
      catch (e) { console.warn('[patch] unregisterPatchListener throw:', e && e.message); }
    }, 305_000).unref?.();

    // Card redesign（2026-05-01）：注入本轮统计字段供 orchestrator 累加 + 卡片渲染。
    //   thinkSec 精度 0.1s（Math.round((..)*10)/10）；tokens 仅 Gemini 有，其他家 null。
    const elapsedMs = Date.now() - _startTs;
    result.thinkSec = Math.round(elapsedMs / 100) / 10;
    try { result.tokens = transcriptTap.getLastTokens(sid) || null; }
    catch { result.tokens = null; }

    if (typeof onPartial === 'function') {
      try { onPartial(result); } catch (e) { console.warn('[group-chat] onPartial error:', e.message); }
    }
    return result;
  });
}

// 主调度：mode = 'fanout' | 'debate'
// userInput: 用户输入（fanout 是问题，debate 是补充）
// 摘要功能 2026-05-08 整体下线：原 mode='summary' / @summary 命令路径已删
function _groupMembersForMeeting(meeting) {
  const subSids = Array.isArray(meeting && meeting.subSessions) ? meeting.subSessions : [];
  const specs = Array.isArray(meeting && meeting.slotSpecs) ? meeting.slotSpecs : [];
  const kindCounts = {};
  for (const sid of subSids) {
    const s = sessionManager.getSession(sid);
    if (!s) continue;
    kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
  }
  const seenKind = {};
  return subSids.map((sid, idx) => {
    const s = sessionManager.getSession(sid);
    if (!s || s.status === 'dormant') return null;
    const spec = specs[idx] || {};
    const kind = s.kind || spec.kind || 'ai';
    seenKind[kind] = (seenKind[kind] || 0) + 1;
    const kindLabel = KIND_LABELS[kind] || kind || 'AI';
    const dupSuffix = kindCounts[kind] > 1 ? String(seenKind[kind]) : '';
    const displayName = s.title || `${kindLabel}${dupSuffix ? ' ' + dupSuffix : ''}`;
    const memberId = `m${idx + 1}`;
    const model = (s.currentModel && s.currentModel.id) || spec.model || null;
    const aliases = [
      memberId,
      displayName,
      kindLabel,
      kind,
      `${kindLabel}${seenKind[kind]}`,
      `${kind}${seenKind[kind]}`,
    ].filter(Boolean);
    return {
      sid,
      index: idx,
      memberId,
      kind,
      model,
      displayName,
      aliases: [...new Set(aliases.map(x => String(x)))],
    };
  }).filter(Boolean);
}

function _parseGroupTargets(userInput, members, participants) {
  const selected = Array.isArray(participants) ? participants : [];
  const selectedMembers = members.filter(m => selected.includes(m.index));
  const mentionRe = /@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g;
  const mentioned = [];
  let m;
  while ((m = mentionRe.exec(userInput || '')) !== null) {
    const token = String(m[1] || '').toLowerCase();
    if (token === 'all' || token === '全部' || token === '所有人') {
      return { targets: members, mentions: ['all'] };
    }
    const hits = members.filter(mem => {
      const keys = [mem.memberId, mem.displayName, mem.kind, ...(mem.aliases || [])]
        .filter(Boolean).map(x => String(x).toLowerCase());
      return keys.includes(token);
    });
    const hit = hits.length === 1 ? hits[0] : null;
    if (hit && !mentioned.some(x => x.sid === hit.sid)) mentioned.push(hit);
  }
  if (mentioned.length > 0) return { targets: mentioned, mentions: mentioned.map(x => x.memberId) };
  return { targets: selectedMembers, mentions: [] };
}

async function dispatchGroupChatTurn(meetingId, { userInput }) {
  if (_groupChatInProgress.has(meetingId)) return { status: 'busy', turnNum: null };
  _groupChatInProgress.add(meetingId);
  try {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) {
      return { status: 'error', reason: 'not group chat meeting', turnNum: null };
    }
    const members = _groupMembersForMeeting(meeting);
    if (members.length === 0) return { status: 'no_subs', turnNum: null };

    const routed = _parseGroupTargets(userInput || '', members, meeting.participants);
    const targetMembers = routed.targets || [];
    if (targetMembers.length === 0) {
      return { status: 'error', reason: '请先勾选至少一位 AI 成员，或用 @ 指定成员', turnNum: null };
    }
    maybeAutoTitleMeetingFromPrompt(meetingId, userInput || '');

    for (const member of members) {
      try { transcriptTap.clearStreamingBuf(member.sid); } catch {}
    }

    const hubDataDir = getHubDataDir();
    const orch = groupchat.getOrchestrator(hubDataDir, meetingId);
    const { turnNum } = orch.beginTurn(userInput || '');
    const deliveredIdx = orch.state.messages.length - 1;
    const targets = targetMembers.map(member => {
      const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene);
      return {
        sid: member.sid,
        kind: member.kind,
        label: member.displayName,
        member,
        deliveredIdx,
        prompt: orch.buildFirstDelta(member.sid, userInput || '', systemPromptText),
      };
    });

    for (const t of targets) {
      cancelPatchListenersForSid(t.sid);
      try { orch.recordTurnPrompt(turnNum, t.sid, t.prompt); }
      catch (e) { console.warn('[groupchat] recordTurnPrompt threw:', e && e.message); }
    }

    const sentTargets = [];
    await Promise.all(targets.map(async (t) => {
      try {
        try { transcriptTap.notePrompt(t.sid, t.kind, t.prompt); } catch {}
        const sendResult = await groupChatWatcher.sendToPty(t.sid, t.prompt, t.kind);
        const ok = sendResult && sendResult.ok;
        const sendStatus = sendResult && sendResult.sendStatus;
        if (sendStatus === 'stuck' && !isCodexBaseKind(t.kind)) {
          sendToRenderer('groupchat-send-stuck', { meetingId, sid: t.sid, kind: t.kind });
        }
        if (ok) {
          sentTargets.push(t);
          if (sendStatus !== 'stuck' || isCodexBaseKind(t.kind)) {
            _startPasteTrappedMonitor(t.sid, t.kind, meetingId);
          }
        }
      } catch (e) {
        console.warn(`[groupchat] turn ${turnNum} sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
      }
    }));

    if (sentTargets.length === 0) {
      orch.rollbackTurn(turnNum);
      return { status: 'no_sent', turnNum };
    }

    const settled = await Promise.allSettled(sentTargets.map(t =>
      _gcWaitTurnComplete(t.sid, t.label, {
        meetingId, mode: 'group', turnNum,
        disableHardTimeout: true,
        onPartial: (partial) => {
          sendToRenderer('groupchat-partial-update', {
            meetingId, turnNum, mode: 'group',
            sid: partial.sid, label: partial.label,
            status: partial.status,
            text: partial.text,
            blocks: partial.blocks,
            source: partial.source,
            thinkSec: partial.thinkSec, tokens: partial.tokens,
            cleanBufLen: partial.cleanBufLen,
          });
        },
      })
    ));

    const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
      sid: sentTargets[i].sid,
      label: sentTargets[i].label,
      status: 'errored',
      text: '',
      reason: s.reason?.message || 'Promise rejected',
    }).map((r, i) => ({
      ...r,
      deliveredIdx: sentTargets[i] && sentTargets[i].deliveredIdx,
    }));
    const memberBySid = {};
    for (const m of members) memberBySid[m.sid] = m;
    const turnRecord = orch.completeTurn(turnNum, userInput || '', results, memberBySid);
    const meta = turnRecord.meta || { dispatchMode: 'group' };
    sendToRenderer('groupchat-turn-complete', { meetingId, turnNum, mode: 'group', results, meta });
    return { status: 'completed', turnNum, results, meta };
  } finally {
    _groupChatInProgress.delete(meetingId);
  }
}

ipcMain.handle('groupchat:turn', async (_e, args = {}) => {
  try {
    return await dispatchGroupChatTurn(args.meetingId, args);
  } catch (e) {
    console.error('[groupchat:turn] unhandled throw, returning error to renderer:', e);
    return { status: 'error', reason: (e && e.message) || 'internal_error', turnNum: null };
  }
});

// 摘要功能 2026-05-08 整体下线：原 summary-trigger IPC handler 已删

ipcMain.handle('groupchat:get-state', (_e, { meetingId }) => {
  const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
  return orch.getState();
});

ipcMain.handle('groupchat:search-raw', (_e, { meetingId, query, limit } = {}) => {
  const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
  return orch.searchRaw(query, limit);
});

ipcMain.handle('groupchat:read-raw', (_e, { meetingId, messageId } = {}) => {
  const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
  return orch.readRaw(messageId);
});

// ===== Stage 2 容错升级（2026-05-01）— 群聊逃生工具 IPC =====
//
// 这三个 IPC 让 UI 在某家 AI 卡死时绕过完成检测，不再让整个群聊锁 10 分钟。
// 与 turn-completion-watcher 配合使用：watcher.wait() 期间，IPC 可以通过
// _activeWatchers Map 找到对应 watcher 并触发 manualExtract / skip。
//
// 调用前提：必须在某 turn 的 wait() 期间调用（即 watcher 还在 _activeWatchers 中）。
// turn 已结束（watcher 已 settle 并从 Map 移除）后调这些 IPC 返回 not_active。

// 一键提取：从 Gemini JSONL 直接读 sincePromptTs 之后的 content 拼接，
//   绕过完成检测设为该家本轮答案。仅 Gemini 需要（Claude/Codex 都有可靠 L1）。
// 2026-05-02 Bug 修复：手动提取扩展到所有 backend（Claude/DeepSeek/GLM/Codex/Gemini）。
//   旧版本只调 extractLatestGeminiTurn → Claude/DeepSeek/GLM/Codex 永远 null → UI 报"提取失败"
//   → 用户感觉按钮是假的。新版本走 transcriptTap.extractLatestTurn 统一入口按 backend 路由。
//
// 此外移除"必须有 active watcher 才能提取"的硬限制：active watcher 缺失只意味着本轮已 settle，
// 但 transcript 文件中的 last assistant 仍然有意义（用户想拿当前最新答案 patch 进 lastTurn）。
// 有 watcher 走 manualExtract（让本轮 settle 走完整流程）；无 watcher 走 patchTurnResult 直接更新 lastTurn。
ipcMain.handle('groupchat-manual-extract', async (_e, { meetingId, sid, sincePromptTs, turnNum } = {}) => {
  if (!sid) return { ok: false, reason: 'missing_sid' };

  let extracted = null;
  try { extracted = await transcriptTap.extractLatestTurn(sid, sincePromptTs || 0); }
  catch (e) { return { ok: false, reason: 'extract_failed', detail: e.message }; }
  const session = sessionManager.getSession(sid);
  const kind = session?.kind || 'unknown';
  if (!extracted || !extracted.text) {
    try {
      const fromPty = groupChatWatcher.extractStreamingText(sid, kind);
      if (fromPty && fromPty.text && fromPty.text.trim().length > 0) {
        extracted = {
          text: fromPty.text,
          source: fromPty.source || 'pty_buffer',
          extractMode: 'pty_buffer_fallback',
        };
      }
    } catch (e) {
      console.warn('[manual-extract] PTY fallback failed:', e && e.message);
    }
  }
  if (!extracted || !extracted.text) {
    // 2026-05-04 codex equiv (Spec S2 + extract-failure TDD)：detail 按 extractMode 分级。
    //   v2.1 加了 extractMode 透传但 detail 仍写死，用户截图重现仍看到笼统"提取失败"。
    //   现在按 4 态给针对性 hint，让用户知道下一步该做什么（等几秒 / 进 shell / 检查路径）。
    const extractMode = extracted?.extractMode || null;
    let detail;
    if (extractMode === 'no_rollout_bound') {
      detail = `Codex rollout 文件尚未绑定（kind=${kind}）。可能原因：（a）当天目录 ~/.codex/sessions/<今日>/ 还没新文件；（b）codex spawn 时的 cwd 与 rollout session_meta.cwd 不一致；（c）timestamp 超出绑定窗口 [-10s, +5min]。建议：等 5-10s（codex 通常 spawn 后才写 rollout 首行），或点"🔧 进 shell"看真实 PTY 输出确认 codex 是否真的启动了。`;
    } else if (extractMode === 'no_task_complete_yet') {
      detail = `Codex 已绑定 rollout 但 task_complete 事件尚未写入（kind=${kind}）。可能原因：（a）codex 仍在思考；（b）codex 在等 MCP 工具确认弹窗（如 ai-team team_respond），需要进 shell 点"Allow"；（c）codex 多 task 场景含 3s debounce，最后一个 task 完成后才 emit。建议：点"🔧 进 shell"看 codex 当前是否被 confirm 弹窗阻塞。`;
    } else {
      // null（claude/gemini/deepseek/glm 等非 codex backend，无 extractMode）或未知态
      detail = `transcript 中没有可读的 last assistant 内容（kind=${kind}）。可能原因：CLI 还没真正回答 / transcript 路径未绑定 / Stop hook 没触发且 idle-timer 还没到期。建议稍等几秒重试，或点"🔧 进 shell"看真实 PTY 输出。`;
    }
    return {
      ok: false,
      reason: 'no_content',
      extractMode,
      detail,
    };
  }

  const watcher = _activeWatchers.get(sid);
  if (watcher) {
    // 本轮还在等：让 watcher settle 走 manual_extracted 状态
    watcher.manualExtract(extracted.text);
    return { ok: true, text: extracted.text, source: extracted.source, mode: 'watcher_settle', extractMode: extracted.extractMode || null };
  }

  // 本轮已 settle 但用户仍想刷新卡片 → patch lastTurn
  if (meetingId) {
    try {
      const meeting = meetingManager.getMeeting(meetingId);
      if (meeting) {
        const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
        const turns = Array.isArray(orch.state.turns) ? orch.state.turns : [];
        const requestedTurn = Number.isFinite(Number(turnNum)) ? Number(turnNum) : null;
        const lastTurn = requestedTurn
          ? turns.find(t => t && t.n === requestedTurn)
          : turns[turns.length - 1];
        if (lastTurn) {
          const patched = orch.patchTurnResult(lastTurn.n, sid, {
            text: extracted.text,
            status: 'manual_extracted',
          });
          if (patched) {
            sendToRenderer('groupchat-turn-patched', {
              meetingId, turnNum: lastTurn.n, sid, charCount: (extracted.text || '').length,
            });
            return { ok: true, text: extracted.text, source: extracted.source, mode: 'patch_groupchat_turn', extractMode: extracted.extractMode || null };
          }
        }
      }
    } catch (e) {
      console.warn('[manual-extract] patch lastTurn failed:', e.message);
    }
  }

  // 无 meetingId / 没有 lastTurn → 仍返回提取的文字让 UI 显示
  return { ok: true, text: extracted.text, source: extracted.source, mode: 'text_only', extractMode: extracted.extractMode || null };
});

// 2026-05-04 codex equiv extract-failure TDD —— 调试入口暴露 CodexTap 内部状态。
//   触发场景：用户报告"codex 已回答但卡片提取不到"，需要看 _bound / _pending / _seen 状态
//     才能区分"绑定失败"vs"绑定成功但 task_complete 未写"vs"任何 backend 都没该 sid"。
//   返回值：JSON 可序列化的 { sessionsRoot, pending: [], bound: [], seen: [] } 快照。
//   不暴露 timer / tail object / EventEmitter listeners 等内部句柄。
ipcMain.handle('groupchat-codex-debug-state', async () => {
  try {
    return { ok: true, snapshot: transcriptTap.getCodexDebugSnapshot() };
  } catch (e) {
    return { ok: false, reason: 'snapshot_failed', detail: e.message };
  }
});

// 2026-05-04 gemini equiv —— 与 codex 镜像，暴露 GeminiTap 内部状态给 renderer/E2E 用。
//   触发场景：用户报告"gemini 已回答但卡片提取不到"，需要看 _bound / _pending / _seen / projectDir
//     状态来区分"projectDir 没解析到"vs"绑定成功但 turn-complete 未 emit"vs"任何 backend 都没该 sid"。
//   返回 { tmpRoot, pending: [], bound: [], seen: [] }（gemini 单 root，不像 codex 多 sessionsRoots）。
ipcMain.handle('groupchat-gemini-debug-state', async () => {
  try {
    return { ok: true, snapshot: transcriptTap.getGeminiDebugSnapshot() };
  } catch (e) {
    return { ok: false, reason: 'snapshot_failed', detail: e.message };
  }
});

// Resend & Auto-Recovery（2026-05-03）— 手动 [📤 发送] 按钮入口
//   触发场景：dispatch 主路径 sendToPty 返回 sendStatus='stuck'（auto-recover 也救不了），
//     renderer 收到 'groupchat-send-stuck' IPC 后让卡片亮 [📤 发送] 按钮，
//     用户手动点击 → renderer invoke('groupchat-resend-prompt') → 走这里。
//   行为：从 orchestrator._activePrompts 取本轮 prompt + promptHeader →
//     调 groupChatWatcher.resendCurrentPrompt（按 promptHeader 指纹判 enter_only / rewrite_full）。
//   成功后 setSendStatus 'auto_recovered' 让 UI 调试能看到。
ipcMain.handle('groupchat-resend-prompt', async (_e, { meetingId, sid } = {}) => {
  if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
  const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
  const turnNum = orch.state.currentTurn;
  if (!turnNum || orch.state.currentMode === 'idle') {
    return { ok: false, reason: 'no_active_turn' };
  }
  const active = orch.getActivePrompt(turnNum);
  if (!active || !active.promptBy || !active.promptBy[sid]) {
    return { ok: false, reason: 'no_active_prompt' };
  }
  const session = sessionManager.getSession(sid);
  const kind = session ? session.kind : 'unknown';
  try {
    return await groupChatWatcher.resendCurrentPrompt({
      sid,
      kind,
      prompt: active.promptBy[sid],
      promptHeader: '',
      timing: { ENTER_RETRY_GAP_MS: 150, POST_ENTER_VERIFY_MS: 500 },
    });
  } catch (e) {
    console.error('[groupchat-resend-prompt] threw:', e);
    return { ok: false, reason: 'exception', detail: e.message };
  }
});

ipcMain.handle('groupchat-skip-participant', async (_e, { meetingId, sid } = {}) => {
  if (!sid) return { ok: false, reason: 'missing sid' };
  const watcher = _activeWatchers.get(sid);
  if (!watcher) return { ok: false, reason: 'not_active' };
  watcher.skip();
  return { ok: true };
});

// FIX-F（2026-05-01）：单家"重新拉起"——已结束轮上某家结果不理想时，
//   不重启整轮，仅让该家用本轮 prompt 再答一次，patch 进 lastTurn。
//
// 流程：
//   1. 检测 PTY 是否已切到宿主 shell（CLI 自我退出场景）→ 调 sessionManager.relaunchCli 重启
//   2. rebuild 该家本轮 prompt（按 lastTurn.mode：fanout / debate / summary）
//   3. groupChatWatcher.sendToPty 发送（内含 groupChatWatcher.waitCliReady 冷启动等待）
//   4. 创建独立 watcher 等 turn-complete（不挂到原 dispatch 的 Promise.allSettled）
//   5. 期间推 partial-update 让卡片 UI 切回 thinking → streaming → completed
//   6. settle 后调 orch.patchTurnResult patch lastTurn + 推 turn-complete 让 renderer 刷新
ipcMain.handle('groupchat-resend-participant', async () => {
  return { ok: false, reason: 'unsupported', detail: 'group chat uses resend-prompt, manual extract, and skip recovery actions' };
});

ipcMain.handle('get-ring-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId);
});

// cli-ready-status IPC handler — 只负责"参数转发到 detector + 透传 groupChatReady 快路径"。
//   判定逻辑全部在 core/group-chat-cli-ready-detector.js（marker + 静默双门 + monotonic guard）。
//   renderer 每秒 invoke 一次，缓存到 _cliReadyCache[sid] 驱动卡片"创建中→待命"切换。
ipcMain.handle('cli-ready-status', (_e, sessionId) => {
  if (!sessionId) return false;
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  // 快路径：server 端任何路径确认 ready 后立即 surface（如 groupChatWatcher.sendToPty 已成功发过 prompt）
  if (sessionManager.getGroupChatReady(sessionId)) {
    cliReadyDetector.markReady(sessionId);
    return true;
  }
  const buf = sessionManager.getSessionBuffer(sessionId) || '';
  return cliReadyDetector.isReady(sessionId, session.kind, buf);
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

// spec2/S3：解析任意会话的 JSONL transcript 为结构化 turns 列表。
// 入参三选一：transcriptPath > ccSessionId > hubSessionId（按优先级 fallback）。
// 出参：{ turns: [...], transcriptPath, error: null|string }
//   - 找不到 transcript → { turns: [], transcriptPath: null, error: 'transcript not found' }
//   - 解析抛错 → { turns: [], transcriptPath, error: err.message }
// opts 透传给 parseClaudeTranscriptToTurns，默认 { limit: 50, fromTail: true }。
ipcMain.handle('parse-session-transcript', async (_e, args = {}) => {
  // Spec 3 · W10：在调 sync parser 之前 setImmediate yield 一次让 main loop 喘气。
  // parser 是 sync（fs.readFileSync + JSON.parse loop + merge），5MB transcript 实测
  // ~218ms 主线程阻塞。yield 不能消除阻塞，但能确保此 IPC 不和上一条 IPC 背靠背执行，
  // 让 PTY data / hook-event / 群聊广播 等其它 IPC 在阻塞间隙里被处理。
  // 不上 worker_threads 是为避免 transcript-parser 跨边界引入序列化开销 + 复杂度。
  await new Promise(resolve => setImmediate(resolve));

  const { hubSessionId, ccSessionId, transcriptPath: inPath, kind: inKind, opts } = args || {};
  let transcriptPath = inPath || null;
  try {
    const session = hubSessionId ? sessionManager.getSession(hubSessionId) : null;
    const kind = session ? session.kind : inKind;
    if (isCodexCliKind(kind)) {
      const liveRolloutPath = hubSessionId ? transcriptTap.getCodexRolloutPath(hubSessionId) : null;
      if (liveRolloutPath) {
        transcriptPath = liveRolloutPath;
      }
      if (!transcriptPath && session && session.transcriptPath) {
        transcriptPath = session.transcriptPath;
      }
      if (!transcriptPath && session && session.codexSid) {
        transcriptPath = findCodexRolloutBySid(
          session.codexSid,
          session.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT,
        );
      }
      if (!transcriptPath && session && session.codexAllowMtimeFallback && session.cwd) {
        transcriptPath = findCodexRolloutByCwd(
          session.cwd,
          session.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT,
          { sinceMs: session.createdAt || Date.now() },
        );
      }
      if (!transcriptPath) {
        return { turns: [], transcriptPath: null, error: 'codex rollout not found' };
      }
      if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
        updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
      }
      const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
      const turns = parseCodexRolloutToTurns(transcriptPath, parseOpts);
      return { turns: Array.isArray(turns) ? turns : [], transcriptPath, error: null };
    }
    if (kind === 'codex-app') {
      const extracted = hubSessionId ? await transcriptTap.extractLatestTurn(hubSessionId, 0) : null;
      if (!extracted || !extracted.text) {
        return { turns: [], transcriptPath: null, error: 'codex app-server transcript not materialized' };
      }
      return {
        turns: [{
          id: `codex-app-assistant-${hubSessionId || Date.now()}`,
          role: 'assistant',
          text: extracted.text,
          ts: Date.now(),
          tsEnd: Date.now(),
          stopReason: 'turn_completed',
          source: 'codex_app_server',
        }],
        transcriptPath: null,
        error: null,
      };
    }
    if (!transcriptPath && session && session.transcriptPath) {
      transcriptPath = session.transcriptPath;
    }
    if (!transcriptPath && ccSessionId) {
      transcriptPath = findTranscriptByCCSessionId(ccSessionId);
    }
    if (!transcriptPath && hubSessionId) {
      if (session && session.ccSessionId) {
        transcriptPath = findTranscriptByCCSessionId(session.ccSessionId);
      }
    }
    if (!transcriptPath) {
      return { turns: [], transcriptPath: null, error: 'transcript not found' };
    }
    if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
      updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
    }
    const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
    const parseStartedAt = Date.now();
    const turns = await parseClaudeTranscriptToTurns(transcriptPath, parseOpts);
    return { turns: Array.isArray(turns) ? turns : [], transcriptPath, parseMs: Date.now() - parseStartedAt, error: null };
  } catch (err) {
    return { turns: [], transcriptPath, error: err && err.message ? err.message : String(err) };
  }
});

// build-injection IPC 历史用于 blackboard 用户输入合成注入子会话(meeting-blackboard.js)。
// Module C 后 blackboard 已删除,该 handler 不再被任何前端代码调用,清理。

ipcMain.on('update-meeting', (_e, { meetingId, fields }) => {
  if (fields && typeof fields.title === 'string' && !fields.autoTitleGenerated) {
    fields = { ...fields, userRenamed: true, autoTitlePending: false };
  }
  const updated = meetingManager.updateMeeting(meetingId, fields);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
});

ipcMain.handle('update-meeting-sync', (_e, { meetingId, fields }) => {
  if (fields && typeof fields.title === 'string' && !fields.autoTitleGenerated) {
    fields = { ...fields, userRenamed: true, autoTitlePending: false };
  }
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

// 通用群聊：开关 + 公约写盘 + 私聊存储
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
    // P2 (2026-05-04 道雪): research 场景预生成 3 个 slot prompt 文件 (L3 偏置),
    //   后续 add-meeting-sub / resume 直接读取;非 research 场景仍写单一 fallback。
    //   预生成不占代价 (~3KB/文件,cleanup 时一并删) 但消除 race window
    //   (sub 启动前文件就已就绪,即便 add-meeting-sub 路径漏写也有兜底)。
    if (scene === 'research') {
      for (const sid of SLOT_IDS) {
        scenes.writePromptFile(getHubDataDir(), meetingId, scene, text, sid);
      }
    }
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

ipcMain.handle('get-meetings', () => {
  return meetingManager.getAllMeetings();
});


// Archive scanner: enumerate past Claude Code sessions for the Resume picker.
const sessionArchive = require('./core/session-archive.js');
ipcMain.handle('list-past-sessions', async (_e, { limit = 50 } = {}) => {
  try { return await sessionArchive.listRecent(limit); }
  catch (e) { console.warn('[群聊] list-past-sessions failed:', e.message); return []; }
});

ipcMain.handle('search-past-sessions', async (_e, { query, limit = 50 } = {}) => {
  try { return await sessionArchive.searchAcross(query, { limit }); }
  catch (e) { console.warn('[群聊] search-past-sessions failed:', e.message); return { hits: [], truncated: false }; }
});

ipcMain.handle('close-session', (_e, sessionId) => {
  // No explicit sendToRenderer here — closeSession kills the PTY, which fires
  // the onExit callback wired up above (line 87) and emits session-closed for
  // us. Emitting twice would spam the renderer for no benefit.
  _ptyLastResizeBySid.delete(sessionId);  // P0-4 cache cleanup
  sessionManager.closeSession(sessionId);
});

ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
  sessionManager.writeToSession(sessionId, data);
});

// SIGWINCH 去重缓存（xterm-render-stabilize P0-4, 2026-05-01）：
//   渲染端 robustFit 已经做了一层 cols/rows 不变就不发的去重；这里是主进程
//   第二层防护，覆盖任何漏过的重复 resize（例如同一帧多个调用方触发）。
//   CLI TUI（Claude/Gemini/Codex）对 SIGWINCH 高度敏感，错值或重复值都会
//   触发整屏重绘 → 导致用户看到"重复行 / 字符叠加"。
const _ptyLastResizeBySid = new Map();  // sid → { cols, rows }
ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows }) => {
  if (typeof sessionId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
  if (cols <= 0 || rows <= 0) return;  // 非法尺寸直接丢弃, 避免 fit 错值打到 PTY
  const last = _ptyLastResizeBySid.get(sessionId);
  if (last && last.cols === cols && last.rows === rows) return;  // 同尺寸去重
  _ptyLastResizeBySid.set(sessionId, { cols, rows });
  sessionManager.resizeSession(sessionId, cols, rows);
});

ipcMain.on('focus-session', (_e, { sessionId }) => {
  sessionManager.setFocusedSession(sessionId);
  sessionManager.markRead(sessionId);
});

ipcMain.handle('rename-session', (_e, { sessionId, title, userRenamed }) => {
  const session = sessionManager.renameSession(sessionId, title, { userRenamed: !!userRenamed });
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

// 2026-05-07：loadAndSelfHeal 内部已经写过一次 cleanShutdown=false 的快照，
//   这里不再重复写。原本的"flip flag immediately on boot"语义由 selfHeal 承担。

// 跟踪上一次 persist 的 hubId/meetingId 集合，用于 diff 出"用户主动移除"的条目。
//   stateStore.markRemovedSession 把 id 推到 state-store 的 removed set，
//   merge 时显式删除——不依赖"内存里没有 = 删了"，避免多 Hub 启动期间互相把对方
//   未感知到的条目抹掉。
let _lastPersistedSessionIds = new Set(lastPersistedSessions.map(s => s.hubId).filter(Boolean));
let _lastPersistedMeetingIds = new Set(bootMeetings.map(m => m && m.id).filter(Boolean));

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
  // 2026-05-05 fix: 字段名是 'currentModel'（renderer.js:5287 持久化用的字段），
  //   旧版误写成 'model' → 兜底机制对 model 永不触发，任何一次 race 把 currentModel
  //   写成 null 都会永久污染 state.json，dormant 唤醒丢失原 model（落到默认 opus 等）。
  const RESUME_META_FIELDS = ['transcriptPath', 'codexSid', 'codexAppThreadId', 'codexSessionsRoot', 'codexAllowMtimeFallback', 'codexProfile', 'codexProfileLabel', 'geminiChatId', 'geminiProjectHash', 'geminiProjectRoot', 'currentModel', 'contextPct', 'contextUsed', 'contextMax', 'userRenamed', 'autoTitleGenerated'];
  const oldByHubId = new Map(lastPersistedSessions.map(s => [s.hubId, s]));
  for (const newSession of list) {
    if (!newSession || !newSession.hubId) continue;
    const oldSession = oldByHubId.get(newSession.hubId);
    if (!oldSession) continue;
    for (const field of RESUME_META_FIELDS) {
      if (field === 'userRenamed' && oldSession.userRenamed === true) {
        newSession.userRenamed = true;
        continue;
      }
      if (newSession[field] == null && oldSession[field] != null) {
        newSession[field] = oldSession[field];
      }
    }
  }

  // 2026-05-07 道雪：updatedAt + removed diff + per-id JSON 双备份。
  const nowTs = Date.now();
  for (const s of list) {
    if (s && s.hubId) s.updatedAt = nowTs;
  }

  // diff 出"上次 persist 有但这次没了"的 hubId → 视为用户主动关闭，标记 removed
  const newSessionIds = new Set(list.map(s => s && s.hubId).filter(Boolean));
  for (const oldId of _lastPersistedSessionIds) {
    if (!newSessionIds.has(oldId)) {
      stateStore.markRemovedSession(oldId);
      sessionStore.deleteSessionFile(oldId);
      sessionStore.cancelDirty(oldId);
    }
  }
  _lastPersistedSessionIds = newSessionIds;

  // per-session JSON 备份：debounced 写盘，sid 类字段在 transcript-tap 路径走 sync
  for (const s of list) {
    if (s && s.hubId) sessionStore.markDirty(s.hubId, s);
  }

  lastPersistedSessions = list;
  // 2026-05-05 道雪：第二道防线 — renderer 传来的 meeting 列表如果缺字段（历史 bug 漏 scene 等
  //   导致重启后所有群聊退化为 general），按 id 从 meetingManager 拿权威对象做字段补全。
  //   renderer 的字段是 UI 派生快照（lastMessageTime / focusedSub 等），优先用它；
  //   participants / slotSpecs / covenantText），这些字段始终从 manager 兜底，
  //   确保即使未来 renderer 有调用方再漏字段也不会写残 state.json。
  let meetingsForState;
  if (Array.isArray(meetingList)) {
    meetingsForState = meetingList.map(rendererMeeting => {
      if (!rendererMeeting || !rendererMeeting.id) return rendererMeeting;
      const authoritative = meetingManager.getMeeting(rendererMeeting.id);
      if (!authoritative) return rendererMeeting;
      return {
        ...rendererMeeting,
        scene: rendererMeeting.scene || authoritative.scene,
        mode: rendererMeeting.mode || authoritative.mode,
        groupChat: typeof rendererMeeting.groupChat === 'boolean'
          ? rendererMeeting.groupChat
          : !!authoritative.groupChat,
        groupMode: rendererMeeting.groupMode || authoritative.groupMode || 'deliberation',
        groupRecentRawN: Number.isInteger(rendererMeeting.groupRecentRawN)
          ? rendererMeeting.groupRecentRawN
          : (Number.isInteger(authoritative.groupRecentRawN) ? authoritative.groupRecentRawN : 5),
        userRenamed: typeof rendererMeeting.userRenamed === 'boolean'
          ? rendererMeeting.userRenamed
          : !!authoritative.userRenamed,
        autoTitlePending: typeof rendererMeeting.autoTitlePending === 'boolean'
          ? rendererMeeting.autoTitlePending
          : !!authoritative.autoTitlePending,
        autoTitleGenerated: typeof rendererMeeting.autoTitleGenerated === 'boolean'
          ? rendererMeeting.autoTitleGenerated
          : !!authoritative.autoTitleGenerated,
        participants: Array.isArray(rendererMeeting.participants)
          ? rendererMeeting.participants
          : (Array.isArray(authoritative.participants) ? authoritative.participants : null),
        slotSpecs: Array.isArray(rendererMeeting.slotSpecs)
          ? rendererMeeting.slotSpecs
          : (Array.isArray(authoritative.slotSpecs) ? authoritative.slotSpecs : null),
        covenantText: (typeof rendererMeeting.covenantText === 'string' && rendererMeeting.covenantText)
          ? rendererMeeting.covenantText
          : (authoritative.covenantText || ''),
      };
    });
  } else {
    meetingsForState = meetingManager.getAllMeetings();
  }

  // 2026-05-07 道雪：meeting 同样加 updatedAt + removed diff + per-id JSON 双备份
  for (const m of meetingsForState) {
    if (m && m.id) m.updatedAt = nowTs;
  }
  const newMeetingIds = new Set(meetingsForState.map(m => m && m.id).filter(Boolean));
  for (const oldId of _lastPersistedMeetingIds) {
    if (!newMeetingIds.has(oldId)) {
      stateStore.markRemovedMeeting(oldId);
      // meeting-store 已在 closeMeeting 路径调过 deleteMeetingFile + cancelDirty；
      // 这里再补一次防御写：renderer 推 persist-sessions 时偶发先于 closeMeeting 路径。
      meetingStore.deleteMeetingFile(oldId);
      meetingStore.cancelDirty(oldId);
    }
  }
  _lastPersistedMeetingIds = newMeetingIds;

  // 把 immersive 状态合并进 meeting 字段，让 per-meeting JSON 也带上（v2 schema）
  for (const m of meetingsForState) {
    if (m && m.id) {
      const im = _immersiveByMeeting[m.id];
      if (typeof im === 'boolean') m.immersive = im;
      meetingStore.markDirty(m.id, m);
    }
  }

  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: list,
    meetings: meetingsForState,
    immersiveByMeeting: _immersiveByMeeting,
  });
});

// Wake a dormant session: spawn PTY with the same hubId, reusing stored cwd,
// CC session id, title. The session-manager handles `claude --resume <id>` or
// `--continue` as fallback when we don't have a CC id recorded.
ipcMain.handle('resume-session', async (_e, meta) => {
  if (!meta || !meta.hubId) return null;
  const isClaude = (meta.kind === 'claude' || meta.kind === 'claude-resume' || meta.kind === 'claude-web' || meta.kind === 'claude-web-resume');
  const isDeepSeek = (meta.kind === 'deepseek');
  const isGlm = (meta.kind === 'glm');
  // CLAUDE_FAMILY 含 claude/claude-resume/deepseek/glm/gpt/kimi/qwen — 所有跑在 Claude CLI
  // 上的 kind 共享同一 resume + system prompt 注入路径，单一真理源。
  const isClaudeCliResumable = isClaudeFamily(meta.kind);
  const isGeminiOrCodex = (meta.kind === 'gemini' || isCodexBaseKind(meta.kind));
  const codexMissingSid = (isCodexBaseKind(meta.kind) && !meta.codexSid);

  // resume 时根据会议模式重新注入 prompt 文件(research/general 公约)。
  // 注意三家 CLI 各走自己的注入字段(与 add-meeting-sub 对齐):
  //   Claude  → appendSystemPromptFile (CLI 参数)
  //   Gemini  → extraEnv.GEMINI_SYSTEM_MD (env)
  //   Codex   → codexInstructionFile (CLI 参数)
  let resumeOpts = {};
  if (meta.meetingId) {
    const meeting = meetingManager.getMeeting(meta.meetingId);
    let promptFile = null;
    if (meeting && meeting.scene && !meeting.groupChat) {
      const hubDataDir = getHubDataDir();
      const covenantText = (typeof meeting.covenantText === 'string' && meeting.covenantText.length > 0)
        ? meeting.covenantText
        : scenes.readCovenantSnapshot(hubDataDir, meta.meetingId);
      // P2 (2026-05-04 道雪): resume 时按 subSessions index 推 slotId,
      //   保证 dormant→awake 后注入与首次启动一致的 L3 偏置。
      //   meta.hubId 不在 subSessions 时 (异常路径) → slotId=null,退回老 fallback。
      let slotId = null;
      if (Array.isArray(meeting.subSessions)) {
        const idx = meeting.subSessions.indexOf(meta.hubId);
        if (idx >= 0 && idx < SLOT_IDS.length) slotId = SLOT_IDS[idx];
      }
      promptFile = scenes.writePromptFile(hubDataDir, meta.meetingId, meeting.scene, covenantText, slotId);
    }
    if (promptFile) {
      if (isClaude || isGlm) {
        resumeOpts.appendSystemPromptFile = promptFile;
      } else if (meta.kind === 'gemini') {
        resumeOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
      } else if (isCodexBaseKind(meta.kind)) {
        resumeOpts.codexInstructionFile = promptFile;
      }
    }
    if (meeting && meeting.groupChat && meeting.scene === 'research' && hookPort) {
      const hubDataDir = getHubDataDir();
      if (isClaudeCliResumable) {
        resumeOpts.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, meta.meetingId, hookPort, HOOK_TOKEN, meta.kind || 'claude');
      } else if (meta.kind === 'gemini') {
        resumeOpts.extraEnv = {
          ...(resumeOpts.extraEnv || {}),
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meta.meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: HOOK_TOKEN,
          ARENA_AI_KIND: 'gemini',
        };
      } else if (isCodexBaseKind(meta.kind)) {
        resumeOpts.codexBypassApprovals = true;
        resumeOpts.codexMcpEntries = [scenes.buildResearchMcpEntryForCodex(meta.meetingId, hookPort, HOOK_TOKEN)];
      }
    } else if (meeting && meeting.groupChat && meeting.scene === 'research' && !hookPort) {
      console.warn('[群聊] research scene resume for meeting ' + meta.meetingId + ' but hookPort unavailable — stock MCP tools unavailable');
    }
  }

  let resumeTranscriptPath = meta.transcriptPath || null;
  if (!resumeTranscriptPath && isClaudeCliResumable && meta.ccSessionId) {
    try { resumeTranscriptPath = findTranscriptByCCSessionId(meta.ccSessionId); } catch {}
  }
  if (!resumeTranscriptPath && isCodexBaseKind(meta.kind) && meta.codexSid) {
    try { resumeTranscriptPath = findCodexRolloutBySid(meta.codexSid, meta.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT); } catch {}
  }

  const session = sessionManager.createSession(meta.kind || 'claude', {
    id: meta.hubId,
    title: meta.title,
    cwd: (meta.kind === 'gemini' && meta.geminiProjectRoot) ? meta.geminiProjectRoot : meta.cwd,
    meetingId: meta.meetingId || null,
    model: meta.model || undefined,
    resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
    resumeTranscriptPath: resumeTranscriptPath || undefined,
    useContinue: isClaudeCliResumable && !meta.ccSessionId,
    useResume: isGeminiOrCodex,
    codexResumePicker: codexMissingSid,
    codexSid: isCodexBaseKind(meta.kind) ? (meta.codexSid || null) : null,
    codexProfile: isCodexBaseKind(meta.kind) ? (meta.codexProfile || null) : null,
    geminiChatId: meta.kind === 'gemini' ? (meta.geminiChatId || null) : null,
    geminiProjectRoot: meta.kind === 'gemini' ? (meta.geminiProjectRoot || null) : null,
    autoTitleGenerated: !!meta.autoTitleGenerated,
    lastMessageTime: meta.lastMessageTime,
    lastOutputPreview: meta.lastOutputPreview,
    ...resumeOpts,
  });
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });

  // Level 3 fallback: when native resume is unavailable (Level 1+2 both fail),
  // inject transcript tail as [CONTEXT] block into PTY after spawn settles.
  const needsLevel3 = (
    (isCodexBaseKind(meta.kind) && !meta.codexSid) ||
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
              console.warn(`[群聊] Level 3 inject skipped: session ${session.id.slice(0,8)} no longer active`);
              return;
            }
            sessionManager.writeToSession(session.id, msg);
            console.log(`[群聊] Level 3 fallback: injected ${tail.length}-char transcript tail to ${meta.kind} session ${session.id.slice(0,8)}`);
          } catch (e) {
            console.warn(`[群聊] Level 3 inject failed:`, e.message);
          }
        }, 5000);
      }).catch(e => console.warn('[群聊] Level 3 fallback error:', e.message));
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
  const n = new Notification({ title: title || 'AI 群聊', body: body || '', silent: false });
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
    console.warn('[群聊] save-clipboard-image failed:', e.message);
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

// 群聊记忆 · plan 阶段 1（2026-05-07）：
//   per-meeting per-slot 取 memory 状态（条目数 + pending 数 + _profile 是否存在）
//   供卡片右上角 📒 N / 📥 / 📊 三个按钮的角标 / 点击行为使用。
//   不读 .md 内容（只 stat / count），便于高频刷新。
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

ipcMain.handle('get-usage-cache', () => loadUsageCacheForCurrentConfig());

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

ipcMain.handle('refresh-packy-account', async () => {
  return await fetchAndCachePackyAccount();
});

// 打开外部 URL(用系统默认浏览器,而不是 Electron BrowserWindow)
ipcMain.handle('open-external-url', async (_e, url) => {
  if (!url || !/^https?:\/\//i.test(url)) return { success: false };
  await shell.openExternal(url);
  return { success: true };
});

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
    gptApiKey: config.gptApiKey ? '***' + config.gptApiKey.slice(-4) : '',
    gptApiKeySet: !!config.gptApiKey,
    gptBaseUrl: config.gptBaseUrl,
    gptModel: config.gptModel,
    kimiApiKey: config.kimiApiKey ? '***' + config.kimiApiKey.slice(-4) : '',
    kimiApiKeySet: !!config.kimiApiKey,
    kimiBaseUrl: config.kimiBaseUrl,
    kimiModel: config.kimiModel,
    qwenApiKey: config.qwenApiKey ? '***' + config.qwenApiKey.slice(-4) : '',
    qwenApiKeySet: !!config.qwenApiKey,
    qwenBaseUrl: config.qwenBaseUrl,
    qwenModel: config.qwenModel,
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    codexApiKey: config.codexApiKey ? '***' + config.codexApiKey.slice(-4) : '',
    codexApiKeySet: !!config.codexApiKey,
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
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
    gptApiKey: config.gptApiKey || '',
    gptBaseUrl: config.gptBaseUrl,
    gptModel: config.gptModel,
    kimiApiKey: config.kimiApiKey || '',
    kimiBaseUrl: config.kimiBaseUrl,
    kimiModel: config.kimiModel,
    qwenApiKey: config.qwenApiKey || '',
    qwenBaseUrl: config.qwenBaseUrl,
    qwenModel: config.qwenModel,
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    codexApiKey: config.codexApiKey || '',
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
    packySessionCookie: config.packySessionCookie || '',
    uiToolFoldThreshold: Number.isFinite(config.uiToolFoldThreshold) ? config.uiToolFoldThreshold : 15,
    uiCodeFoldThreshold: Number.isFinite(config.uiCodeFoldThreshold) ? config.uiCodeFoldThreshold : 30,
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
      gpt: {
        ...(existing.providers?.gpt || {}),
        api_key: newConfig.gptApiKey || undefined,
        base_url: newConfig.gptBaseUrl || DEFAULTS.gpt_base_url,
        model: newConfig.gptModel || DEFAULTS.gpt_model,
      },
      kimi: {
        ...(existing.providers?.kimi || {}),
        api_key: newConfig.kimiApiKey || undefined,
        base_url: newConfig.kimiBaseUrl || DEFAULTS.kimi_base_url,
        model: newConfig.kimiModel || DEFAULTS.kimi_model,
      },
      qwen: {
        ...(existing.providers?.qwen || {}),
        api_key: newConfig.qwenApiKey || undefined,
        base_url: newConfig.qwenBaseUrl || DEFAULTS.qwen_base_url,
        model: newConfig.qwenModel || DEFAULTS.qwen_model,
      },
      codex: {
        ...(existing.providers?.codex || {}),
        backend: newConfig.codexBackend === 'api' ? 'api' : DEFAULTS.codex_backend,
        subscription_profile: newConfig.codexSubscriptionProfile || DEFAULTS.codex_subscription_profile,
        subscription_profiles: Array.isArray(newConfig.codexSubscriptionProfiles) ? newConfig.codexSubscriptionProfiles : undefined,
        api_key: newConfig.codexApiKey || undefined,
        base_url: newConfig.codexApiBaseUrl || DEFAULTS.codex_api_base_url,
        model: newConfig.codexApiModel || DEFAULTS.codex_api_model,
        provider: DEFAULTS.codex_api_provider,
      },
      packy: {
        ...(existing.providers?.packy || {}),
        session_cookie: newConfig.packySessionCookie || undefined,
      },
    },
  };

  // 清除空值
  if (!merged.providers.deepseek.api_key) delete merged.providers.deepseek.api_key;
  if (!merged.providers.glm.api_key) delete merged.providers.glm.api_key;
  if (!merged.providers.gpt.api_key) delete merged.providers.gpt.api_key;
  if (!merged.providers.kimi.api_key) delete merged.providers.kimi.api_key;
  if (!merged.providers.qwen.api_key) delete merged.providers.qwen.api_key;
  if (!merged.providers.codex.api_key) delete merged.providers.codex.api_key;
  if (!merged.providers.packy.session_cookie) delete merged.providers.packy.session_cookie;

  saveConfig(merged);
  clearSessionManagerConfigCache();
  // packy cookie 改了立即重拉,UI 不用等下个 5 分钟
  if (newConfig.packySessionCookie !== undefined) {
    fetchAndCachePackyAccount().catch(() => {});
  }
  if (newConfig.codexBackend !== undefined || newConfig.codexSubscriptionProfile !== undefined) {
    const scope = currentCodexUsageScope();
    _codexJsonlCachedByRoot.clear();
    sendToRenderer('agent-usage', { codex: attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, scope) });
    setImmediate(() => scanAgentSessions());
  }
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
