'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout.js');
const {
  collectSourceDescriptors,
  createMetadataMaps,
  matchCodexHubSession,
  parseCodexRolloutStreaming,
  parseSourceDescriptor,
  readBoundedJsonlTailText,
  titleOnlySources,
} = require('../core/session-search-sources.js');

test('bounded JSONL reads discard a partial head record and preserve recent tail records', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-bounded-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({ marker: 'HEAD_ONLY', text: 'x'.repeat(700_000) })}\n${JSON.stringify({ marker: 'TAIL_ONLY' })}\n`, 'utf8');
  const result = readBoundedJsonlTailText(filePath, 256 * 1024);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.raw, /HEAD_ONLY/);
  assert.match(result.raw, /TAIL_ONLY/);
});

test('bounded JSONL reads decode only bytes actually returned by a short read', () => {
  const safeBytes = Buffer.from('partial-record\n{"marker":"SAFE_SHORT_READ"}\n', 'utf8');
  let reads = 0;
  const fsRef = {
    statSync: () => ({ size: 700_000 }),
    openSync: () => 1,
    readSync: (_fd, target, offset) => {
      if (reads++ > 0) return 0;
      safeBytes.copy(target, offset);
      return safeBytes.length;
    },
    closeSync() {},
  };
  const result = readBoundedJsonlTailText('fixture.jsonl', 256 * 1024, fsRef);
  assert.equal(result.raw, '{"marker":"SAFE_SHORT_READ"}\n');
  assert.doesNotMatch(result.raw, /\uFFFD/);
});

test('Codex native SID matching never guesses across multiple profile roots', () => {
  const sid = 'shared-native-sid';
  const maps = createMetadataMaps({ sessions: [
    { hubId: 'main', kind: 'codex', codexSid: sid, codexSessionsRoot: 'C:\\codex-main\\sessions' },
    { hubId: 'second', kind: 'codex', codexSid: sid, codexSessionsRoot: 'C:\\codex-second\\sessions' },
  ] });
  assert.equal(
    matchCodexHubSession('C:\\unknown\\rollout.jsonl', sid, 'C:\\unknown\\sessions', maps),
    null,
  );
  assert.equal(
    matchCodexHubSession('C:\\codex-second\\sessions\\rollout.jsonl', sid, 'C:\\codex-second\\sessions', maps).hubId,
    'second',
  );
});

function claudeRow(type, uuid, timestamp, content, cwd) {
  return JSON.stringify({
    type, uuid, timestamp, ...(cwd ? { cwd } : {}),
    message: type === 'assistant'
      ? { model: 'claude-sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }
      : { content },
  });
}

test('source adapters unify Claude, Codex and meeting timelines with Hub titles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-search-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const claudeProject = path.join(claudeRoot, 'C--repo');
  const codexRoot = path.join(root, '.codex', 'sessions');
  const meetingDir = path.join(root, 'hub-data', 'meetings');
  fs.mkdirSync(claudeProject, { recursive: true });
  fs.mkdirSync(meetingDir, { recursive: true });

  const claudeSid = 'claude-search-1';
  const claudePath = path.join(claudeProject, `${claudeSid}.jsonl`);
  fs.writeFileSync(claudePath, [
    claudeRow('user', 'cu1', '2026-08-20T10:00:00Z', '用户提问：公式为什么坏了', 'C:\\repo'),
    claudeRow('assistant', 'ca1', '2026-08-20T10:00:01Z', 'Claude 回答：修复 Markdown guard'),
  ].join('\n') + '\n', 'utf8');

  const codexSid = '11111111-1111-7111-8111-111111111111';
  const fakeCodex = new FakeCodexRollout({ sessionsRoot: codexRoot, cwd: 'C:\\repo', sid: codexSid });
  await fakeCodex.start();
  await fakeCodex.writeRaw({ timestamp: '2026-08-21T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Codex 用户问题：路径识别' } });
  await fakeCodex.writeTaskStarted({ at: new Date('2026-08-21T10:00:01Z') });
  await fakeCodex.writeAgentMessage('CODEX_INTERMEDIATE_MARKER 正在检查路径规则', { at: new Date('2026-08-21T10:00:01.500Z') });
  await fakeCodex.writeTaskComplete('Codex 最终回答：统一 openPathInHub', 1000, { at: new Date('2026-08-21T10:00:02Z') });
  await fakeCodex.writeRaw({ timestamp: '2026-08-21T10:00:03Z', type: 'response_item', payload: { item: { type: 'command_execution', command: 'node tests/path.test.js', cwd: 'C:\\repo' } } });
  await fakeCodex.close();
  const streamedCodex = parseCodexRolloutStreaming(fakeCodex.rolloutPath);
  assert.ok(streamedCodex.turns.some(turn => turn.role === 'user' && /路径识别/.test(turn.text)));
  assert.ok(streamedCodex.turns.some(turn => turn.role === 'assistant' && /openPathInHub/.test(turn.text)));
  assert.ok(streamedCodex.toolDocs.some(doc => /path\.test\.js/.test(doc.text)));

  const meetingId = 'meeting-search-1';
  fs.writeFileSync(path.join(meetingDir, `${meetingId}.json`), JSON.stringify({
    schemaVersion: 2, id: meetingId, title: '群聊公式评审', workspace: 'C:\\repo',
    subSessions: ['member-codex'], updatedAt: Date.parse('2026-08-22T10:00:00Z'),
    _timeline: [
      { idx: 0, sid: 'user', text: '群聊用户问题：公式渲染', ts: Date.parse('2026-08-22T10:00:00Z') },
      { idx: 1, sid: 'member-codex', text: '群聊回答：采用两层 guard', ts: Date.parse('2026-08-22T10:00:01Z') },
    ],
  }), 'utf8');

  const snapshot = {
    sessions: [
      { hubId: 'hub-claude', kind: 'claude', title: 'Claude 自定义标题', ccSessionId: claudeSid, transcriptPath: claudePath, cwd: 'C:\\repo' },
      { hubId: 'hub-codex', kind: 'codex', title: 'Codex 自定义标题', codexSid, codexSessionsRoot: codexRoot, transcriptPath: fakeCodex.rolloutPath, cwd: 'C:\\repo' },
      { hubId: 'member-codex', kind: 'codex', title: '评审员 Codex', meetingId, codexSid: 'meeting-member' },
      { hubId: 'title-only', kind: 'claude', title: '只存在于 Hub 的标题', cwd: 'C:\\orphan', lastOutputPreview: '最后一次回答摘要' },
    ],
    meetings: [{ id: meetingId, title: '群聊公式评审', workspace: 'C:\\repo', subSessions: ['member-codex'] }],
  };

  const collected = collectSourceDescriptors({ claudeRoots: [claudeRoot], codexRoots: [codexRoot], meetingDir }, snapshot);
  assert.equal(collected.descriptors.length, 3);
  const sources = collected.descriptors.map(descriptor => parseSourceDescriptor(descriptor, collected.maps));
  const claude = sources.find(source => source.session.provider === 'claude');
  const codex = sources.find(source => source.session.provider === 'codex');
  const meeting = sources.find(source => source.session.provider === 'meeting');
  assert.equal(claude.session.title, 'Claude 自定义标题');
  assert.equal(claude.session.updatedAt, Date.parse('2026-08-20T10:00:01Z'));
  assert.ok(claude.docs.some(doc => doc.scope === 'user' && /公式/.test(doc.text)));
  assert.equal(codex.session.title, 'Codex 自定义标题');
  assert.ok(codex.docs.some(doc => doc.scope === 'assistant' && /openPathInHub/.test(doc.text)));
  assert.ok(codex.docs.some(doc => doc.scope === 'assistant' && /CODEX_INTERMEDIATE_MARKER/.test(doc.text)));
  assert.ok(codex.docs.some(doc => doc.scope === 'tool' && /path\.test\.js/.test(doc.text)));
  assert.equal(meeting.session.meetingId, meetingId);
  assert.ok(meeting.docs.some(doc => doc.speaker === '评审员 Codex' && /两层 guard/.test(doc.text)));

  const representedHubIds = new Set(sources.map(source => source.session.hubSessionId).filter(Boolean));
  const representedMeetingIds = new Set(sources.map(source => source.session.meetingId).filter(Boolean));
  const titleOnly = titleOnlySources(collected.maps, representedHubIds, representedMeetingIds);
  assert.equal(titleOnly.length, 1);
  assert.equal(titleOnly[0].session.hubSessionId, 'title-only');
  assert.ok(titleOnly[0].docs.some(doc => doc.scope === 'assistant' && /最后一次回答摘要/.test(doc.text)));
});
