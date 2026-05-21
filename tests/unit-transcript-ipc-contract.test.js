'use strict';

const assert = require('assert');
const { parseSessionTranscript, registerTranscriptIpc } = require('../main/ipc/transcript-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function createDeps(overrides = {}) {
  const calls = [];
  const sessions = new Map(Object.entries({
    codex: {
      id: 'codex',
      kind: 'codex',
      transcriptPath: null,
      codexSid: 'codex-sid',
      codexSessionsRoot: 'C:\\codex\\sessions',
      cwd: 'C:\\repo',
      createdAt: 1000,
    },
    claude: {
      id: 'claude',
      kind: 'claude',
      transcriptPath: 'C:\\claude\\session.jsonl',
      ccSessionId: 'cc-1',
    },
    app: {
      id: 'app',
      kind: 'codex-app',
    },
  }));

  return {
    calls,
    defaultCodexSessionsRoot: 'C:\\default\\codex',
    defer: async () => {
      calls.push(['defer']);
    },
    findCodexRolloutByCwd(cwd, root, opts) {
      calls.push(['findCodexRolloutByCwd', cwd, root, opts]);
      return 'C:\\codex\\cwd-rollout.jsonl';
    },
    findCodexRolloutBySid(sid, root) {
      calls.push(['findCodexRolloutBySid', sid, root]);
      return 'C:\\codex\\sid-rollout.jsonl';
    },
    findTranscriptByCCSessionId(ccSessionId) {
      calls.push(['findTranscriptByCCSessionId', ccSessionId]);
      return ccSessionId ? `C:\\claude\\${ccSessionId}.jsonl` : null;
    },
    isCodexCliKind(kind) {
      calls.push(['isCodexCliKind', kind]);
      return kind === 'codex' || kind === 'codex-resume';
    },
    parseClaudeTranscriptToTurns: async (transcriptPath, opts) => {
      calls.push(['parseClaudeTranscriptToTurns', transcriptPath, opts]);
      return [{ role: 'assistant', text: 'claude answer' }];
    },
    parseCodexRolloutToTurns(transcriptPath, opts) {
      calls.push(['parseCodexRolloutToTurns', transcriptPath, opts]);
      return [{ role: 'assistant', text: 'codex answer' }];
    },
    sessionManager: {
      getSession(hubSessionId) {
        calls.push(['getSession', hubSessionId]);
        return sessions.get(hubSessionId) || null;
      },
    },
    transcriptTap: {
      getLastAssistantText(sessionId) {
        calls.push(['getLastAssistantText', sessionId]);
        return `last:${sessionId}`;
      },
      getCodexRolloutPath(sessionId) {
        calls.push(['getCodexRolloutPath', sessionId]);
        return null;
      },
      async extractLatestTurn(sessionId, minChars) {
        calls.push(['extractLatestTurn', sessionId, minChars]);
        return { text: 'codex app answer' };
      },
    },
    updateSessionTranscriptBinding(hubSessionId, fields) {
      calls.push(['updateSessionTranscriptBinding', hubSessionId, fields]);
    },
    ...overrides,
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('Running transcript IPC contract tests...');

  await test('registers transcript channels and delegates last assistant text', async () => {
    const ipc = createFakeIpc();
    const deps = createDeps();
    registerTranscriptIpc(ipc, deps);

    assert.ok(ipc.handlers.has('get-last-assistant-text'));
    assert.ok(ipc.handlers.has('parse-session-transcript'));
    assert.strictEqual(ipc.handlers.get('get-last-assistant-text')(null, 's1'), 'last:s1');
    assert.deepStrictEqual(deps.calls.at(-1), ['getLastAssistantText', 's1']);
  });

  await test('Codex CLI prefers live rollout path and updates binding', async () => {
    const deps = createDeps({
      transcriptTap: {
        ...createDeps().transcriptTap,
        getCodexRolloutPath(sessionId) {
          deps.calls.push(['getCodexRolloutPath', sessionId]);
          return 'C:\\codex\\live-rollout.jsonl';
        },
      },
    });

    const result = await parseSessionTranscript({ hubSessionId: 'codex', opts: { limit: 3 } }, deps);

    assert.strictEqual(result.error, null);
    assert.strictEqual(result.transcriptPath, 'C:\\codex\\live-rollout.jsonl');
    assert.deepStrictEqual(result.turns, [{ role: 'assistant', text: 'codex answer' }]);
    assert.ok(deps.calls.some(call => call[0] === 'updateSessionTranscriptBinding'));
    assert.ok(deps.calls.some(call => call[0] === 'parseCodexRolloutToTurns' && call[2].limit === 3));
  });

  await test('Codex CLI falls back through codexSid lookup', async () => {
    const deps = createDeps();
    const result = await parseSessionTranscript({ hubSessionId: 'codex' }, deps);

    assert.strictEqual(result.transcriptPath, 'C:\\codex\\sid-rollout.jsonl');
    assert.ok(deps.calls.some(call => call[0] === 'findCodexRolloutBySid' && call[1] === 'codex-sid'));
  });

  await test('Codex App returns extracted latest turn without transcript path', async () => {
    const deps = createDeps();
    const result = await parseSessionTranscript({ hubSessionId: 'app' }, deps);

    assert.strictEqual(result.error, null);
    assert.strictEqual(result.transcriptPath, null);
    assert.strictEqual(result.turns[0].role, 'assistant');
    assert.strictEqual(result.turns[0].text, 'codex app answer');
    assert.strictEqual(result.turns[0].source, 'codex_app_server');
  });

  await test('Claude transcript uses session transcriptPath before ccSession scan', async () => {
    const deps = createDeps();
    const result = await parseSessionTranscript({ hubSessionId: 'claude', ccSessionId: 'cc-override' }, deps);

    assert.strictEqual(result.error, null);
    assert.strictEqual(result.transcriptPath, 'C:\\claude\\session.jsonl');
    assert.ok(!deps.calls.some(call => call[0] === 'findTranscriptByCCSessionId'));
    assert.ok(deps.calls.some(call => call[0] === 'parseClaudeTranscriptToTurns'));
    assert.strictEqual(typeof result.parseMs, 'number');
  });

  await test('missing and parser error results preserve prior contract', async () => {
    const missingDeps = createDeps({
      findTranscriptByCCSessionId() {
        missingDeps.calls.push(['findTranscriptByCCSessionId']);
        return null;
      },
    });
    assert.deepStrictEqual(
      await parseSessionTranscript({ ccSessionId: 'missing' }, missingDeps),
      { turns: [], transcriptPath: null, error: 'transcript not found' },
    );

    const errorDeps = createDeps({
      parseClaudeTranscriptToTurns: async () => {
        throw new Error('parser exploded');
      },
    });
    assert.deepStrictEqual(
      await parseSessionTranscript({ transcriptPath: 'C:\\bad.jsonl', kind: 'claude' }, errorDeps),
      { turns: [], transcriptPath: 'C:\\bad.jsonl', error: 'parser exploded' },
    );
  });

  console.log('All transcript IPC contract tests passed.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
