const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { EventEmitter } = require('events');

const RING_BUFFER_BYTES = 16384;

// Default proxy for Claude sessions. Change if your proxy differs.
const CLAUDE_PROXY = 'http://127.0.0.1:7890';

function loadSecretValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const content = fs.readFileSync('C:\\LinDangAgent\\secrets.toml', 'utf8');
    const match = content.match(new RegExp(key + "\\s*=\\s*[\"']([^\"']+)[\"']"));
    return match ? match[1] : '';
  } catch { return ''; }
}
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}
const DEEPSEEK_API_KEY = loadSecretValue('DEEPSEEK_API_KEY');
const GLM_API_KEY = loadSecretValue('GLM_API_KEY');
const GLM_BASE_URL = normalizeBaseUrl(loadSecretValue('GLM_BASE_URL') || 'https://mydamoxing.cn');
const GLM_MODEL = loadSecretValue('GLM_MODEL') || 'glm-5.1';

function toClaudeProjectKey(projectDir) {
  return path.resolve(projectDir || os.homedir()).replace(/\\/g, '/');
}

function ensureClaudeBypassAndTrust(claudeDir, projectDir) {
  if (!claudeDir) return;
  try {
    fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (settings.permissionMode !== 'bypassPermissions') {
      settings.permissionMode = 'bypassPermissions';
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    }

    const statePath = path.join(claudeDir, '.claude.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) {
      state.projects = {};
    }

    const projectKey = toClaudeProjectKey(projectDir);
    const existing = state.projects[projectKey] && typeof state.projects[projectKey] === 'object'
      ? state.projects[projectKey]
      : {};
    state.projects[projectKey] = {
      allowedTools: Array.isArray(existing.allowedTools) ? existing.allowedTools : [],
      mcpContextUris: Array.isArray(existing.mcpContextUris) ? existing.mcpContextUris : [],
      mcpServers: existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {},
      enabledMcpjsonServers: Array.isArray(existing.enabledMcpjsonServers) ? existing.enabledMcpjsonServers : [],
      disabledMcpjsonServers: Array.isArray(existing.disabledMcpjsonServers) ? existing.disabledMcpjsonServers : [],
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[hub] failed to pretrust Claude config:', err.message);
  }
}

class SessionManager extends EventEmitter {
  sessions = new Map();
  focusedSessionId = null;
  claudeCounter = 0;
  resumeCounter = 0;
  psCounter = 0;
  _outputSeq = 0;

  // Injected by main: the chosen hook HTTP port + per-launch auth token.
  hookPort = null;
  hookToken = null;

  constructor() {
    super();
  }

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};

  // opts: { id?, title?, cwd?, resumeCCSessionId?, useContinue? }
  //   id:                 reuse a previous hub session id (dormant wake)
  //   title:              override default title (dormant wake preserves name)
  //   cwd:                launch cwd; defaults to user home
  //   resumeCCSessionId:  when set, runs `claude --resume <id>`
  //   useContinue:        when set, runs `claude --continue` (Claude fallback)
  //   useResume:          generic resume flag for codex/gemini → uses sid/index if provided, else --last/latest
  //   codexSid:           when set + kind=='codex' + useResume, runs `codex resume <sid>` precisely (T8 new)
  //   geminiChatId:       Gemini 8charId from chats/session-*.json (T8 new, used for index lookup)
  //   geminiProjectRoot:  required for Gemini resume (T8 new, used as cwd for correct project scoping)
  createSession(kind = 'powershell', opts = {}) {
    const id = opts.id || uuid();
    const isClaude = kind === 'claude' || kind === 'claude-resume';
    const isGemini = kind === 'gemini';
    const isCodex = kind === 'codex';
    const isDeepSeek = kind === 'deepseek';
    const isGlm = kind === 'glm';
    const isAgent = isClaude || isGemini || isCodex || isDeepSeek || isGlm;
    let title;
    if (opts.title) title = opts.title;
    else if (kind === 'claude') title = `Claude ${++this.claudeCounter}`;
    else if (kind === 'claude-resume') title = `Claude Resume ${++this.resumeCounter}`;
    else if (kind === 'gemini') { this.geminiCounter = (this.geminiCounter || 0) + 1; title = `Gemini ${this.geminiCounter}`; }
    else if (kind === 'codex') { this.codexCounter = (this.codexCounter || 0) + 1; title = `Codex ${this.codexCounter}`; }
    else if (kind === 'deepseek') { this.deepseekCounter = (this.deepseekCounter || 0) + 1; title = `DeepSeek ${this.deepseekCounter}`; }
    else if (kind === 'glm') { this.glmCounter = (this.glmCounter || 0) + 1; title = `GLM ${this.glmCounter}`; }
    else title = `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };

    if (isClaude) {
      // Force subscription OAuth (Claude Max): strip custom-endpoint env vars
      // that would otherwise route Claude Code to cc-switch / CCR.
      delete sessionEnv.ANTHROPIC_BASE_URL;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      // Force Clash proxy — don't rely on how Electron was launched.
      // User's hard rule: all CLI calls must go through 127.0.0.1:7890.
      sessionEnv.HTTP_PROXY = CLAUDE_PROXY;
      sessionEnv.HTTPS_PROXY = CLAUDE_PROXY;
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      // Attribution + auth for the Stop/UserPromptSubmit hook script
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      // Propagate data-dir override so the statusline script writes its cache
      // into the isolated test dir instead of the production ~/.claude-session-hub.
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isGemini || isCodex) {
      sessionEnv.HTTP_PROXY = CLAUDE_PROXY;
      sessionEnv.HTTPS_PROXY = CLAUDE_PROXY;
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
    } else if (isDeepSeek) {
      // DeepSeek API 国内直连，不走代理
      delete sessionEnv.HTTP_PROXY;
      delete sessionEnv.HTTPS_PROXY;
      delete sessionEnv.NO_PROXY;
      // 让 Claude Code CLI 连接 DeepSeek 的 Anthropic 兼容端点
      sessionEnv.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
      sessionEnv.ANTHROPIC_AUTH_TOKEN = DEEPSEEK_API_KEY;
      // 清除可能继承的 Anthropic 认证，防止冲突
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      // 隔离 transcript/settings/history，防止与 Claude 会话互相污染
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-deepseek');
      // Hub hook 集成
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isGlm) {
      delete sessionEnv.HTTP_PROXY;
      delete sessionEnv.HTTPS_PROXY;
      delete sessionEnv.NO_PROXY;
      sessionEnv.ANTHROPIC_BASE_URL = GLM_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-glm');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    }

    // Merge extra env vars (used by TeamSessionManager for MCP config etc.)
    if (opts.extraEnv) {
      Object.assign(sessionEnv, opts.extraEnv);
    }

    const shellArgs = isAgent ? ['-NoProfile', '-NoLogo'] : [];
    // cwd fallback order: opts.cwd (if exists) -> user home. We stat-check to
    // avoid node-pty failing if the stored cwd was later deleted/moved.
    let spawnCwd = opts.cwd;
    if (spawnCwd) {
      try { fs.accessSync(spawnCwd); } catch { spawnCwd = null; }
    }
    if (!spawnCwd) spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';

    if (isDeepSeek || isGlm) {
      ensureClaudeBypassAndTrust(sessionEnv.CLAUDE_CONFIG_DIR, spawnCwd);
    }

    const ptyProcess = pty.spawn('powershell.exe', shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spawnCwd,
      env: sessionEnv,
      useConpty: true,
      // conptyInheritCursor=true kills PTY output for headless sessions (no
      // renderer xterm attached). TeamSessionManager sets noInheritCursor for
      // background character sessions. Normal user sessions don't set it, so
      // the default stays true for backward compatibility.
      conptyInheritCursor: !opts.noInheritCursor,
    });

    let currentModel = null;
    if (isGemini) {
      const mid = opts.model || 'gemini-2.5-flash';
      currentModel = { id: mid, displayName: SessionManager.geminiDisplayName(mid) };
    } else if (isCodex) {
      currentModel = { id: 'gpt-5.5', displayName: 'GPT-5.5' };
    } else if (isDeepSeek) {
      const mid = opts.model || 'deepseek-v4-pro';
      currentModel = { id: mid, displayName: mid === 'deepseek-v4-pro' ? 'DS V4 Pro' : 'DS V4 Flash' };
    } else if (isGlm) {
      const mid = opts.model || GLM_MODEL;
      currentModel = { id: mid, displayName: mid.toLowerCase().includes('5.1') ? 'GLM 5.1' : mid };
    }

    const now = Date.now();
    const info = {
      id,
      kind,
      title,
      status: 'idle',
      lastMessageTime: opts.lastMessageTime || now,
      lastOutputPreview: opts.lastOutputPreview || '',
      unreadCount: 0,
      createdAt: now,
      cwd: spawnCwd,
      meetingId: opts.meetingId || null,
      currentModel,
    };

    const pendingTimers = [];
    // roundtableReady：圆桌"快路径"缓存，CLI 首次 ready 后置 true，
    //   后续 _rtSendToPty 跳过 8s/8s/5s 硬 sleep；活性兜底失败时重置 false。
    // roundtableLastActivity：PTY 最近一次产出输出的 ms 时间戳，用于活性兜底判断。
    this.sessions.set(id, { info, pty: ptyProcess, pendingTimers, ringBuffer: '', roundtableReady: false, roundtableLastActivity: 0 });

    ptyProcess.onData((data) => {
      const entry = this.sessions.get(id);
      if (entry) entry.roundtableLastActivity = Date.now();
      this._appendToRingBuffer(id, data);
      this.onData(id, data);
      this._outputSeq += 1;
      this.emit('output', { sessionId: id, seq: this._outputSeq, data });
    });

    ptyProcess.onExit((exitInfo) => {
      const entry = this.sessions.get(id);
      // Guard against id reuse: if a fresh session has already taken this id
      // (e.g., via restart-session reusing old.id), the entry's pty will be
      // the new one, NOT this ptyProcess. In that case the new session is
      // alive — we must not delete its Map entry or fire onSessionClosed
      // for the new session.
      if (!entry || entry.pty !== ptyProcess) return;
      const mid = entry.info ? entry.info.meetingId : null;
      this.sessions.delete(id);
      // Stage 2 P1-1：把 exit code/signal 透传给 onSessionClosed，
      //   让 main.js 能把"PTY 异常退出"作为 L2 完成信号通知圆桌 watcher。
      //   exitInfo 来自 node-pty：{ exitCode: number, signal: number | undefined }
      //   老调用方只用前两参（id, mid），无需调整；第 3 参可选。
      this.onSessionClosed(id, mid, exitInfo || null);
    });

    if (kind === 'powershell') {
      ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle ListView 2>$null; clear\r\n');
    }

    if (isClaude) {
      let cmd;
      if (opts.resumeCCSessionId) {
        cmd = ` claude --resume ${opts.resumeCCSessionId}`;
      } else if (opts.useContinue) {
        cmd = ' claude --continue';
      } else if (kind === 'claude-resume') {
        cmd = ' claude --resume';
      } else {
        // Fresh Claude sessions default to Opus 4.7 1M (extended thinking).
        // Resume/continue inherit the transcript's model, so don't force --model there.
        cmd = ' claude --model claude-opus-4-7[1m]';
      }
      // Append system prompt file if provided (TeamSessionManager injects character prompt)
      if (opts.appendSystemPromptFile) {
        cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
      }
      // Append MCP config file if provided (TeamSessionManager injects MCP server config)
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isGemini) {
      let cmd = ' gemini --approval-mode yolo';
      cmd += ` --model ${opts.model || 'gemini-2.5-flash'}`;
      if (opts.useResume) {
        if (opts.geminiChatId && opts.geminiChatId.length > 8) {
          // Level 1: precise resume by full UUID (e.g. "3eab55d9-8019-4485-a47e-07f93e288be5")
          cmd += ` --resume ${opts.geminiChatId}`;
        } else {
          // Level 2: 8charId (old state.json format) or no chatId → fall back to latest
          cmd += ' --resume latest';
        }
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isCodex) {
      let cmd;
      if (opts.useResume && opts.codexSid) {
        // Level 1: precise resume by sid
        cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox`;
      } else if (opts.useResume) {
        // Level 2 degradation: no sid recorded → use --last
        cmd = ' codex resume --last --dangerously-bypass-approvals-and-sandbox';
      } else {
        // Research mode：完全 bypass approvals + sandbox（含 MCP 工具调用、shell 命令、文件写）
        // 避免任何 "Allow ... ?" 弹窗阻塞投研讨论流程；
        // 安全约束完全靠 prompt/covenant 软约束（已强化"不要改代码 / 不要 git / 不要删除"）
        if (opts.codexBypassApprovals) {
          cmd = ' codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5';
        } else {
          cmd = ' codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5';
        }
        // 注：曾尝试 --no-alt-screen 改善观感，实测无明显改善 + Enter 提交失效 → 撤回。
        // 渲染观感问题改由"持久化圆桌面板"（直接展示干净回答预览）绕过。
        if (opts.codexInstructionFile) {
          cmd += ` -c "model_instructions_file=${opts.codexInstructionFile.replace(/\\/g, '\\\\')}"`;
        }
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isDeepSeek) {
      let cmd;
      // --permission-mode bypassPermissions 跳过信任文件夹 + 工具权限等所有弹窗，
      // 让 DeepSeek 会话和 Claude 会话一样直接启动（~/.claude-deepseek 是隔离配置，
      // 不像 ~/.claude 有历史累积的信任状态，必须靠 CLI 参数兜底）。
      if (opts.resumeCCSessionId) {
        cmd = ` claude --resume ${opts.resumeCCSessionId} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        cmd = ' claude --continue --permission-mode bypassPermissions';
      } else {
        cmd = ` claude --model ${opts.model || 'deepseek-v4-pro'} --permission-mode bypassPermissions`;
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isGlm) {
      let cmd;
      if (opts.resumeCCSessionId) {
        cmd = ` claude --resume ${opts.resumeCCSessionId} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        cmd = ' claude --continue --permission-mode bypassPermissions';
      } else {
        cmd = ` claude --model ${opts.model || GLM_MODEL} --permission-mode bypassPermissions`;
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    return { ...info };
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const t of session.pendingTimers) clearTimeout(t);
    session.pty.kill();
    // Do NOT delete from this.sessions here — the onExit handler does it.
    // The guard in onExit (entry.pty !== ptyProcess) requires the entry to
    // still be present so it can confirm the dying pty owns the entry.
    // Deleting early makes onExit see entry=undefined and return early, so
    // onSessionClosed never fires and the renderer never receives
    // `session-closed` — which is exactly the "X button does nothing" bug.
  }

  renameSession(sessionId, title) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.info.title = title;
    return { ...session.info };
  }

  writeToSession(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && s.pty) s.pty.write(data);
  }

  resizeSession(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s) s.pty.resize(Math.max(cols, 60), rows);
  }

  setFocusedSession(sessionId) {
    this.focusedSessionId = sessionId;
  }

  markRead(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.unreadCount = 0;
      this.emit('session-updated', this._toPublic(session.info));
    }
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  // 圆桌快路径缓存：首次 _rtWaitCliReady 通过后置 true，后续 _rtSendToPty 跳过冷启动 sleep。
  getRoundtableReady(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? !!s.roundtableReady : false;
  }

  setRoundtableReady(sessionId, ready) {
    const s = this.sessions.get(sessionId);
    if (s) s.roundtableReady = !!ready;
  }

  // 返回 PTY 最近一次产出输出的 ms 时间戳，用于 _rtSendToPty 活性兜底（write 后 300ms 内有无 echo）。
  getRoundtableLastActivity(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? (s.roundtableLastActivity || 0) : 0;
  }

  getAllSessions() {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt);
  }

  // Returns the public shape used by mobile API and 'session-updated' events.
  _toPublic(info) {
    return {
      id: info.id,
      title: info.title,
      kind: info.kind,
      cwd: info.cwd,
      unreadCount: info.unreadCount,
      lastMessageTime: info.lastMessageTime,
      lastOutputPreview: info.lastOutputPreview,
      ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
      ...(info.ccSessionId !== undefined ? { ccSessionId: info.ccSessionId } : {}),
    };
  }

  // Returns array of public session objects for mobile API.
  listSessions() {
    return Array.from(this.sessions.values())
      .map(s => this._toPublic(s.info))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  }

  // Appends data to the session's ring buffer, capping at RING_BUFFER_BYTES (tail-slice).
  // After truncation, trims any lone low-surrogate left at the start of the buffer
  // that could result from cutting a UTF-16 surrogate pair at the boundary.
  // Extracted as a named method so tests can drive it without spawning a real PTY.
  _appendToRingBuffer(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    let rb = (s.ringBuffer || '') + data;
    if (rb.length > RING_BUFFER_BYTES) {
      rb = rb.slice(rb.length - RING_BUFFER_BYTES);
      // Trim leading lone low-surrogates (unpaired 0xDC00–0xDFFF) left by the cut.
      // A high surrogate (0xD800–0xDBFF) at position 0 is fine only if it's
      // immediately followed by a low surrogate; otherwise drop it too.
      let i = 0;
      while (i < rb.length && i < 4) {
        const cc = rb.charCodeAt(i);
        // Lone low-surrogate — definitely unpaired, drop it
        if (cc >= 0xDC00 && cc <= 0xDFFF) { i++; continue; }
        // High surrogate followed by something that is NOT a low surrogate — drop it
        if (cc >= 0xD800 && cc <= 0xDBFF) {
          const next = rb.charCodeAt(i + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) { i++; continue; }
        }
        break;
      }
      if (i > 0) rb = rb.slice(i);
    }
    s.ringBuffer = rb;
  }

  // Returns the ring-buffer string for a session, '' if exists but empty,
  // null if session not found.
  getSessionBuffer(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return s.ringBuffer || '';
  }

  dispose() {
    for (const s of this.sessions.values()) {
      for (const t of s.pendingTimers) clearTimeout(t);
      s.pty.kill();
    }
    this.sessions.clear();
  }

  static geminiDisplayName(id) {
    if (!id) return 'Gemini';
    return id
      .replace(/^gemini-/, 'Gemini ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/^Gemini (\d)/, 'Gemini $1');
  }

  // Strip ANSI escape codes from terminal output for pattern matching.
  static stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '');
  }
}

// Read tail N turns from a CLI transcript file and format into a prompt-injectable
// context block. Returns null if file unavailable or no usable turns.
//   kind:    'claude' | 'codex' | 'gemini'
//   sourcePath: kind-specific transcript file path
async function readTranscriptTail(kind, sourcePath, n = 10) {
  if (!sourcePath) return null;
  // T13 fix: refuse oversized transcripts (>5MB) to avoid main-process memory spike
  // (readFileSync + split allocates ~2x file size in RAM).
  try {
    const stat = require('fs').statSync(sourcePath);
    if (stat.size > 5 * 1024 * 1024) {
      console.warn(`[hub] readTranscriptTail skipping ${sourcePath} (${(stat.size/1024/1024).toFixed(1)}MB > 5MB cap)`);
      return null;
    }
  } catch { return null; }
  // T13 fix: cap injected context at 50KB so an oversized join doesn't overflow PTY buffer.
  const MAX_INJECT = 50 * 1024;
  try {
    if (kind === 'gemini' && sourcePath.endsWith('.json') && !sourcePath.endsWith('.jsonl')) {
      // Gemini old format: single JSON file
      const obj = JSON.parse(require('fs').readFileSync(sourcePath, 'utf-8'));
      const msgs = Array.isArray(obj.messages) ? obj.messages.slice(-n) : [];
      const joined = msgs.map(m => {
        if (m.type === 'user') return `USER: ${(m.content||[]).map(c=>c.text).filter(Boolean).join('')}`;
        if (m.type === 'gemini') return `ASSISTANT: ${typeof m.content==='string'?m.content:''}`;
        return null;
      }).filter(Boolean).join('\n\n');
      return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
    }
    // JSONL: tail N lines
    const lines = require('fs').readFileSync(sourcePath, 'utf-8').trim().split('\n').slice(-n*2);
    const out = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (kind === 'claude') {
        if (obj.type === 'user' && obj.message?.content) {
          out.push(`USER: ${typeof obj.message.content === 'string' ? obj.message.content : JSON.stringify(obj.message.content)}`);
        }
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const txt = obj.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (txt) out.push(`ASSISTANT: ${txt}`);
        }
      } else if (kind === 'codex') {
        if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete' && obj.payload?.last_agent_message) {
          out.push(`ASSISTANT: ${obj.payload.last_agent_message}`);
        } else if (obj.type === 'response_item' && obj.payload?.role === 'user' && obj.payload?.content) {
          out.push(`USER: ${typeof obj.payload.content === 'string' ? obj.payload.content : JSON.stringify(obj.payload.content)}`);
        }
      } else if (kind === 'gemini') {
        if (obj.type === 'user') {
          out.push(`USER: ${(obj.content||[]).map(c => c.text).filter(Boolean).join('')}`);
        }
        if (obj.type === 'gemini') {
          out.push(`ASSISTANT: ${typeof obj.content === 'string' ? obj.content : ''}`);
        }
      }
    }
    const joined = out.slice(-n).join('\n\n');
    return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
  } catch (e) {
    console.warn(`[hub] readTranscriptTail(${kind}) failed:`, e.message);
    return null;
  }
}

module.exports = { SessionManager, readTranscriptTail };
