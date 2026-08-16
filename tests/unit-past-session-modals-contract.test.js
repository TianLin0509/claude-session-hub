const test = require('node:test');
const assert = require('node:assert');
const {
  highlightMatch,
  findReusableClaudeSession,
  nativeTranscriptSessionKey,
  collapseDormantNativeDuplicates,
} = require('../renderer/past-session-modals.js');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

test('highlightMatch escapes text and wraps case-insensitive hit', () => {
  assert.strictEqual(
    highlightMatch('Open <Report.md>', 'report', escapeHtml),
    'Open &lt;<mark>Report</mark>.md&gt;'
  );
});

test('highlightMatch returns escaped text when query is empty', () => {
  assert.strictEqual(highlightMatch('<script>', '', escapeHtml), '&lt;script&gt;');
});

test('resume picker reuses the live or newest dormant Hub shell for one Claude transcript', () => {
  const sessions = [
    { id: 'old', kind: 'claude', status: 'dormant', ccSessionId: 'cc-1', lastMessageTime: 10 },
    { id: 'new', kind: 'claude-resume', status: 'dormant', ccSessionId: 'cc-1', lastMessageTime: 20 },
    { id: 'other-kind', kind: 'codex', status: 'running', ccSessionId: 'cc-1', lastMessageTime: 30 },
  ];
  assert.strictEqual(findReusableClaudeSession(sessions, { sessionId: 'cc-1' }).id, 'new');

  sessions.push({ id: 'live', kind: 'claude', status: 'idle', transcriptPath: 'C:/Claude/one.jsonl', lastMessageTime: 1 });
  assert.strictEqual(
    findReusableClaudeSession(sessions, { path: 'c:\\claude\\ONE.jsonl' }).id,
    'live',
    'path comparison must be Windows-case-insensitive and slash-insensitive',
  );
});

test('native transcript identity consolidates only dormant duplicate shells and preserves UX metadata', () => {
  const map = new Map([
    ['old', { id: 'old', kind: 'kimi', status: 'dormant', kimiSid: 'kimi-1', title: '我的标题', userRenamed: true, pinned: true, unreadCount: 4, lastMessageTime: 10 }],
    ['new', { id: 'new', kind: 'kimi-resume', status: 'idle', kimiSid: 'kimi-1', title: 'Kimi Resume', pinned: false, unreadCount: 1, lastMessageTime: 20 }],
    ['meeting', { id: 'meeting', kind: 'kimi', status: 'dormant', kimiSid: 'kimi-1', meetingId: 'm1', lastMessageTime: 30 }],
  ]);
  assert.strictEqual(nativeTranscriptSessionKey(map.get('old')), 'kimi:kimi-1');
  const removed = collapseDormantNativeDuplicates(map);
  assert.deepStrictEqual(removed, [{ removedId: 'old', keptId: 'new' }]);
  assert.strictEqual(map.has('old'), false);
  assert.strictEqual(map.has('meeting'), true, 'meeting-scoped shells must never be collapsed');
  assert.strictEqual(map.get('new').title, '我的标题');
  assert.strictEqual(map.get('new').pinned, true);
  assert.strictEqual(map.get('new').unreadCount, 4);
});

test('two live PTYs with the same native id are reported but never auto-closed', () => {
  const map = new Map([
    ['a', { id: 'a', kind: 'codex', status: 'idle', codexSid: 'codex-1' }],
    ['b', { id: 'b', kind: 'codex-resume', status: 'running', codexSid: 'codex-1' }],
  ]);
  assert.deepStrictEqual(collapseDormantNativeDuplicates(map), []);
  assert.strictEqual(map.size, 2);
});

test('Codex native identity is profile-scoped so copied rollout SIDs are not merged', () => {
  const map = new Map([
    ['main', {
      id: 'main', kind: 'codex', status: 'dormant', codexSid: 'codex-shared',
      codexProfile: 'default', lastMessageTime: 10,
    }],
    ['second', {
      id: 'second', kind: 'codex-resume', status: 'dormant', codexSid: 'codex-shared',
      codexProfile: 'second', lastMessageTime: 20,
    }],
  ]);
  assert.notStrictEqual(
    nativeTranscriptSessionKey(map.get('main')),
    nativeTranscriptSessionKey(map.get('second')),
  );
  assert.deepStrictEqual(collapseDormantNativeDuplicates(map), []);
  assert.strictEqual(map.size, 2);
});

test('same-profile Codex duplicate collapse preserves resume metadata', () => {
  const map = new Map([
    ['older', {
      id: 'older', kind: 'codex', status: 'dormant', codexSid: 'codex-1',
      codexProfile: 'second', codexSessionsRoot: 'C:\\codex-second\\sessions',
      transcriptPath: 'C:\\codex-second\\sessions\\rollout.jsonl', mcpProfile: 'full',
      lastMessageTime: 10,
    }],
    ['newer', {
      id: 'newer', kind: 'codex-resume', status: 'dormant', codexSid: 'codex-1',
      codexProfile: 'second', lastMessageTime: 20,
    }],
  ]);
  assert.deepStrictEqual(collapseDormantNativeDuplicates(map), [
    { removedId: 'older', keptId: 'newer' },
  ]);
  assert.strictEqual(map.get('newer').codexSessionsRoot, 'C:\\codex-second\\sessions');
  assert.strictEqual(map.get('newer').transcriptPath, 'C:\\codex-second\\sessions\\rollout.jsonl');
  assert.strictEqual(map.get('newer').mcpProfile, 'full');
});

test('Gemini dormant shells use their native chat id for duplicate collapse', () => {
  const map = new Map([
    ['old-g', { id: 'old-g', kind: 'gemini-resume', geminiChatId: 'gemini-1', status: 'dormant', lastMessageTime: 1 }],
    ['new-g', { id: 'new-g', kind: 'gemini', geminiChatId: 'gemini-1', status: 'dormant', lastMessageTime: 2 }],
  ]);
  assert.strictEqual(nativeTranscriptSessionKey(map.get('old-g')), 'gemini:gemini-1');
  assert.deepStrictEqual(collapseDormantNativeDuplicates(map), [
    { removedId: 'old-g', keptId: 'new-g' },
  ]);
});
