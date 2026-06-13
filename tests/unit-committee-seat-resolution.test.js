'use strict';

const assert = require('assert');
const { createCommitteeConductor } = require('../main/groupchat/committee-conductor.js');

function makeConductor(sessions) {
  return createCommitteeConductor({
    dispatchGroupChatTurn: async () => ({ status: 'completed', results: [] }),
    meetingManager: { getMeeting: () => null },
    sessionManager: { getSession: sid => sessions[sid] || null },
    logger: { log() {}, warn() {} },
    sendToRenderer() {},
  });
}

function assertUniqueSeats(seats) {
  const sids = Object.values(seats).map(s => s.sid);
  assert.strictEqual(new Set(sids).size, sids.length, 'one session must not be assigned to multiple committee seats');
}

{
  const sessions = {
    fund: { id: 'fund', kind: 'deepseek', status: 'active' },
    news: { id: 'news', kind: 'claude', status: 'active' },
    tech: { id: 'tech', kind: 'codex', status: 'active' },
    challenger: { id: 'challenger', kind: 'codex', status: 'active' },
    chair: { id: 'chair', kind: 'claude', status: 'active' },
  };
  const conductor = makeConductor(sessions);
  const seats = conductor._resolveSeats({
    scene: 'committee',
    subSessions: ['fund', 'news', 'tech', 'challenger', 'chair'],
  });
  assertUniqueSeats(seats);
  assert.strictEqual(seats.news.sid, 'news');
  assert.strictEqual(seats.chair.sid, 'chair');
  assert.strictEqual(seats.tech.sid, 'tech');
  assert.strictEqual(seats.challenger.sid, 'challenger');
}

{
  const sessions = {
    fund: { id: 'fund', kind: 'deepseek', status: 'active' },
    oneCodex: { id: 'oneCodex', kind: 'codex', status: 'active' },
    oneClaude: { id: 'oneClaude', kind: 'claude', status: 'active' },
  };
  const conductor = makeConductor(sessions);
  const seats = conductor._resolveSeats({
    scene: 'committee',
    subSessions: ['fund', 'oneCodex', 'oneClaude'],
  });
  assertUniqueSeats(seats);
  assert.strictEqual(seats.news.sid, 'oneClaude');
  assert.strictEqual(seats.tech.sid, 'oneCodex');
  assert.strictEqual(seats.chair, undefined, 'single Claude must not be reused as chair');
  assert.strictEqual(seats.challenger, undefined, 'single Codex must not be reused as challenger');
}

{
  const sessions = {
    fund: { id: 'fund', kind: 'deepseek', status: 'active' },
    chair: { id: 'chair', kind: 'claude', status: 'active' },
    challenger: { id: 'challenger', kind: 'codex', status: 'active' },
    news: { id: 'news', kind: 'claude', status: 'active' },
    tech: { id: 'tech', kind: 'codex', status: 'active' },
  };
  const conductor = makeConductor(sessions);
  const seats = conductor._resolveSeats({
    scene: 'committee',
    subSessions: ['fund', 'chair', 'challenger', 'news', 'tech'],
  });
  assertUniqueSeats(seats);
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(seats).map(([key, value]) => [key, value.kind])),
    { fund: 'deepseek', news: 'claude', tech: 'codex', challenger: 'codex', chair: 'claude' }
  );
}

console.log('Committee seat resolution: ok');
