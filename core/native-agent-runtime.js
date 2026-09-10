'use strict';
const codex = require('./codex-native-runtime');
const claude = require('./claude-native-runtime');

function isNativeAgent(session) {
  return codex.isCodexSession(session) || session?.runtimeBackend === 'claude-stream-json';
}

function nativeRuntimeTruth(session) {
  return claude.isNativeClaude(session) ? claude.claudeRuntimeTruth(session) : codex.nativeRuntimeTruth(session);
}

// Renderer copies never restore transport-bound approval requests. Submission
// identities and the previous process owner remain available for reconciliation.
function persistNativeRuntime(session) {
  if (session?.runtimeBackend !== 'claude-stream-json') return codex.persistNativeRuntime(session);
  const runtime = session.nativeRuntime;
  return runtime ? { ...runtime, connection: 'disconnected', requests: [], waitingFlags: [], recoveryReady: false } : null;
}

module.exports = { isNativeAgent, persistNativeRuntime, nativeRuntimeTruth };
