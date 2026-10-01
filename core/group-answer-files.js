'use strict';
// Group chat answers come from Markdown files, not from CLI transcripts
// (2026-09-30). Each member writes what it wants the group to see; the Hub
// reads the file whenever it changes — before or after an interruption, and
// whether or not the Hub dispatched that turn. Card states: content or none.
//
// Plain group chats: <data>/task-docs/<meetingId>/answers/turn-<n>/<memberId>/回答.md
// Delivery workflow turns reuse that step's delivery files (draft shown as 草稿).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const RECENT_TURNS = 30;
const SAFE = /^[a-zA-Z0-9_-]{1,255}$/;

// Legacy engines still extract answers from transcripts until their rooms migrate.
function legacyWorkflow(w) {
  if (!w || w.deliveryVersion === 1) return false;
  return w.fileFlowVersion === 2 || !!w.loop?.enabled || (!!w.enabled && (w.settingsVersion === 1 || (Array.isArray(w.steps) && w.steps.length > 0)));
}
// answerSource:'transcript' is a per-room escape hatch (not in the UI) and keeps
// the extraction machinery testable.
function enabled(meeting) { return !!meeting?.groupChat && meeting.answerSource !== 'transcript' && !legacyWorkflow(meeting.serialWorkflow); }

function plainEntry(dataDir, meetingId, turnNum, memberId) {
  if (!SAFE.test(String(meetingId)) || !SAFE.test(String(memberId)) || !Number.isSafeInteger(Number(turnNum))) throw new Error('回答文件路径身份无效');
  const dir = path.join(dataDir, 'task-docs', String(meetingId), 'answers', `turn-${Number(turnNum)}`, String(memberId));
  return { kind: 'plain', dir, ready: path.join(dir, '回答.md') };
}
function deliveryEntry(dataDir, meetingId, workflowRun, memberId) {
  const D = require('./delivery-workflow');
  const base = D.directory(dataDir, meetingId);
  const run = JSON.parse(fs.readFileSync(path.join(base, 'run.json'), 'utf8'));
  const step = run.id === workflowRun.runId ? run.steps[workflowRun.stepIndex] : null;
  if (!step) throw new Error('交付步骤不存在');
  const p = D.paths(base, run, step, memberId);
  return { kind: 'delivery', dir: p.dir, draft: p.draft, ready: p.ready, rework: p.rework, blocked: p.blocked };
}
/** The answer file(s) for one member in one dispatched turn. */
function entryFor({ dataDir, meetingId, turnNum, memberId, speaker, workflowRun }) {
  const base = workflowRun?.kind === 'delivery' ? deliveryEntry(dataDir, meetingId, workflowRun, memberId) : plainEntry(dataDir, meetingId, turnNum, memberId);
  return { ...base, memberId, speaker: speaker || memberId, at: Date.now() };
}
function instruction(entry) {
  if (entry.kind !== 'plain') return '';
  return `【本轮回答】把要发到群聊的完整回答写入 ${entry.ready}（UTF-8 Markdown），写完回读确认。群聊卡片只显示这个文件；之后要补充或更正，直接修改它。聊天里一句话说明已写好即可，不必重复全文。`;
}

function readText(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return '';
    // Drop BOM and the delivery ticket line; they are protocol, not content.
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/^<!-- hub-delivery:[0-9a-f]+ -->\r?\n/, '').trim();
  } catch { return ''; }
}
/** Current answer: { state: 'delivered'|'draft', outcome, text, hash } or null. */
function read(entry) {
  for (const [key, outcome] of [['ready', 'ready'], ['rework', 'rework'], ['blocked', 'blocked']]) {
    const text = entry[key] ? readText(entry[key]) : '';
    if (text) return { state: 'delivered', outcome, text, hash: crypto.createHash('sha256').update(text).digest('hex') };
  }
  const draft = entry.draft ? readText(entry.draft) : '';
  return draft ? { state: 'draft', outcome: null, text: draft, hash: crypto.createHash('sha256').update(draft).digest('hex') } : null;
}
function signature(entry) {
  return ['ready', 'rework', 'blocked', 'draft'].map(k => {
    if (!entry[k]) return '-';
    try { const st = fs.statSync(entry[k]); return `${st.size}:${st.mtimeMs}`; } catch { return '0'; }
  }).join('|');
}
/** Applies changed answer files of recent turns to the orchestrator. Returns true if anything changed. */
function reconcile(orch) {
  const byTurn = orch.state.answerFiles;
  if (!byTurn) return false;
  let changed = false;
  const turns = Object.keys(byTurn).map(Number).sort((a, b) => b - a).slice(0, RECENT_TURNS);
  for (const turnNum of turns) {
    for (const [sid, entry] of Object.entries(byTurn[turnNum] || {})) {
      // Skip unchanged files cheaply: size + mtime of every candidate path.
      const sig = signature(entry);
      if (sig === entry.sig) continue;
      const got = read(entry);
      if (got && orch.applyAnswerFile(turnNum, sid, got)) changed = true;
      entry.sig = sig;
    }
  }
  return changed;
}

module.exports = { enabled, legacyWorkflow, entryFor, instruction, read, reconcile, RECENT_TURNS };
