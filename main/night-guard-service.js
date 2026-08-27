'use strict';

const path = require('path');
const { createNightGuardController } = require('../core/night-guard-controller.js');
const {
  CLAUDE_ENDPOINTS,
  CODEX_ENDPOINTS,
  createCurlConnectivityProbe,
  createFixtureConnectivityProbe,
} = require('../core/night-guard-network.js');
const { createNightGuardAuditWriter, inspectNightGuardRuntime } = require('../core/night-guard-runtime.js');
const { buildSessionResumeMeta } = require('../core/session-capabilities.js');
const { nightGuardNativeIdentity, nightGuardProvider } = require('../core/night-guard-provider.js');
const { registerNightGuardIpc } = require('./ipc/night-guard-handlers.js');

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

function canSubmitRecoveryEnter(controller, sessionId, incidentId) {
  return !!(controller && typeof controller.canSubmitRecoveryInput === 'function'
    && controller.canSubmitRecoveryInput(sessionId, incidentId));
}

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
  let fixtureProbe = null;
  if (env.CLAUDE_HUB_NIGHT_GUARD_FIXTURE) {
    try {
      fixtureProbe = createFixtureConnectivityProbe(JSON.parse(env.CLAUDE_HUB_NIGHT_GUARD_FIXTURE));
    } catch (error) {
      logger.warn('[night-guard] invalid fixture:', error && error.message);
    }
  }
  const providerProbes = fixtureProbe
    ? { claude: fixtureProbe, codex: fixtureProbe }
    : {
      claude: createCurlConnectivityProbe({ endpoints: CLAUDE_ENDPOINTS }),
      codex: createCurlConnectivityProbe({ endpoints: CODEX_ENDPOINTS }),
    };

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
    probeNetwork: input => (providerProbes[input.provider] || providerProbes.codex)(input),
    inspectRuntime: sessionId => {
      const session = getSession(sessionId);
      return inspectNightGuardRuntime(sessionManager, sessionId, nightGuardProvider(session));
    },
    continueLiveSession: async ({ sessionId, prompt, incidentId }) => {
      if (sessionManager.getSessionBuffer(sessionId) == null) return { ok: false, error: 'live-pty-missing' };
      const provider = nightGuardProvider(getSession(sessionId));
      if (!provider) return { ok: false, error: 'unsupported-provider' };
      sessionManager.writeToSession(
        sessionId,
        provider === 'claude' ? `${BP_START}${prompt}${BP_END}` : prompt,
      );
      const submitOnce = delay => {
        const timer = setTimeout(() => {
          if (canSubmitRecoveryEnter(controller, sessionId, incidentId)) {
            sessionManager.writeToSession(sessionId, '\r');
          }
        }, delay);
        timer.unref?.();
      };
      for (const delay of provider === 'claude' ? [700, 900, 1100] : [500, 700]) submitOnce(delay);
      return { ok: true };
    },
    resumeInPlace: async ({ sessionId, prompt }) => {
      const session = getSession(sessionId);
      const identity = nightGuardNativeIdentity(session);
      if (!identity) return { ok: false, error: 'native-session-id-missing' };
      return sessionManager.relaunchCli(sessionId, {
        resume: true,
        prompt,
        trigger: 'night-guard-resume',
      }) ? { ok: true } : { ok: false, error: 'managed-resume-rejected' };
    },
    resumeDormant: async ({ sessionId, prompt, session }) => {
      const source = session || getSession(sessionId);
      const identity = nightGuardNativeIdentity(source);
      if (!identity) return { ok: false, error: 'native-session-id-missing' };
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

module.exports = { canSubmitRecoveryEnter, createNightGuardService };
