const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-room.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'meeting-room-chat-flow.css'), 'utf8');
const CONDUCTOR = fs.readFileSync(path.join(ROOT, 'main', 'groupchat', 'committee-conductor.js'), 'utf8');

assert.match(JS, /const _committeeRunState = \{\};/, 'renderer must keep per-meeting committee run state');
assert.match(JS, /function _classifyCommitteeProgress\s*\(/, 'committee progress classifier must exist');
assert.match(JS, /function _renderCommitteeDashboard\s*\(/, 'committee dashboard renderer must exist');
assert.match(JS, /function _committeeAcceptedProgressText\s*\(/, 'committee dashboard must create immediate accepted feedback');
assert.match(JS, /function _extractCommitteeOutcome\s*\(/, 'committee dashboard must parse final receipt into outcome state');
assert.match(JS, /function _committeeVerboseMessageInfo\s*\(/, 'committee UI must classify raw JSON and machine prompts for compact rendering');
assert.match(JS, /function _recordCommitteeIssue\s*\(/, 'committee issue recorder must exist');
assert.match(JS, /ipcRenderer\.on\('committee-progress'[\s\S]*?_recordCommitteeProgress\(meetingId,\s*text,\s*data\)/, 'committee-progress must update dashboard state and forward structured data');
// 沉浸式实时富渲染（2026-06-13）：结构化事件 → 各官研判卡 / 裁决英雄行 / 复盘入口
assert.match(JS, /function _committeeRichHtml\s*\(/, 'committee dashboard must render structured rich cards');
assert.match(JS, /function _mergeCommitteeRich\s*\(/, 'committee dashboard must accumulate structured progress data');
assert.match(JS, /function _committeeAnalystCard\s*\(/, 'committee dashboard must render per-officer verdict cards');
assert.match(JS, /\$\{_committeeRichHtml\(display\)\}/, 'rich cards must be injected into the console render');
assert.match(JS, /data-committee-open-path="\$\{escapeHtml\(rich\.replayPath\)\}"/, 'rich render must expose immersive replay open action');
assert.match(JS, /triggerGroupChat[\s\S]*?_recordCommitteeProgress\(meeting\.id,\s*_committeeAcceptedProgressText\(opts\.userInput \|\| ''\)\)/, 'committee send path must update dashboard before backend progress');
assert.match(JS, /meeting && meeting\.scene === 'committee' && !opts\.pending[\s\S]*?_committeeVerboseMessageInfo\(message\)/, 'committee compact raw rendering must only affect settled committee messages');
assert.match(JS, /<details class="mr-committee-raw-log">/, 'committee raw JSON and machine prompts must be collapsed behind details');
assert.match(JS, /CLAUDE_HUB_E2E === '1'[\s\S]*?debugRenderGroupChatState/, 'raw-message E2E hook must be test-only');
assert.match(JS, /data-committee-copy-diagnostics/, 'dashboard must expose diagnostics copy action');
assert.match(JS, /data-committee-open-ledger/, 'dashboard must expose ledger action');
assert.match(JS, /data-committee-open-path/, 'dashboard outcome must expose direct artifact path actions');
assert.match(JS, /mr-committee-outcome/, 'dashboard must render a compact final outcome area');
assert.match(JS, /data-running="\$\{running \? '1' : '0'\}"/, 'dashboard must expose running state for heartbeat');
assert.match(JS, /超过 45 秒没有新进展/, 'dashboard heartbeat must surface stale progress guidance');
assert.match(JS, /meeting\.scene === 'committee' && meeting\.groupChat && _getGroupViewMode\(\) === 'chat'/, 'committee chat view must refresh dashboard on active events');

assert.match(CSS, /\.mr-committee-console\b/, 'dashboard shell styles must exist');
assert.match(CSS, /\.mr-committee-stages\b/, 'stage rail styles must exist');
assert.match(CSS, /\.mr-committee-seats\b/, 'seat state grid styles must exist');
assert.match(CSS, /\.mr-committee-events\b/, 'event history styles must exist');
assert.match(CSS, /\.mr-committee-issue\b/, 'issue guidance styles must exist');
assert.match(CSS, /\.mr-committee-outcome\b/, 'final outcome styles must exist');
assert.match(CSS, /\.mr-committee-raw-log\b/, 'committee raw log collapse styles must exist');
assert.match(CSS, /\.mr-committee-raw-body\b/, 'committee raw log body styles must exist');
assert.match(CSS, /\.mr-committee-stale-note\b/, 'stale progress guidance styles must exist');
assert.match(CSS, /@media \(max-width: 720px\)/, 'dashboard must include narrow viewport layout');

assert.match(
  CONDUCTOR,
  /buildCheckupOcrPrompt[\s\S]*?targetMemberIds:\s*\[seats\.chair\.memberId\][\s\S]*?silent:\s*true[\s\S]*?allowActiveExtend:\s*false/,
  'checkup OCR prompt must be dispatched silently so internal Read instructions stay out of the public chat'
);

// conductor 必须发结构化进度事件 + 持久化 transcript 生成沉浸式复盘
assert.match(CONDUCTOR, /stage:\s*'prep'/, 'conductor must emit structured prep event');
assert.match(CONDUCTOR, /stage:\s*'analyst'/, 'conductor must emit structured per-officer events');
assert.match(CONDUCTOR, /stage:\s*'challenge'/, 'conductor must emit structured challenge event');
assert.match(CONDUCTOR, /stage:\s*'verdict'/, 'conductor must emit structured verdict event');
assert.match(CONDUCTOR, /committee\.replay_gen[\s\S]*?'save'/, 'conductor must persist transcript + generate immersive replay');
assert.match(CONDUCTOR, /function reportToCard\s*\(/, 'conductor must shape analyst reports into cards');

console.log('committee dashboard UI contract ok');
