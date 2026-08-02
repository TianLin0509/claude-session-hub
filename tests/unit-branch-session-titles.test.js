'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildBranchSessionTitle,
  healPersistedBranchSessionTitles,
  readCodexForkedFromId,
} = require('../core/branch-session-titles.js');

test('the title currently visible in renderer wins over stale backend metadata', () => {
  assert.deepEqual(buildBranchSessionTitle({
    rendererTitle: '用户看到的父会话名',
    source: { title: 'Codex 2' },
  }), {
    sourceTitle: '用户看到的父会话名',
    title: '分支: 用户看到的父会话名',
    branchAutoTitlePending: false,
    autoTitleGenerated: true,
  });
});

test('a generic group member inherits the original meeting title', () => {
  assert.equal(buildBranchSessionTitle({
    source: { title: 'Codex 2' },
    meeting: { title: '通道重构与多阵子驱动' },
  }).title, '分支: 通道重构与多阵子驱动');
});

test('a generic standalone parent never becomes the final branch title', () => {
  assert.deepEqual(buildBranchSessionTitle({ source: { title: 'Codex 2' } }), {
    sourceTitle: '',
    title: '分支: 待命名',
    branchAutoTitlePending: true,
    autoTitleGenerated: false,
  });
});

test('Codex fork ancestry heals a legacy branch to its original meeting name', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-title-'));
  try {
    const transcriptPath = path.join(temp, 'branch.jsonl');
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { forked_from_id: '77777777-7777-4777-8777-777777777777' },
    })}\n`, 'utf8');
    assert.equal(readCodexForkedFromId(transcriptPath), '77777777-7777-4777-8777-777777777777');

    const state = {
      sessions: [
        {
          hubId: 'parent', title: 'Codex 2', kind: 'codex', meetingId: 'meeting-1',
          codexSid: '77777777-7777-4777-8777-777777777777',
        },
        {
          hubId: 'branch', title: '分支: Codex 2', kind: 'codex', userRenamed: true,
          branchAutoTitlePending: true,
          codexSid: '88888888-8888-4888-8888-888888888888', transcriptPath,
        },
      ],
      meetings: [{ id: 'meeting-1', title: '原始群聊会话' }],
    };
    const writes = [];
    const changed = healPersistedBranchSessionTitles(state, {
      now: () => 1234,
      sessionStore: { saveSessionFile: (id, data) => writes.push([id, { ...data }]) },
    });
    assert.equal(changed.length, 1);
    assert.equal(state.sessions[1].title, '分支: 原始群聊会话');
    assert.equal(state.sessions[1].userRenamed, false, 'legacy generated flag must not protect Codex 2');
    assert.equal(state.sessions[1].branchSourceSessionId, 'parent');
    assert.equal(state.sessions[1].updatedAt, 1234);
    assert.equal(writes[0][1].title, '分支: 原始群聊会话');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
