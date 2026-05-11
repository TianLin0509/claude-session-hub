const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const tapSrc = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');

assert.ok(
  mainSrc.includes("parseCodexRolloutToTurns"),
  'parse-session-transcript must route Codex sessions through the Codex rollout parser',
);
assert.ok(
  mainSrc.includes("findCodexRolloutBySid"),
  'parse-session-transcript must recover persisted Codex sessions by codexSid',
);
assert.ok(
  mainSrc.includes("findCodexRolloutByCwd"),
  'parse-session-transcript must recover Codex resume sessions without codexSid by cwd + mtime',
);
assert.ok(
  mainSrc.includes("kind === 'codex' || kind === 'codex-resume'"),
  'parse-session-transcript must branch for codex and codex-resume',
);
assert.ok(
  rendererSrc.includes("kind === 'codex'"),
  'renderer card history gate must allow Codex sessions',
);
assert.ok(
  rendererSrc.includes("isClaudeFamily(kind) || kind === 'codex' || kind === 'codex-resume'"),
  'renderer card history gate must preserve Claude support and add Codex',
);
assert.ok(
  rendererSrc.includes("scheduleCodexHistoryRetry"),
  'renderer must retry transient Codex rollout binding during resume',
);
assert.ok(
  tapSrc.includes("getCodexRolloutPath(hubSessionId)"),
  'TranscriptTap must expose the bound Codex rollout path to the IPC parser',
);
assert.ok(
  /transcriptPath:\s*entry\.rolloutPath/.test(tapSrc),
  'Codex turn-complete events must carry rollout path for immediate card append',
);

console.log('codex single-session card view contract ok');
