'use strict';

const { baseKind, sessionProviderFamily, nativeSessionIdentity } = require('./session-capabilities.js');

function nightGuardProvider(session) {
  if (!session || typeof session !== 'object') return null;
  // Protect actual Claude Code sessions. Pre-migration DeepSeek sessions also
  // use Claude internally, but their relaunch contract is different and must
  // not silently resume under Claude branding.
  if (baseKind(session.kind) === 'claude') return 'claude';
  // Codex includes ordinary Codex plus the current DeepSeek-on-Codex runtime.
  if (sessionProviderFamily(session) === 'codex') return 'codex';
  return null;
}

function nightGuardNativeIdentity(session) {
  const provider = nightGuardProvider(session);
  if (!provider) return null;
  const identity = nativeSessionIdentity(session);
  return identity && identity.family === provider ? identity : null;
}

function nightGuardProviderLabel(provider) {
  return provider === 'claude' ? 'Claude Code' : (provider === 'codex' ? 'Codex' : 'AI');
}

module.exports = {
  nightGuardNativeIdentity,
  nightGuardProvider,
  nightGuardProviderLabel,
};
