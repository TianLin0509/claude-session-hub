'use strict';

const {
  attemptEventMatches,
  classifyProviderFailure,
  isAuthoritativeFinalSignal,
  normalizeProviderFamily,
} = require('./groupchat-attempt-protocol.js');

class GroupChatProviderAdapter {
  constructor(kind) {
    this.kind = kind || 'unknown';
    this.family = normalizeProviderFamily(kind);
  }

  match(attempt, event, options = {}) {
    return attemptEventMatches(attempt, event, {
      kind: this.kind,
      // Codex exposes a real turn id. Once an attempt has bound one, refusing
      // an unscoped completion is safer than attaching it to the wrong turn.
      requireProviderTurn: this.family === 'codex',
      ...options,
    });
  }

  completion(attempt, event = {}) {
    const identity = this.match(attempt, event);
    if (!identity.ok) return { accepted: false, reason: identity.reason, identity };
    const source = event.signalSource || '';
    if (attempt && !isAuthoritativeFinalSignal(this.kind, source)) {
      return { accepted: false, reason: 'non_final_signal', identity };
    }
    const text = String(event.text || '').trim();
    const failure = classifyProviderFailure({ text, fromAssistantText: true });
    if (failure) {
      return {
        accepted: true,
        status: 'errored',
        text,
        failure,
        reason: failure.code,
        identity,
      };
    }
    if (!text) {
      return {
        accepted: false,
        reason: 'terminal_without_final_text',
        awaitingFinalText: true,
        identity,
      };
    }
    return { accepted: true, status: 'completed', text, identity };
  }

  error(attempt, event = {}) {
    const identity = this.match(attempt, event, { requireProviderTurn: false });
    if (!identity.ok) return { accepted: false, reason: identity.reason, identity };
    const failure = classifyProviderFailure({
      reason: event.reason,
      message: event.message,
      errorInfo: event.errorInfo,
      force: true,
    });
    return {
      accepted: true,
      status: 'errored',
      text: String(event.text || ''),
      reason: failure.code,
      failure,
      identity,
    };
  }

  aborted(attempt, event = {}) {
    const identity = this.match(attempt, event, { requireProviderTurn: false });
    if (!identity.ok) return { accepted: false, reason: identity.reason, identity };
    return {
      accepted: true,
      status: 'interrupted',
      text: String(event.text || ''),
      reason: 'provider_aborted',
      identity,
    };
  }
}

function createGroupChatProviderAdapter(kind) {
  return new GroupChatProviderAdapter(kind);
}

module.exports = {
  GroupChatProviderAdapter,
  createGroupChatProviderAdapter,
};
