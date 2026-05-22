const PROMPT_LINE_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+(.+?)(?:\s*[│╯╰╭╮]+\s*)?$/;
const PROMPT_PREFIX_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+/;
const AI_MARKERS_RE = /[⏺●◉◐◑◒◓◔◕]/;
const SILENCE_MS = 2000;

function parseQuestionsFromLines(lines) {
  const questions = [];
  const seen = new Set();
  for (const raw of lines) {
    if (!raw) continue;
    if (AI_MARKERS_RE.test(raw)) continue;
    const m = raw.match(PROMPT_LINE_RE);
    if (!m) continue;
    const q = m[1].replace(/\s+$/, '').trim();
    if (q.length < 2) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    questions.push(q);
  }
  return questions;
}

function isWaitingForUser(lines) {
  if (!lines || lines.length === 0) return { waiting: false };
  let lastMeaningful = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = (lines[i] || '').trim();
    if (!L) continue;
    if (PROMPT_PREFIX_RE.test(L)) continue;
    const stripped = L.replace(AI_MARKERS_RE, '').trim();
    if (!stripped) continue;
    lastMeaningful = stripped;
    break;
  }
  if (!lastMeaningful) return { waiting: false };
  const tail = lines.slice(-12).join('\n');
  if (/\[y\/N\]|\[Y\/n\]|\(yes\/no\)/i.test(tail)) {
    return { waiting: true, reason: 'confirm', text: lastMeaningful };
  }
  const hasList = /(^|\n)\s*[1-9][.\)]\s+\S|(^|\n)\s*[①②③④⑤⑥⑦⑧⑨]/m.test(tail);
  const hasQWord = /\b(which|what|choose|select|option|pick)\b|哪个|哪一|请选择|请确认|选择|选 ?[一二三1-9]/i.test(tail);
  if (hasList && hasQWord) {
    return { waiting: true, reason: 'choice', text: lastMeaningful };
  }
  if (lastMeaningful.length < 200 && /[?？]\s*$/.test(lastMeaningful)) {
    return { waiting: true, reason: 'question', text: lastMeaningful };
  }
  return { waiting: false };
}

function createTerminalActivityMonitor({
  sessions,
  terminalCache,
  getActiveSessionId,
  renderSessionList,
  schedulePersist,
  updateStreamingIndicator,
  hasSemanticCardWorking,
}) {
  const silenceTimers = new Map();
  const dataCounters = new Map();

  function extractUserQuestions(sessionId) {
    const cached = terminalCache.get(sessionId);
    if (!cached || !cached.opened) return [];
    const buf = cached.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.trim()) lines.push(text);
    }
    return parseQuestionsFromLines(lines);
  }

  function extractTailLines(sessionId, count = 40) {
    const cached = terminalCache.get(sessionId);
    if (!cached || !cached.opened) return [];
    const buf = cached.terminal.buffer.active;
    const out = [];
    const start = Math.max(0, buf.length - count);
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      out.push(line.translateToString(true));
    }
    return out;
  }

  function getQuestionsSignature(sessionId) {
    const qs = extractUserQuestions(sessionId);
    return qs.length === 0 ? '' : qs[qs.length - 1].slice(0, 200);
  }

  function readTerminalPreview(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    const questions = extractUserQuestions(sessionId);
    if (questions.length === 0) return;

    const lastQ = questions[questions.length - 1];
    const newPreview = lastQ.length > 60 ? lastQ.substring(0, 58) + '…' : lastQ;

    if (session._previewFromTranscript) return;
    if (newPreview && newPreview !== session.lastOutputPreview) {
      session.lastOutputPreview = newPreview;
      renderSessionList();
      schedulePersist();
    }
  }

  function onTerminalOutput(sessionId, dataLen) {
    const session = sessions.get(sessionId);
    if (!session) return;

    dataCounters.set(sessionId, (dataCounters.get(sessionId) || 0) + dataLen);

    if (dataCounters.get(sessionId) > 200 && session.status !== 'running') {
      session.status = 'running';
      renderSessionList();
      updateStreamingIndicator(sessionId);
    }

    if (silenceTimers.has(sessionId)) clearTimeout(silenceTimers.get(sessionId));
    silenceTimers.set(sessionId, setTimeout(() => {
      silenceTimers.delete(sessionId);
      dataCounters.delete(sessionId);

      const wasRunning = session.status === 'running';
      if (wasRunning) {
        if (!hasSemanticCardWorking(session)) session.status = 'idle';
        updateStreamingIndicator(sessionId);
      }

      readTerminalPreview(sessionId);

      const lastStopMs = Date.now() - (session._lastStopHookTs || 0);
      if (session.lastOutputPreview && lastStopMs >= 5000) {
        const sig = getQuestionsSignature(sessionId);
        const prev = session.readSignature || '';
        if (sig !== prev) {
          session.lastMessageTime = Date.now();
          session.readSignature = sig;
          if (sessionId !== getActiveSessionId()) {
            session.unreadCount = (session.unreadCount || 0) + 1;
          }
        }
      }

      renderSessionList();
    }, SILENCE_MS));
  }

  function clearSession(sessionId) {
    if (silenceTimers.has(sessionId)) {
      clearTimeout(silenceTimers.get(sessionId));
      silenceTimers.delete(sessionId);
    }
    dataCounters.delete(sessionId);
  }

  return {
    extractUserQuestions,
    extractTailLines,
    getQuestionsSignature,
    readTerminalPreview,
    onTerminalOutput,
    isWaitingForUser,
    clearSession,
  };
}

module.exports = {
  PROMPT_LINE_RE,
  PROMPT_PREFIX_RE,
  AI_MARKERS_RE,
  parseQuestionsFromLines,
  isWaitingForUser,
  createTerminalActivityMonitor,
};
