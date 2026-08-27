'use strict';

const path = require('path');
const { createNightGuardController } = require('../core/night-guard-controller.js');
const { createCurlConnectivityProbe, createFixtureConnectivityProbe } = require('../core/night-guard-network.js');
const { createNightGuardAuditWriter, inspectCodexRuntime } = require('../core/night-guard-runtime.js');
const { buildSessionResumeMeta } = require('../core/session-capabilities.js');
const { registerNightGuardIpc } = require('./ipc/night-guard-handlers.js');

function createNightGuardService(options = {}) {
  const {
    env = process.env,
    getConfig,
    getDataDir,
    getPersistedSessions = () => [],
    ipcMain,
    logger = console,
    resumeSession,
    sendToRenderer,
    sessionManager,
    sessionStore,
  } = options;
  if (!ipcMain || !sessionManager || !sessionStore || typeof resumeSession !== 'function') {
    throw new Error('night guard service dependencies are incomplete');
  }

  const auditPath = path.join(getDataDir(), 'diagnostics', 'night-guard.jsonl');
  let probe = null;
  if (env.CLAUDE_HUB_NIGHT_GUARD_FIXTURE) {
    try {
      probe = createFixtureConnectivityProbe(JSON.parse(env.CLAUDE_HUB_NIGHT_GUARD_FIXTURE));
    } catch (error) {
      logger.warn('[night-guard] invalid fixture:', error && error.message);
    }
  }
  if (!probe) probe = createCurlConnectivityProbe();

  const timingOverrides = env.CLAUDE_HUB_E2E === '1' && env.CLAUDE_HUB_NIGHT_GUARD_FAST === '1'
    ? {
      graceMs: 80,
      healthyRoundIntervalMs: 80,
      quietMs: 0,
      failedProbeBackoffMs: [100, 200],
      runtimeRetryMs: 100,
      submitAckMs: 3000,
      completionGraceMs: 100,
      goalCompletionFallbackMs: 500,
    }
    : {};

  function getSession(sessionId) {
    const live = sessionManager.getSession(sessionId);
    if (live) return live;
    const persistedSessions = getPersistedSessions();
    const persisted = Array.isArray(persistedSessions)
      ? persistedSessions.find(item => item && item.hubId === sessionId)
      : null;
    return persisted || sessionStore.loadSessionFile(sessionId) || null;
  }

  let controller = null;
  function persistState(sessionId, nightGuard) {
    let updated = sessionManager.updateSessionMeta(sessionId, { nightGuard });
    const persistedSessions = getPersistedSessions();
    const persisted = Array.isArray(persistedSessions)
      ? persistedSessions.find(item => item && item.hubId === sessionId)
      : null;
    if (persisted) {
      persisted.nightGuard = nightGuard;
      persisted.updatedAt = Date.now();
      if (!updated) updated = { ...persisted };
    }
    const authoritative = updated || getSession(sessionId);
    if (authoritative) {
      void sessionStore.markDirtyImmediate(sessionId, authoritative).catch(error => {
        logger.warn('[night-guard] per-session persist failed:', error && error.message);
      });
      sendToRenderer('session-updated', { session: authoritative });
    }
    sendToRenderer('night-guard-status', { sessionId, state: nightGuard });
    return authoritative;
  }

  controller = createNightGuardController({
    ...timingOverrides,
    getSession,
    updateSession: persistState,
    getProxy: () => {
      const config = getConfig();
      return config.proxy || env.HTTPS_PROXY || env.HTTP_PROXY || '';
    },
    probeNetwork: probe,
    inspectRuntime: sessionId => inspectCodexRuntime(sessionManager, sessionId),
    continueLiveSession: async ({ sessionId, prompt }) => {
      if (sessionManager.getSessionBuffer(sessionId) == null) return { ok: false, error: 'live-pty-missing' };
      sessionManager.writeToSession(sessionId, prompt);
      const submitOnce = delay => {
        const timer = setTimeout(() => sessionManager.writeToSession(sessionId, '\r'), delay);
        timer.unref?.();
      };
      submitOnce(500);
      submitOnce(700);
      return { ok: true };
    },
    resumeInPlace: async ({ sessionId, prompt }) => {
      const session = getSession(sessionId);
      if (!session || !session.codexSid) return { ok: false, error: 'codex-sid-missing' };
      return sessionManager.relaunchCli(sessionId, {
        resume: true,
        prompt,
        trigger: 'night-guard-resume',
      }) ? { ok: true } : { ok: false, error: 'managed-resume-rejected' };
    },
    resumeDormant: async ({ sessionId, prompt, session }) => {
      const source = session || getSession(sessionId);
      if (!source || !source.codexSid) return { ok: false, error: 'codex-sid-missing' };
      const meta = buildSessionResumeMeta(source, {
        hubId: sessionId,
        nightGuard: controller.getStatus(sessionId),
        nightGuardRecoveryPrompt: prompt,
      });
      const resumed = await resumeSession(meta);
      return resumed ? { ok: true, session: resumed } : { ok: false, error: 'resume-failed' };
    },
    audit: createNightGuardAuditWriter(auditPath, { logger }),
    logger,
  });

  registerNightGuardIpc(ipcMain, { controller, auditPath });
  return { controller, auditPath, getSession };
}

module.exports = { createNightGuardService };
