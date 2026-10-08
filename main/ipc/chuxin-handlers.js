'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const { ChuxinSessionRegistry } = require('../../core/chuxin-session-registry.js');
const scenes = require('../../core/group-chat-scenes.js');

const CHUXIN_DIR = process.env.CHUXIN_DIR || 'C:\\Users\\lintian\\chuxin-research';
const API_BASE = process.env.CHUXIN_API_BASE || 'http://127.0.0.1:3004';
const WEB_BASE = process.env.CHUXIN_WEB_BASE || 'http://127.0.0.1:3003';

function httpJson(method, url, timeoutMs, body = null, headers = {}) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      method,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = text ? JSON.parse(text) : {};
          resolve({ ok: res.statusCode < 400, status: res.statusCode, body: parsed, error: res.statusCode < 400 ? null : (parsed.detail || text) });
        } catch (error) {
          resolve({ ok: false, status: res.statusCode, error: `bad json: ${error.message}`, text });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ ok: false, status: 0, error: error.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGetJson(url, timeoutMs, headers = {}) {
  return httpJson('GET', url, timeoutMs, null, headers);
}

function nativeSessionMeta(session) {
  if (!session) return {};
  return {
    ...(session.ccSessionId ? { ccSessionId: session.ccSessionId } : {}),
    ...(session.codexSid ? { codexSid: session.codexSid } : {}),
    ...(session.kimiSid ? { kimiSid: session.kimiSid } : {}),
    ...(session.kimiSessionDir ? { kimiSessionDir: session.kimiSessionDir } : {}),
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
  };
}

function resumeOptions(record) {
  const native = record && record.nativeSession && typeof record.nativeSession === 'object'
    ? record.nativeSession : {};
  if (record.kind === 'codex' && native.codexSid) return { useResume: true, codexSid: native.codexSid };
  if (record.kind === 'claude' && native.ccSessionId) return { resumeCCSessionId: native.ccSessionId };
  if (record.kind === 'kimi' && native.kimiSid) return { useResume: true, kimiSid: native.kimiSid, kimiSessionDir: native.kimiSessionDir };
  return null;
}

function addCodexMcpEntry(options, entry) {
  if (!entry) return;
  options.codexMcpEntries = Array.isArray(options.codexMcpEntries) ? options.codexMcpEntries : [];
  if (!options.codexMcpEntries.some((row) => row && row.name === entry.name)) options.codexMcpEntries.push(entry);
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'health endpoint not ready';
  while (Date.now() < deadline) {
    const response = await httpGetJson(`${API_BASE}/health`, 2000);
    if (response.ok && response.body && response.body.status === 'ok') return { healthy: true, body: response.body };
    lastError = response.error || `HTTP ${response.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { healthy: false, error: lastError };
}

function registerChuxinIpc(ipcMain, deps = {}) {
  const {
    registerSessionForTap = () => {},
    sendToRenderer = () => {},
    sessionManager = null,
    getHubDataDir = () => process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub'),
    getHookPort = () => 0,
    hookToken = '',
  } = deps;
  const registry = new ChuxinSessionRegistry();
  const ownershipByHubSession = new Map();

  function claimOwnership(researchSessionId) {
    const claim = registry.claim(researchSessionId, {
      ownerHub: String(process.env.CLAUDE_HUB_DATA_DIR || 'default'),
    });
    if (!claim.ok) return claim;
    const leaseTimer = setInterval(() => registry.renew(researchSessionId, claim.token), 30000);
    leaseTimer.unref?.();
    return { ...claim, leaseTimer };
  }

  function bindOwnership(hubSessionId, researchSessionId, ownership) {
    ownershipByHubSession.set(hubSessionId, {
      researchSessionId,
      leaseToken: ownership.token,
      leaseTimer: ownership.leaseTimer,
    });
  }

  function releaseOwnership(hubSessionId) {
    const ownership = ownershipByHubSession.get(hubSessionId);
    if (!ownership) return false;
    ownershipByHubSession.delete(hubSessionId);
    if (ownership.leaseTimer) clearInterval(ownership.leaseTimer);
    return registry.release(ownership.researchSessionId, ownership.leaseToken);
  }

  function releaseAllOwnership() {
    for (const hubSessionId of [...ownershipByHubSession.keys()]) releaseOwnership(hubSessionId);
  }

  function publicSession(record) {
    if (!record) return null;
    const live = record.hubSessionId && sessionManager ? sessionManager.getSession(record.hubSessionId) : null;
    const lease = registry.lease(record.researchSessionId);
    const busyElsewhere = !!(lease && !live);
    return {
      ...record,
      live: !!live,
      busyElsewhere,
      status: live
        ? (live.status || record.status || 'idle')
        : (busyElsewhere ? 'running_elsewhere' : 'restorable'),
      hubSessionId: live ? live.id : (record.hubSessionId || ''),
      nativeSession: live ? { ...(record.nativeSession || {}), ...nativeSessionMeta(live) } : (record.nativeSession || {}),
    };
  }

  function isAuthorizedResearchScope(scopeId) {
    const value = String(scopeId || '');
    if (!value.startsWith('chuxin-')) return false;
    const researchSessionId = value.slice('chuxin-'.length);
    if (!registry.get(researchSessionId)) return false;
    return !!registry.lease(researchSessionId);
  }

  function researchMcpOptions(kind, researchSessionId) {
    const options = {};
    const hookPort = Number(getHookPort() || 0);
    if (!hookPort) return options;
    const hubDataDir = getHubDataDir();
    const scopeId = `chuxin-${researchSessionId}`;
    if (kind === 'claude') {
      options.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, scopeId, hookPort, hookToken, kind);
    } else if (kind === 'codex') {
      options.codexBypassApprovals = true;
      addCodexMcpEntry(options, scenes.buildResearchMcpEntryForCodex(scopeId, hookPort, hookToken, hubDataDir));
    } else if (kind === 'kimi') {
      // Kimi Code auto-discovers chuxin-research/.kimi-code/mcp.json from cwd.
      options.extraEnv = {
        ARENA_MEETING_ID: scopeId,
        ARENA_HUB_PORT: String(hookPort),
        ARENA_HOOK_TOKEN: hookToken,
        ARENA_AI_KIND: 'kimi',
        ARENA_HUB_DATA_DIR: hubDataDir,
      };
    }
    return options;
  }

  function createNativeSession({ researchSessionId, kind, model, title, resume = null, purpose, hiddenFromSidebar }) {
    if (!sessionManager) throw new Error('session-manager-unavailable');
    const options = {
      cwd: CHUXIN_DIR,
      title,
      model,
      userRenamed: true,
      purpose,
      hiddenFromSidebar,
      researchSessionId,
      ...researchMcpOptions(kind, researchSessionId),
      ...(resume || {}),
    };
    const session = sessionManager.createSession(kind, options);
    registerSessionForTap(session);
    sendToRenderer('session-created', { session });
    return session;
  }

  function findLiveResearchSession(researchSessionId) {
    if (!sessionManager) return null;
    return sessionManager.listSessions().find((row) => row.researchSessionId === researchSessionId) || null;
  }

  ipcMain.handle('chuxin:status', async () => {
    const health = await httpGetJson(`${API_BASE}/health`, 2000);
    const online = !!(health.ok && health.body && health.body.status === 'ok');
    const web = await httpGetJson(`${WEB_BASE}/`, 2000);
    return {
      online,
      web_online: !!web.ok,
      api_base: API_BASE,
      web_base: WEB_BASE,
      chuxin_dir: CHUXIN_DIR,
      health: online ? health.body : null,
      error: online ? null : (health.error || `HTTP ${health.status}`),
    };
  });

  ipcMain.handle('chuxin:start-service', async () => {
    const before = await httpGetJson(`${API_BASE}/health`, 1500);
    if (before.ok && before.body && before.body.status === 'ok') return { started: false, already_running: true, healthy: true };
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(CHUXIN_DIR, 'run.ps1')], {
        cwd: CHUXIN_DIR,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // Register lifecycle listeners before touching streams. A launcher can
      // fail in a few milliseconds (for example, a port conflict); attaching
      // after data listeners creates a rare missed-exit race and leaves the UI
      // waiting for the full health timeout.
      const exited = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.once('exit', (code, signal) => finish({ code, signal }));
        child.once('error', (error) => finish({ code: null, signal: null, error }));
        if (child.exitCode !== null) finish({ code: child.exitCode, signal: child.signalCode });
      });
      const stdout = [];
      const stderr = [];
      const collect = (target) => (chunk) => {
        target.push(chunk.toString('utf8'));
        if (target.join('').length > 12000) target.splice(0, target.length - 1);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      const ready = await Promise.race([
        waitHealthy(45000),
        exited.then(async (exit) => {
          // run.ps1 exits after its own health checks. Recheck once to avoid a
          // harmless exit/health race; otherwise return its actual stderr.
          await new Promise((resolve) => setTimeout(resolve, 250));
          const health = await httpGetJson(`${API_BASE}/health`, 2000);
          if (health.ok && health.body && health.body.status === 'ok') return { healthy: true, body: health.body };
          const launcherLine = [stderr.join(''), stdout.join('')]
            .flatMap((value) => value.split(/\r?\n/))
            .map((value) => value.trim())
            .find(Boolean);
          return {
            healthy: false,
            error: [launcherLine || (exit.error && exit.error.message), `launcher exit=${exit.code} signal=${exit.signal || ''}`]
              .filter(Boolean).join(' · ').slice(0, 1600),
          };
        }),
      ]);
      return {
        started: true,
        already_running: false,
        healthy: ready.healthy,
        pid: child.pid,
        error: ready.healthy ? null : (ready.error || '健康检查未通过'),
        logs: {
          launcher: path.join(CHUXIN_DIR, 'logs', 'launcher.log'),
          api: path.join(CHUXIN_DIR, 'logs', 'api.stderr.log'),
          frontend: path.join(CHUXIN_DIR, 'logs', 'frontend.stderr.log'),
        },
      };
    } catch (error) {
      return { started: false, already_running: false, healthy: false, error: error.message };
    }
  });

  // ---------------------------------------------------------------- 作手林铛的每日决策会话
  //
  // 林铛每天 08:30 的决策本来就跑在一个真实的 Claude 会话里（chuxin 后端自己起的，
  // 不依赖 Hub 在不在）。以前这个会话既没被记录也没被展示，看上去像不存在。
  // 现在 chuxin 的 /api/lindang/status 会把会话身份透出来，这里把它收进注册表，
  // 用户点一下就恢复成一个**普通的、可见于左侧栏的**会话，可以直接接着追问。
  //
  // 刻意不做的事：不预先把它们全部拉起来。一个会话就是一个 claude 进程，
  // 为了让侧边栏好看而常驻七个进程不划算——点开才起，这也是 Hub 对休眠会话的既有做法。
  const LINDANG_PURPOSE = 'lindang-decision';

  function lindangRegistryId(runId) {
    return `lindang-${String(runId || '').replace(/[^A-Za-z0-9-]/g, '')}`.slice(0, 64);
  }

  async function lindangRuns() {
    const status = await httpGetJson(`${API_BASE}/api/lindang/status`, 4000);
    if (!status.ok || !status.body) return { ok: false, error: status.error || `HTTP ${status.status}` };
    const runs = Array.isArray(status.body.runs) ? status.body.runs : [];
    return { ok: true, runs };
  }

  function adoptLindangRun(run) {
    const session = run && run.session ? run.session : null;
    const ccSessionId = session && String(session.session_id || '');
    if (!ccSessionId) return null;
    const started = String(run.started_at || '');
    const day = started.slice(0, 10) || String(run.run_id || '').slice(0, 8);
    const registryId = lindangRegistryId(run.run_id);
    return registry.upsert(registryId, {
      provider: String(session.provider || 'claude-cli'),
      kind: String(session.provider || '').startsWith('codex') ? 'codex' : 'claude',
      model: String(run.model || ''),
      title: `作手林铛 · ${day}`,
      purpose: LINDANG_PURPOSE,
      lindangRunId: String(run.run_id || ''),
      lindangStatus: String(run.status || ''),
      lindangSummary: String(run.summary || ''),
      nativeSession: { ccSessionId, transcriptPath: String(session.transcript || '') },
    });
  }

  ipcMain.handle('chuxin:lindang-sessions', async () => {
    const outcome = await lindangRuns();
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const rows = [];
    for (const run of outcome.runs) {
      const record = adoptLindangRun(run);
      if (record) rows.push(publicSession(record));
    }
    return { ok: true, sessions: rows };
  });

  ipcMain.handle('chuxin:open-lindang-session', (_event, input = {}) => {
    try {
      const registryId = lindangRegistryId(String(input.runId || ''));
      const record = registry.get(registryId);
      if (!record) return { ok: false, error: 'not-found', message: '还没采纳这次决策的会话，先刷新一下列表。' };
      const live = findLiveResearchSession(record.researchSessionId);
      if (live) return { ok: true, session: live, reused: true };
      const resume = resumeOptions(record);
      if (!resume) return { ok: false, error: 'no-native-session', message: '这次决策没有留下可恢复的原生会话。' };
      const ownership = claimOwnership(record.researchSessionId);
      if (!ownership.ok) {
        return { ok: false, error: 'session-busy', message: '这个决策会话正在另一个 Hub 里打开。' };
      }
      let session;
      try {
        session = createNativeSession({
          researchSessionId: record.researchSessionId,
          kind: record.kind,
          model: record.model,
          title: record.title,
          resume,
          purpose: LINDANG_PURPOSE,
          hiddenFromSidebar: false,   // 这一条就是「出现在左侧栏」
        });
      } catch (error) {
        if (ownership.leaseTimer) clearInterval(ownership.leaseTimer);
        registry.release(record.researchSessionId, ownership.token);
        throw error;
      }
      bindOwnership(session.id, record.researchSessionId, ownership);
      registry.upsert(record.researchSessionId, { hubSessionId: session.id, status: 'idle', ownerPid: process.pid });
      return { ok: true, session, reused: false };
    } catch (error) {
      return { ok: false, error: 'open-failed', message: error.message };
    }
  });

  if (sessionManager && typeof sessionManager.on === 'function') {
    sessionManager.on('session-exited', (event = {}) => {
      const ownership = ownershipByHubSession.get(event.sessionId);
      releaseOwnership(event.sessionId);
      if (ownership) {
        registry.upsert(ownership.researchSessionId, { status: 'restorable', ownerPid: null });
      }
    });
  }

  return { isAuthorizedResearchScope, releaseAllOwnership, registry, ownershipByHubSession };
}

module.exports = {
  nativeSessionMeta,
  registerChuxinIpc,
  resumeOptions,
};
