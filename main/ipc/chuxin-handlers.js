'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const {
  MODEL_OPTIONS_BY_KIND,
  DEFAULT_MODEL_BY_KIND,
} = require('../../core/model-options.js');
const { ChuxinSessionRegistry } = require('../../core/chuxin-session-registry.js');
const scenes = require('../../core/group-chat-scenes.js');
const { waitCliReady, sendToPty } = require('../../core/group-chat-watcher.js');

const CHUXIN_DIR = process.env.CHUXIN_DIR || 'C:\\Users\\lintian\\chuxin-research';
const API_BASE = process.env.CHUXIN_API_BASE || 'http://127.0.0.1:3004';
const WEB_BASE = process.env.CHUXIN_WEB_BASE || 'http://127.0.0.1:3003';
const SAFE_WORKSPACE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROVIDERS = {
  'codex-cli': { kind: 'codex', label: 'Codex', mark: 'CX' },
  'claude-cli': { kind: 'claude', label: 'Claude', mark: 'CL' },
  'kimi-cli': { kind: 'kimi', label: 'Kimi', mark: 'KM' },
};
const CHUXIN_DEFAULT_MODEL_BY_KIND = {
  codex: 'gpt-5.6-sol',
  claude: 'claude-opus-4-8[1m]',
  kimi: 'kimi-code/k3',
};

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

function providerPresentation(provider, model) {
  const row = PROVIDERS[provider] || PROVIDERS['codex-cli'];
  const fallbackModel = CHUXIN_DEFAULT_MODEL_BY_KIND[row.kind] || DEFAULT_MODEL_BY_KIND[row.kind];
  return { ...row, provider, model: model || fallbackModel };
}

function modelCatalog() {
  return Object.entries(PROVIDERS).map(([provider, row]) => ({
    provider,
    kind: row.kind,
    name: row.label,
    mark: row.mark,
    defaultModel: CHUXIN_DEFAULT_MODEL_BY_KIND[row.kind] || DEFAULT_MODEL_BY_KIND[row.kind],
    models: (MODEL_OPTIONS_BY_KIND[row.kind] || []).map((item) => ({ ...item })),
  }));
}

function validateProviderModel(provider, model) {
  const row = PROVIDERS[provider];
  if (!row) return { ok: false, error: 'unsupported-provider' };
  const selected = model || CHUXIN_DEFAULT_MODEL_BY_KIND[row.kind] || DEFAULT_MODEL_BY_KIND[row.kind];
  if (!(MODEL_OPTIONS_BY_KIND[row.kind] || []).some((item) => item.id === selected)) {
    return { ok: false, error: 'unsupported-model', message: `模型 ${selected} 不在 Hub 的 ${row.label} 目录中。` };
  }
  return { ok: true, ...row, provider, model: selected };
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
  while (Date.now() < deadline) {
    const response = await httpGetJson(`${API_BASE}/health`, 2000);
    if (response.ok && response.body && response.body.status === 'ok') return { healthy: true, body: response.body };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { healthy: false };
}

function registerChuxinIpc(ipcMain, deps = {}) {
  const {
    registerSessionForTap = () => {},
    sendToRenderer = () => {},
    sessionManager = null,
    transcriptTap = null,
    getHubDataDir = () => process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.claude-session-hub'),
    getHookPort = () => 0,
    hookToken = '',
  } = deps;
  const registry = new ChuxinSessionRegistry();
  const pendingByHubSession = new Map();
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
        SPIRIT_REGISTRY_ROOT: process.env.SPIRIT_REGISTRY_ROOT || path.join(os.homedir(), 'spirit-lens-registry'),
      };
    }
    return options;
  }

  function createNativeSession({ researchSessionId, provider, kind, model, title, heroIds, taskId, policyVersion, resume = null }) {
    if (!sessionManager) throw new Error('session-manager-unavailable');
    const options = {
      cwd: CHUXIN_DIR,
      title,
      model,
      userRenamed: true,
      purpose: 'chuxin-research',
      hiddenFromSidebar: true,
      researchSessionId,
      chuxinTaskId: taskId || '',
      heroIds,
      promptPolicyVersion: policyVersion || '',
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

  function restoreRecord(record, taskMeta = {}) {
    const live = findLiveResearchSession(record.researchSessionId);
    if (live) return live;
    const resume = resumeOptions(record);
    if (!resume) throw new Error('该投研 Session 尚未取得原生会话 ID，不能跨 Hub 恢复。');
    return createNativeSession({
      researchSessionId: record.researchSessionId,
      provider: record.provider,
      kind: record.kind,
      model: record.model,
      title: record.title,
      heroIds: taskMeta.heroIds || record.heroIds || [],
      taskId: taskMeta.taskId || '',
      policyVersion: taskMeta.policyVersion || record.promptPolicyVersion || '',
      resume,
    });
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
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      const ready = await waitHealthy(25000);
      return { started: true, already_running: false, healthy: ready.healthy, pid: child.pid };
    } catch (error) {
      return { started: false, already_running: false, healthy: false, error: error.message };
    }
  });

  ipcMain.handle('chuxin:model-catalog', () => ({ ok: true, agents: modelCatalog() }));
  ipcMain.handle('chuxin:list-research-sessions', () => ({
    ok: true,
    sessions: registry.list().map(publicSession),
    registryRoot: registry.root,
  }));

  ipcMain.handle('chuxin:resume-research-session', (_event, input) => {
    try {
      const researchSessionId = typeof input === 'object' && input
        ? String(input.researchSessionId || '') : String(input || '');
      const proposedWorkspace = typeof input === 'object' && input ? String(input.workspace || '') : '';
      let record = registry.get(researchSessionId);
      if (!record) return { ok: false, error: 'not-found' };
      if (!record.workspace && SAFE_WORKSPACE_RE.test(proposedWorkspace)) {
        record = registry.upsert(researchSessionId, { workspace: proposedWorkspace });
      }
      const live = findLiveResearchSession(record.researchSessionId);
      if (live) return { ok: true, session: live, research: publicSession(record) };
      const ownership = claimOwnership(record.researchSessionId);
      if (!ownership.ok) {
        return { ok: false, error: 'session-busy', message: '这个投研 Session 正在另一 Hub 中运行；完成后可在这里恢复。' };
      }
      let session;
      try {
        session = restoreRecord(record);
      } catch (error) {
        if (ownership.leaseTimer) clearInterval(ownership.leaseTimer);
        registry.release(record.researchSessionId, ownership.token);
        throw error;
      }
      bindOwnership(session.id, record.researchSessionId, ownership);
      const updated = registry.upsert(record.researchSessionId, { hubSessionId: session.id, status: 'idle', ownerPid: process.pid });
      return { ok: true, session, research: publicSession(updated) };
    } catch (error) {
      return { ok: false, error: 'resume-failed', message: error.message };
    }
  });

  ipcMain.handle('chuxin:run-agent-task', async (_event, payload = {}) => {
    if (!sessionManager) return { ok: false, error: 'session-manager-unavailable' };
    const workspace = String(payload.workspace || '');
    const question = String(payload.question || '').trim();
    const heroIds = Array.isArray(payload.spiritIds) ? payload.spiritIds.map(String).slice(0, 4) : [];
    if (!SAFE_WORKSPACE_RE.test(workspace) || question.length < 2 || !heroIds.length) {
      return { ok: false, error: 'invalid-task', message: 'workspace、问题或英雄选择无效。' };
    }
    const requestedSessionId = String(payload.researchSessionId || '');
    let record = requestedSessionId ? registry.get(requestedSessionId) : null;
    let selection;
    if (record) {
      selection = validateProviderModel(record.provider, record.model);
    } else {
      selection = validateProviderModel(String(payload.provider || 'codex-cli'), String(payload.model || ''));
    }
    if (!selection.ok) return selection;
    const researchSessionId = record ? record.researchSessionId : registry.createId();
    let session = record ? findLiveResearchSession(researchSessionId) : null;
    if (session && pendingByHubSession.has(session.id)) {
      return { ok: false, error: 'session-busy', message: '这个投研 Session 的上一轮还没有结束。' };
    }
    let ownership = session ? ownershipByHubSession.get(session.id) : null;
    let ownershipBound = !!ownership;
    if (!ownership) {
      ownership = claimOwnership(researchSessionId);
      if (!ownership.ok) return { ok: false, error: 'session-busy', message: '这个投研 Session 正由另一个 Hub 占用。', lease: ownership.lease };
    }
    let task = null;
    try {
      const response = await httpJson('POST', `${API_BASE}/api/spirits/agent-tasks`, 20000, {
        question,
        mandate: payload.mandate || 'value_speculation',
        spirit_ids: heroIds,
        context: payload.context && typeof payload.context === 'object' ? payload.context : { type: 'free', data: {} },
        research_mode: payload.researchMode || 'auto',
        answer_provider: selection.provider,
        model: selection.model,
        session_bootstrapped: !!record,
        research_session_id: researchSessionId,
      }, { 'X-Chuxin-Workspace': workspace });
      if (!response.ok || !response.body || !response.body.ok) throw new Error(response.error || `Chuxin HTTP ${response.status}`);
      task = response.body;
      const runId = task.job.run_id;
      const prompt = task.prompt || {};
      const shortQuestion = question.replace(/\s+/g, ' ').slice(0, 26);
      const title = record && record.title ? record.title : `投研 · ${selection.label} · ${shortQuestion}`;
      if (!session && record) session = restoreRecord(record, { heroIds, taskId: runId, policyVersion: prompt.prompt_version });
      if (!session) {
        session = createNativeSession({
          researchSessionId,
          provider: selection.provider,
          kind: selection.kind,
          model: selection.model,
          title,
          heroIds,
          taskId: runId,
          policyVersion: prompt.prompt_version,
        });
      } else {
        sessionManager.updateSessionMeta(session.id, {
          chuxinTaskId: runId,
          heroIds,
          promptPolicyVersion: prompt.prompt_version,
        });
      }
      if (!ownershipBound) {
        bindOwnership(session.id, researchSessionId, ownership);
        ownershipBound = true;
      }
      record = registry.upsert(researchSessionId, {
        hubSessionId: session.id,
        title,
        kind: selection.kind,
        provider: selection.provider,
        model: selection.model,
        cwd: CHUXIN_DIR,
        workspace,
        status: 'running',
        ownerPid: process.pid,
        heroIds,
        promptPolicyVersion: prompt.prompt_version,
        lastQuestion: question,
        lastRunId: runId,
        nativeSession: { ...(record && record.nativeSession || {}), ...nativeSessionMeta(session) },
      });
      pendingByHubSession.set(session.id, {
        runId,
        workspace,
        researchSessionId,
        provider: selection.provider,
        model: selection.model,
        startedAt: Date.now(),
        prompt,
      });
      sendToRenderer('chuxin:task-started', { runId, session, research: publicSession(record), prompt });
      const ready = await waitCliReady(session.id, selection.kind, 60000);
      if (!ready) throw new Error(`${selection.label} CLI 在 60 秒内未就绪。`);
      const sent = await sendToPty(session.id, String(prompt.agent_input || prompt.rendered_prompt || ''), selection.kind);
      if (!sent) throw new Error('Prompt 写入 PTY 后未检测到提交活动。');
      return { ok: true, runId, session, research: publicSession(record), prompt };
    } catch (error) {
      if (task && task.job && task.job.run_id) {
        for (const [hubId, pending] of pendingByHubSession.entries()) {
          if (pending.runId === task.job.run_id) {
            pendingByHubSession.delete(hubId);
          }
        }
      }
      if (!ownershipBound && ownership && ownership.ok) {
        if (ownership.leaseTimer) clearInterval(ownership.leaseTimer);
        registry.release(researchSessionId, ownership.token);
      }
      if (record || ownershipBound) {
        registry.upsert(researchSessionId, { status: 'error', lastError: error.message });
      }
      return { ok: false, error: 'task-start-failed', message: error.message };
    }
  });

  if (transcriptTap && typeof transcriptTap.on === 'function') {
    transcriptTap.on('session-bound', (event = {}) => {
      const session = sessionManager && sessionManager.getSession(event.hubSessionId);
      if (!session || session.purpose !== 'chuxin-research' || !session.researchSessionId) return;
      registry.upsert(session.researchSessionId, {
        hubSessionId: session.id,
        nativeSession: { ...(registry.get(session.researchSessionId) || {}).nativeSession, ...nativeSessionMeta(session),
          ...(event.ccSessionId ? { ccSessionId: event.ccSessionId } : {}),
          ...(event.codexSid ? { codexSid: event.codexSid } : {}),
          ...(event.kimiSid ? { kimiSid: event.kimiSid } : {}),
          ...(event.sessionDir ? { kimiSessionDir: event.sessionDir } : {}),
          ...(event.rolloutPath || event.wirePath ? { transcriptPath: event.rolloutPath || event.wirePath } : {}),
        },
      });
    });

    transcriptTap.on('turn-complete', async (event = {}) => {
      const pending = pendingByHubSession.get(event.hubSessionId);
      if (!pending) return;
      pendingByHubSession.delete(event.hubSessionId);
      const session = sessionManager && sessionManager.getSession(event.hubSessionId);
      const native = { ...((registry.get(pending.researchSessionId) || {}).nativeSession || {}), ...nativeSessionMeta(session) };
      try {
        const response = await httpJson('POST', `${API_BASE}/api/spirits/agent-tasks/${encodeURIComponent(pending.runId)}/complete`, 30000, {
          markdown: String(event.text || ''),
          provider: pending.provider,
          model: pending.model,
          hub_session_id: event.hubSessionId,
          research_session_id: pending.researchSessionId,
          native_session: native,
          duration_ms: Number(event.durationMs || (Date.now() - pending.startedAt)),
          research_mcp_configured: true,
          tool_calls: [],
          usage: {},
        }, { 'X-Chuxin-Workspace': pending.workspace });
        if (!response.ok || !response.body || !response.body.ok) throw new Error(response.error || `Chuxin HTTP ${response.status}`);
        const record = registry.upsert(pending.researchSessionId, {
          hubSessionId: event.hubSessionId,
          status: 'idle',
          lastRunId: pending.runId,
          lastTurnAt: Date.now(),
          nativeSession: native,
        });
        sendToRenderer('chuxin:task-completed', {
          runId: pending.runId,
          sessionId: event.hubSessionId,
          research: publicSession(record),
          run: response.body.run,
        });
      } catch (error) {
        registry.upsert(pending.researchSessionId, { status: 'error', lastError: error.message, nativeSession: native });
        sendToRenderer('chuxin:task-failed', { runId: pending.runId, sessionId: event.hubSessionId, message: error.message });
      }
    });
  }

  if (sessionManager && typeof sessionManager.on === 'function') {
    sessionManager.on('session-exited', (event = {}) => {
      const pending = pendingByHubSession.get(event.sessionId);
      const ownership = ownershipByHubSession.get(event.sessionId);
      releaseOwnership(event.sessionId);
      if (pending) {
        pendingByHubSession.delete(event.sessionId);
        registry.upsert(pending.researchSessionId, {
          status: 'interrupted',
          lastError: '原生 CLI 在本轮完成前退出；可恢复 Session 后重新提问。',
        });
        sendToRenderer('chuxin:task-failed', {
          runId: pending.runId,
          sessionId: event.sessionId,
          message: '原生 CLI 在本轮完成前退出；Session 已保留，可恢复后重新提问。',
        });
      } else if (ownership) {
        registry.upsert(ownership.researchSessionId, { status: 'restorable', ownerPid: null });
      }
    });
  }

  return { isAuthorizedResearchScope, releaseAllOwnership, registry, ownershipByHubSession, pendingByHubSession };
}

module.exports = {
  CHUXIN_DEFAULT_MODEL_BY_KIND,
  modelCatalog,
  nativeSessionMeta,
  providerPresentation,
  registerChuxinIpc,
  resumeOptions,
  validateProviderModel,
};
