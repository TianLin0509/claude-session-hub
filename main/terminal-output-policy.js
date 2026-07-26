'use strict';

function shouldForwardTerminalOutput(sessionManager, sessionId) {
  if (!sessionManager || typeof sessionManager.getSession !== 'function') return true;
  const session = sessionManager.getSession(sessionId);
  if (!session || !session.meetingId) return true;
  return sessionManager.focusedSessionId === sessionId;
}

module.exports = { shouldForwardTerminalOutput };
