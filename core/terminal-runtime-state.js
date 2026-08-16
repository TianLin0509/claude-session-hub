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

const CODEX_RUNNING_RE = /\besc to interrupt\b/i;
const CODEX_PROMPT_RE = /^\s*[\u203a>]\s*(?:$|\S)/;
const CODEX_CONTEXT_RE = /\bContext\s+(?:\d+(?:\.\d+)?%\s*(?:left)?|window|left)/i;

const CLAUDE_FOOTER_RE = /shift\+tab to cycle|\? for shortcuts|bypass permissions on/i;
const CLAUDE_PROMPT_RE = /^\s*[>\u276f]\s*(?:$|Try\s+["\u201c])/i;
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
  lines = lines.slice(-5);
  for (const pattern of WAITING_PATTERNS) {
    const hit = firstMatchingLine(lines, pattern);
    if (hit) return observation(RUNTIME_WAITING, 'interactive-confirmation', hit);
  }
  return null;
}

function classifyCodex(lines) {
  const runningLine = firstMatchingLine(lines, CODEX_RUNNING_RE);
  if (runningLine) return observation(RUNTIME_RUNNING, 'codex-interrupt-footer', runningLine);

  const promptLine = firstMatchingLine(lines, CODEX_PROMPT_RE);
  const contextLine = firstMatchingLine(lines, CODEX_CONTEXT_RE);
  if (promptLine && contextLine) {
    return observation(RUNTIME_IDLE, 'codex-input-ready', `${promptLine} | ${contextLine}`);
  }
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;
  return observation(RUNTIME_UNKNOWN, 'codex-frame-ambiguous');
}

function classifyClaude(lines) {
  const interruptLine = firstMatchingLine(lines, /\besc to interrupt\b|ctrl\+b to run in background|running stop hooks/i);
  if (interruptLine) return observation(RUNTIME_RUNNING, 'claude-interrupt-footer', interruptLine);

  const statusLine = firstMatchingLine(lines, CLAUDE_ACTIVE_STATUS_RE)
    || firstMatchingLine(lines, CLAUDE_ACTIVE_TOOL_RE);
  if (statusLine) return observation(RUNTIME_RUNNING, 'claude-active-status', statusLine);

  const footerLine = firstMatchingLine(lines, CLAUDE_FOOTER_RE);
  const promptLine = firstMatchingLine(lines, CLAUDE_PROMPT_RE);
  if (footerLine && promptLine) {
    return observation(RUNTIME_IDLE, 'claude-input-ready', `${promptLine} | ${footerLine}`);
  }
  const waiting = waitingObservation(lines);
  if (waiting) return waiting;
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

module.exports = {
  RUNTIME_RUNNING,
  RUNTIME_IDLE,
  RUNTIME_WAITING,
  RUNTIME_UNKNOWN,
  classifyTerminalRuntime,
  normalizeLines,
};
