'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dispatcherSrc = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const watcherSrc = fs.readFileSync(path.join(root, 'core', 'turn-completion-watcher.js'), 'utf8');

assert.ok(/CODEX_AUTO_EXTRACT_DELAY_MS\s*=\s*3\s*\*\s*1000/.test(dispatcherSrc),
  'Codex auto extract should wait 3s before probing the rollout');

assert.ok(/isCodexBaseKind\(waitSession\?\.kind\)/.test(dispatcherSrc),
  'auto extract fallback must be Codex-family only');

assert.ok(/transcriptTap\.extractLatestTurn\(sid,\s*sincePromptTs\)/.test(dispatcherSrc),
  'auto extract must reuse the same transcript extraction path as manual extract');

assert.ok(/extractMode\s*===\s*['"]final_answer['"]/.test(dispatcherSrc),
  'auto extract must only settle on final_answer, not partial commentary');

assert.ok(/watcher\.completeFromTranscript\(extracted\.text,\s*['"]codex_auto_extract_final_answer['"]\)/.test(dispatcherSrc),
  'auto extract should settle the watcher as completed with a distinct signal source');

assert.ok(/if \(codexAutoExtractTimer\) clearInterval\(codexAutoExtractTimer\)/.test(dispatcherSrc),
  'auto extract timer must be cleared when the watcher settles');

assert.ok(/completeFromTranscript\(text,\s*signalSource\s*=\s*['"]auto_extract['"]\)/.test(watcherSrc),
  'turn-completion watcher must expose completeFromTranscript');

assert.ok(/status:\s*['"]completed['"][\s\S]{0,160}signalSource[\s\S]{0,160}completedAt:\s*Date\.now\(\)/.test(watcherSrc),
  'completeFromTranscript must produce a completed result, not manual_extracted');

console.log('Codex auto extract contract: ok');
