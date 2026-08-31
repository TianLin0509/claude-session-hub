'use strict';

// Provider-aware classifier for the *live PTY screen*.
//
// Raw byte activity is not a reliable AI-running signal: both Claude Code and
// Codex repaint idle footers/cursors. Conversely, transcript hooks can be late
// or missing while the terminal already shows that the CLI returned to its
// input box. This module only accepts strong, current-screen UI markers and is
// intentionally conservative when the frame is ambiguous.

const RUNTIME_RUNNING = 'running';
const RUNTIME_IDLE = 'idle';
const RUNTIME_WAITING = 'waiting';
const RUNTIME_UNKNOWN = 'unknown';
const RUNNING_ANIMATION_CONFIRM_MIN_MS = 200;
const RUNNING_ANIMATION_CONFIRM_MAX_MS = 3000;

// Treat only Codex's structured live status row as authoritative running
// evidence. A prose answer or documentation snippet may quote "esc to
// interrupt"; matching that text anywhere on screen would resurrect an idle
// session incorrectly. The active row is rendered with a provider marker and
// a small, known family of work verbs.
const CODEX_RUNNING_RE = /^\s*[\u2022\u23fa\u25cf\u25c9\u25d0-\u25d5]\s*(?:Working|Thinking|Running|Searching|Reading|Writing|Editing|Exploring|Generating|Pursuing\s+goal)\b.*\besc to interrupt\b/i;
const CODEX_PROMPT_RE = /^\s*[\u203a>]\s*(?:$|\S)/;
const CODEX_CONTEXT_RE = /\bContext\s+(?:\d+(?:\.\d+)?%\s*(?:left)?|window|left)/i;

const CLAUDE_FOOTER_RE = /shift\+tab to cycle|\? for shortcuts|bypass permissions on/i;
// Claude 2.1.251 may render either an empty prompt, a “Try …” placeholder, or
// the literal `<no suggestion>` after a completed turn.  All three are input
// ready when paired with the persistent footer; running markers still win
// because classifyClaude checks them first.
const CLAUDE_PROMPT_RE = /^\s*[>\u276f]\s*(?:$|Try\s+["\u201c]|<no suggestion>\s*$)/i;
const CLAUDE_ACTIVE_STATUS_RE = /^\s*[\u2722\u2731-\u273d\u00b7*]\s+[A-Za-z][A-Za-z0-9 '/&+.-]{0,60}(?:\u2026|\.\.\.)(?:\s*\([^)]*\))?\s*$/;
const CLAUDE_ACTIVE_TOOL_RE = /^\s*[\u25cf\u23fa]\s+(?:Reading|Running|Searching|Writing|Editing|Fetching|Calling|Thinking|Exploring|Generating)\b.*(?:\u2026|\.\.\.)/i;

const WAITING_PATTERNS = [
  /Enter to confirm\s*[\u00b7|]\s*Esc to cancel/i,
  /\[(?:y\/N|Y\/n)\]/,
  /Press Enter to confirm/i,
];

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map(line => String(line == null ? '' : line).replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''))
    .filter(line => line.length > 0)
    .slice(-80);
}

function observation(state, reason, evidence = '') {
  return {
    state,
    confidence: state === RUNTIME_UNKNOWN ? 'none' : 'strong',
    reason,
    evidence: String(evidence || '').trim().slice(0, 200),
  };
}

function firstMatchingLine(lines, matcher) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (matcher.test(lines[index])) return lines[index];
  }
  return '';
}

function waitingObservation(lines) {
  // Confirmation overlays live at the bottom of the current frame. Restricting
  // this search prevents an old trust/setup prompt that still occupies an
  // untouched row near the top from misclassifying a later completed turn.
  lines = lines.slice(-4);
  for (const pattern of WAITING_PATTERNS) {
    const hit = firstMatchingLine(lines, pattern);
    if (hit) return observation(RUNTIME_WAITING, 'interactive-confirmation', hit);
  }
  return null;
}

function classifyCodex(lines) {
  // A bottom-of-screen confirmation is even more specific than a working row:
  // the provider is blocked on the user, not actively generating. Check that
  // first, then let a structured live work row outrank the persistent prompt.
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;

  const runningLine = firstMatchingLine(lines.slice(-12), CODEX_RUNNING_RE);
  if (runningLine) return observation(RUNTIME_RUNNING, 'codex-interrupt-footer', runningLine);

  const promptLine = firstMatchingLine(lines, CODEX_PROMPT_RE);
  const contextLine = firstMatchingLine(lines, CODEX_CONTEXT_RE);
  if (promptLine && contextLine) {
    return observation(RUNTIME_IDLE, 'codex-input-ready', `${promptLine} | ${contextLine}`);
  }
  return observation(RUNTIME_UNKNOWN, 'codex-frame-ambiguous');
}

function classifyClaude(lines) {
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;

  const liveTail = lines.slice(-12);
  const interruptLine = firstMatchingLine(liveTail, /\besc to interrupt\b|ctrl\+b to run in background|running stop hooks/i);
  if (interruptLine) return observation(RUNTIME_RUNNING, 'claude-interrupt-footer', interruptLine);

  const statusLine = firstMatchingLine(liveTail, CLAUDE_ACTIVE_STATUS_RE)
    || firstMatchingLine(liveTail, CLAUDE_ACTIVE_TOOL_RE);
  if (statusLine) return observation(RUNTIME_RUNNING, 'claude-active-status', statusLine);

  const footerLine = firstMatchingLine(lines, CLAUDE_FOOTER_RE);
  const promptLine = firstMatchingLine(lines, CLAUDE_PROMPT_RE);
  if (footerLine && promptLine) {
    return observation(RUNTIME_IDLE, 'claude-input-ready', `${promptLine} | ${footerLine}`);
  }
  return observation(RUNTIME_UNKNOWN, 'claude-frame-ambiguous');
}

function classifyTerminalRuntime(kind, lines) {
  const normalized = normalizeLines(lines);
  const runtimeKind = String(kind || '').toLowerCase();
  if (runtimeKind === 'codex' || runtimeKind === 'codex-resume' || runtimeKind === 'deepseek') {
    return classifyCodex(normalized);
  }
  if (runtimeKind === 'claude' || runtimeKind === 'claude-resume' || runtimeKind === 'deepseek-claude') {
    return classifyClaude(normalized);
  }
  return observation(RUNTIME_UNKNOWN, 'unsupported-runtime');
}

// Confirm that a provider's active status row is actually animating instead of
// being a static leftover frame. Callers keep the tiny returned candidate on
// the session object; no polling, screenshots, or scrollback scans are needed.
function advanceRunningAnimationCandidate(candidate, runtime, observedAt = Date.now()) {
  const at = Number(observedAt) || Date.now();
  const reason = String(runtime && runtime.reason || '').trim();
  const evidence = String(runtime && runtime.evidence || '').trim();
  const isStrongRunning = runtime
    && runtime.state === RUNTIME_RUNNING
    && runtime.confidence === 'strong'
    && reason
    && evidence;
  if (!isStrongRunning) return { confirmed: false, candidate: null };

  const previous = candidate && typeof candidate === 'object' ? candidate : null;
  const previousAt = Number(previous && previous.firstObservedAt) || 0;
  const sameAnimation = previous
    && previous.reason === reason
    && at >= previousAt
    && at - previousAt <= RUNNING_ANIMATION_CONFIRM_MAX_MS;
  if (!sameAnimation) {
    return {
      confirmed: false,
      candidate: {
        reason,
        evidence,
        firstObservedAt: at,
        lastObservedAt: at,
      },
    };
  }

  const elapsed = at - previousAt;
  const frameChanged = evidence !== previous.evidence;
  if (frameChanged && elapsed >= RUNNING_ANIMATION_CONFIRM_MIN_MS) {
    return { confirmed: true, candidate: null };
  }
  return {
    confirmed: false,
    candidate: {
      ...previous,
      lastObservedAt: at,
    },
  };
}

module.exports = {
  RUNTIME_RUNNING,
  RUNTIME_IDLE,
  RUNTIME_WAITING,
  RUNTIME_UNKNOWN,
  RUNNING_ANIMATION_CONFIRM_MIN_MS,
  RUNNING_ANIMATION_CONFIRM_MAX_MS,
  advanceRunningAnimationCandidate,
  classifyTerminalRuntime,
  normalizeLines,
};
