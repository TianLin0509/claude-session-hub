'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dispatcherSrc = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const watcherSrc = fs.readFileSync(path.join(root, 'core', 'turn-completion-watcher.js'), 'utf8');

assert.ok(/CODEX_AUTO_EXTRACT_DELAY_MS\s*=\s*3\s*\*\s*1000/.test(dispatcherSrc),
  'Codex auto extract should wait 3s before probing the rollout');

assert.ok(/isCodexBaseKind\(waitKind\)\s*\|\|\s*isClaudeFamily\(waitKind\)/.test(dispatcherSrc),
  'auto extract fallback must cover the two primary group-chat runtimes');

assert.ok(/transcriptTap\.extractLatestTurn\(sid,\s*sincePromptTs\)/.test(dispatcherSrc),
  'auto extract must reuse the same transcript extraction path as manual extract');

assert.ok(/extractMode\s*===\s*['"]final_answer['"]/.test(dispatcherSrc),
  'auto extract must only settle on final_answer, not partial commentary');

assert.ok(/signalSource\s*=\s*isCodexFinal[\s\S]{0,160}codex_auto_extract_final_answer[\s\S]{0,160}claude_auto_extract_final_answer/.test(dispatcherSrc) &&
  /watcher\.completeFromTranscript\(extracted\.text,\s*signalSource\)/.test(dispatcherSrc),
  'auto extract should settle Claude/Codex with distinct authoritative signal sources');

// sincePromptTs 比真实提交时刻早 1s（容忍 CLI 写 rollout 的时钟偏差）。拿它当归属判据
//   会把「上一轮在这 1s 内完成的答案」认成本轮的——串行工作流步与步之间正好落在窗口里。
//   归属判据必须是真实提交时刻，且在拿到语义开工信号后进一步收紧。
assert.ok(/const promptSubmittedAt = Number\(opts\.promptSubmittedAt\) \|\| startTs;/.test(dispatcherSrc),
  'auto extract must know the real submit instant, not the clock-skew-padded search floor');
assert.ok(/const claudeAnswerFloor = Math\.max\(promptSubmittedAt, agentTurnStartedAt\);/.test(dispatcherSrc)
  && /Number\(extracted\.completedAt\)\s*>=\s*claudeAnswerFloor/.test(dispatcherSrc),
  'Claude fallback must reject a previous-turn transcript that predates this prompt');
assert.ok(!/Number\(extracted\.completedAt\)\s*>=\s*sincePromptTs/.test(dispatcherSrc),
  'the padded search floor must never be reused as the answer-ownership floor');

assert.ok(/if \(codexAutoExtractTimer\) clearInterval\(codexAutoExtractTimer\)/.test(dispatcherSrc),
  'auto extract timer must be cleared when the watcher settles');

assert.ok(/completeFromTranscript\(text,\s*signalSource\s*=\s*['"]auto_extract['"]\)/.test(watcherSrc),
  'turn-completion watcher must expose completeFromTranscript');

assert.ok(/status:\s*['"]completed['"][\s\S]{0,160}signalSource[\s\S]{0,160}completedAt:\s*Date\.now\(\)/.test(watcherSrc),
  'completeFromTranscript must produce a completed result, not manual_extracted');

console.log('Codex auto extract contract: ok');
