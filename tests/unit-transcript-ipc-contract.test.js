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
    deepseekCurrent: {
      id: 'deepseekCurrent',
      kind: 'deepseek',
      transcriptPath: null,
      codexSid: 'deepseek-codex-sid',
      codexSessionsRoot: 'C:\\deepseek-codex\\sessions',
      cwd: 'C:\\repo',
    },
    deepseekLegacy: {
      id: 'deepseekLegacy',
      kind: 'deepseek',
      transcriptKind: 'deepseek-legacy',
      transcriptPath: 'C:\\claude-deepseek\\legacy.jsonl',
      ccSessionId: 'deepseek-cc-sid',
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
      return ['codex', 'codex-resume', 'deepseek', 'deepseek-resume'].includes(kind);
    },
    isUsableCodexRolloutPath() {
      return true;
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
        return { text: 'latest answer' };
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
  await test('reading an unused native seat does not start its backend', async () => {
    const { CodexNativeSession } = require('../core/codex-native-session');
    const native = new CodexNativeSession({id:'unused',lazyStart:true});
    native.start = () => { throw new Error('passive read must not start'); };
    const deps = createDeps({sessionManager:{getSession:()=>({id:'unused',kind:'codex'}),getNativeCodex:()=>native}});
    const result = await parseSessionTranscript({hubSessionId:'unused'},deps);
    assert.strictEqual(result.error,null);
    assert.deepStrictEqual(result.turns,[]);
    assert.strictEqual(native.entry,null);
    native.kill();
  });
  console.log('Running transcript IPC contract tests...');

  await test('all unused CLI seats return empty history, including preallocated Claude identity', async () => {
    for (const kind of ['claude', 'codex', 'deepseek', 'gemini', 'kimi']) {
      const session = { id: 'fresh', kind, freshLaunch: true,
        ...(kind === 'claude' ? { ccSessionId: 'preallocated-id' } : {}) };
      const deps = createDeps({ sessionManager: { getSession: () => session },
        findTranscriptByCCSessionId: () => null, findCodexRolloutBySid: () => null });
      const result = await parseSessionTranscript({ hubSessionId: 'fresh' }, deps);
      assert.equal(result.error, null, kind);
      assert.deepEqual(result.turns, [], kind);
      session.freshLaunch = false;
      session.kind = kind + '-resume';
      assert.ok((await parseSessionTranscript({ hubSessionId: 'fresh' }, deps)).error, 'restored ' + kind);
    }
  });

  await test('a new seat may publish its file path before creation, but genuine failures remain visible', async () => {
    for (const kind of ['claude', 'gemini', 'kimi']) {
      const session = { id: 'fresh', kind, freshLaunch: true, transcriptPath: 'pending.jsonl' };
      let error = Object.assign(new Error('ENOENT: pending.jsonl'), { code: 'ENOENT' });
      const deps = createDeps({ sessionManager: { getSession: () => session },
        transcriptParserService: { parse: async () => { throw error; } } });
      assert.equal((await parseSessionTranscript({ hubSessionId: 'fresh' }, deps)).error, null, kind);
      error = new Error('invalid history contents');
      assert.equal((await parseSessionTranscript({ hubSessionId: 'fresh' }, deps)).error, error.message);
      error = Object.assign(new Error('ENOENT: pending.jsonl'), { code: 'ENOENT' });
      session.freshLaunch = false;
      assert.equal((await parseSessionTranscript({ hubSessionId: 'fresh' }, deps)).error, error.message);
    }
  });

  await test('observed conversation history ends startup missing-file tolerance permanently', async () => {
    const session = { id:'fresh', kind:'claude', freshLaunch:true, transcriptPath:'known.jsonl' };
    let missing = false;
    const deps = createDeps({ sessionManager: { getSession: () => session,
      updateSessionMeta: (_id, fields) => Object.assign(session, fields) },
      transcriptParserService: { parse: async () => {
        if (missing) throw Object.assign(new Error('ENOENT: known.jsonl'), { code:'ENOENT' });
        return { turns:[{role:'assistant',text:'actual answer'}], meta:{} };
      } } });
    assert.equal((await parseSessionTranscript({ hubSessionId:'fresh' }, deps)).turns[0].text, 'actual answer');
    assert.equal(session.freshLaunch, false);
    missing = true;
    assert.equal((await parseSessionTranscript({ hubSessionId:'fresh' }, deps)).error, 'ENOENT: known.jsonl');
  });

  await test('a fresh Codex CLI has welcome content, not a missing resume history error', async () => {
    const session = { id: 'fresh', kind: 'codex', status: 'idle', cwd: 'C:\\repo',
      lastMessageTime: Date.now(), lastOutputPreview: 'What brings you here?' };
    const deps = createDeps({ sessionManager: { getSession: () => session },
      findCodexRolloutBySid: () => null, findCodexRolloutByCwd: () => null });
    assert.deepStrictEqual(await parseSessionTranscript({ hubSessionId: 'fresh' }, deps),
      { turns: [], transcriptPath: null, error: null });
    for (const history of [{ kind: 'codex-resume' }, { codexSid: 'saved-sid' },
      { codexAllowMtimeFallback: true }, { runStartedAt: Date.now() }, { lastRunStartedAt: Date.now() }]) {
      const original = { ...session }; Object.assign(session, history);
      assert.equal((await parseSessionTranscript({ hubSessionId: 'fresh' }, deps)).error, 'codex rollout not found');
      for (const key of Object.keys(session)) delete session[key]; Object.assign(session, original);
    }
  });

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

  await test('Claude transcript uses session transcriptPath before ccSession scan', async () => {
    const deps = createDeps();
    const result = await parseSessionTranscript({ hubSessionId: 'claude', ccSessionId: 'cc-override' }, deps);

    assert.strictEqual(result.error, null);
    assert.strictEqual(result.transcriptPath, 'C:\\claude\\session.jsonl');
    assert.ok(!deps.calls.some(call => call[0] === 'findTranscriptByCCSessionId'));
    assert.ok(deps.calls.some(call => call[0] === 'parseClaudeTranscriptToTurns'));
    assert.strictEqual(typeof result.parseMs, 'number');
  });

  await test('DeepSeek parser follows the native id across the Codex migration', async () => {
    const currentDeps = createDeps();
    const current = await parseSessionTranscript({ hubSessionId: 'deepseekCurrent' }, currentDeps);
    assert.strictEqual(current.error, null);
    assert.strictEqual(current.transcriptPath, 'C:\\codex\\sid-rollout.jsonl');
    assert.ok(currentDeps.calls.some(call => call[0] === 'findCodexRolloutBySid'
      && call[1] === 'deepseek-codex-sid'
      && call[2] === 'C:\\deepseek-codex\\sessions'));
    assert.ok(currentDeps.calls.some(call => call[0] === 'parseCodexRolloutToTurns'));

    const legacyDeps = createDeps();
    const legacy = await parseSessionTranscript({ hubSessionId: 'deepseekLegacy' }, legacyDeps);
    assert.strictEqual(legacy.error, null);
    assert.strictEqual(legacy.transcriptPath, 'C:\\claude-deepseek\\legacy.jsonl');
    assert.ok(legacyDeps.calls.some(call => call[0] === 'parseClaudeTranscriptToTurns'));
    assert.ok(!legacyDeps.calls.some(call => call[0] === 'parseCodexRolloutToTurns'));

    const dormantDeps = createDeps();
    const dormantLegacy = await parseSessionTranscript({
      kind: 'deepseek',
      ccSessionId: 'dormant-deepseek-cc',
    }, dormantDeps);
    assert.strictEqual(dormantLegacy.transcriptPath, 'C:\\claude\\dormant-deepseek-cc.jsonl');
    assert.ok(dormantDeps.calls.some(call => call[0] === 'parseClaudeTranscriptToTurns'));
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

  await test('failed native connection still displays identity-checked saved Codex history', async () => {
    const deps=createDeps();
    const session=deps.sessionManager.getSession('codex');
    Object.assign(session,{runtimeBackend:'codex-app-server',transcriptPath:'saved-rollout.jsonl'});
    const runtime={connection:'disconnected',threadId:'codex-sid'};
    deps.sessionManager.getNativeCodex=()=>({runtime,async start(){throw Error('no rollout found');}});
    deps.isUsableCodexRolloutPath=(file,id)=>file==='saved-rollout.jsonl' && id==='codex-sid';
    const result=await parseSessionTranscript({hubSessionId:'codex',opts:{limit:12}},deps);
    assert.equal(result.error,null);assert.equal(result.source,'codex-rollout');
    assert.equal(result.connectionError,'no rollout found');assert.equal(result.turns[0].text,'codex answer');
    assert.equal(runtime.connection,'disconnected','history never claims a live connection');
    deps.isUsableCodexRolloutPath=()=>false;
    const missing=await parseSessionTranscript({hubSessionId:'codex'},deps);
    assert.equal(missing.error,'no rollout found');assert.equal(missing.turns.length,0);
  });
  console.log('All transcript IPC contract tests passed.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
