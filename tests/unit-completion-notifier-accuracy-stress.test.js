'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CompletionNotifier } = require('../core/completion-notifier.js');

test('notification gate keeps exactly one delivery per completed turn across duplicates, stale turns and aborts', async () => {
  let now = 1_780_000_000_000;
  const delivered = [];
  const notifier = new CompletionNotifier({
    getConfig: () => ({
      notifications: {
        feishuTarget: 'oc_1234567890',
        feishuCliPath: 'fake-lark-cli',
      },
    }),
    deliveryImpl: async payload => {
      delivered.push(payload.eventId);
      return {
        ok: true,
        exitCode: 0,
        providerCode: `om_${delivered.length}`,
        messageId: `om_${delivered.length}`,
      };
    },
    retryDelaysMs: [],
    now: () => now,
  });

  let expected = 0;
  for (let sessionIndex = 0; sessionIndex < 200; sessionIndex += 1) {
    const sessionId = `stress-${sessionIndex}`;
    const session = {
      title: sessionId,
      kind: 'codex',
      completionNotificationEnabled: true,
    };
    let priorTurnId = null;
    for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
      now += 100;
      const turnId = `${sessionId}-turn-${turnIndex}`;
      notifier.notePromptSubmitted({
        hubSessionId: sessionId,
        submittedAt: now,
        turnId,
      });

      if (priorTurnId) {
        const stale = await notifier.handleTurnComplete({
          hubSessionId: sessionId,
          completedAt: now + 1,
          turnId: priorTurnId,
          text: 'delayed old result',
        }, session);
        assert.equal(stale.status, 'stale_completion_turn');
      }

      const aborted = (sessionIndex + turnIndex) % 11 === 0;
      if (aborted) {
        notifier.noteTurnAborted({
          hubSessionId: sessionId,
          abortedAt: now + 2,
          turnId,
        });
        const rejected = await notifier.handleTurnComplete({
          hubSessionId: sessionId,
          completedAt: now + 3,
          turnId,
          text: 'late result after abort',
        }, session);
        assert.equal(rejected.status, 'aborted_turn');
      } else {
        const first = await notifier.handleTurnComplete({
          hubSessionId: sessionId,
          completedAt: now + 3,
          turnId,
          text: 'final result',
        }, session);
        assert.equal(first.ok, true);
        expected += 1;
        const patch = await notifier.handleTurnComplete({
          hubSessionId: sessionId,
          completedAt: now + 4,
          turnId,
          text: 'final result with later transcript patch',
        }, session);
        assert.equal(patch.status, 'duplicate');
        if (priorTurnId) {
          const veryLateOldTurn = await notifier.handleTurnComplete({
            hubSessionId: sessionId,
            completedAt: now + 5,
            turnId: priorTurnId,
            text: 'old turn observed after the current completion',
          }, session);
          assert.equal(veryLateOldTurn.status, 'stale_completion_turn');
        }
      }
      priorTurnId = turnId;
      now += 10;
    }
  }

  assert.equal(delivered.length, expected);
  assert.equal(new Set(delivered).size, expected,
    'every accepted completion must map to one unique delivery event');
  notifier.dispose();
});

test('providers without native turn ids use prompt generations without suppressing later identical answers', async () => {
  let now = 1_780_100_000_000;
  const delivered = [];
  const notifier = new CompletionNotifier({
    getConfig: () => ({
      notifications: {
        feishuTarget: 'ou_1234567890',
        feishuCliPath: 'fake-lark-cli',
      },
    }),
    deliveryImpl: async payload => {
      delivered.push(payload.eventId);
      return { ok: true, exitCode: 0, providerCode: `om_${delivered.length}` };
    },
    retryDelaysMs: [],
    now: () => now,
  });
  const session = {
    title: 'Claude no native turn id',
    kind: 'claude',
    completionNotificationEnabled: true,
  };

  for (let turnIndex = 0; turnIndex < 100; turnIndex += 1) {
    now += 100;
    notifier.notePromptSubmitted({ hubSessionId: 'claude-stress', submittedAt: now });
    const first = await notifier.handleTurnComplete({
      hubSessionId: 'claude-stress',
      completedAt: now + 5,
      text: 'same answer text',
    }, session);
    assert.equal(first.ok, true);
    const patch = await notifier.handleTurnComplete({
      hubSessionId: 'claude-stress',
      completedAt: now + 6,
      text: 'same answer text plus patch',
    }, session);
    assert.equal(patch.status, 'duplicate');
  }

  assert.equal(delivered.length, 100);
  assert.equal(new Set(delivered).size, 100);
  notifier.dispose();
});
