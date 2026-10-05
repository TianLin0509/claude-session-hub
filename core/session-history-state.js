'use strict';

// PTY startup output and welcome suggestions are not submitted user prompts.
function hasSubmittedPrompt(session) {
  return [session?.runStartedAt, session?.lastRunStartedAt,
    session?._attentionClock?.lastPromptAt].some(at => Number(at) > 0);
}

function isFreshSession(session) {
  return !!session && !hasSubmittedPrompt(session)
    && !session.codexSid && !session.ccSessionId && !session.transcriptPath
    && !session.codexAllowMtimeFallback && !String(session.kind || '').endsWith('-resume');
}

module.exports = { hasSubmittedPrompt, isFreshSession };
