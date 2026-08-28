'use strict';

// parseSessionTranscript 层面的分支继承：卡片视图看到的就是这个函数的返回值。
// 覆盖三种祖先形态：活会话 / 只剩落盘记录 / 多级分支链。

const assert = require('assert');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers.js');

const turn = (role, text, ts) => ({ id: `${role}-${ts}`, role, text, ts });

const TRANSCRIPTS = {
  'C:/rollout-parent.jsonl': [
    turn('user', '父：先看一下方案', 1000),
    turn('assistant', '父：方案要点如下', 1100),
    turn('user', '父：分支之后我又问的', 9000),
  ],
  'C:/rollout-child.jsonl': [
    turn('user', '子：换个方向试试', 3000),
    turn('assistant', '子：好的，这样改', 3100),
  ],
  'C:/rollout-grandchild.jsonl': [
    turn('user', '孙：再分一支', 4000),
  ],
};

function makeDeps({ liveSessions = {}, persisted = [] } = {}) {
  return {
    defaultCodexSessionsRoot: 'C:/codex',
    defer: async () => {},
    findCodexRolloutByCwd: () => null,
    findCodexRolloutBySid: () => null,
    findTranscriptByCCSessionId: () => null,
    getPersistedSessions: () => persisted,
    isCodexCliKind: (kind) => /^codex/.test(String(kind || '')),
    isUsableCodexRolloutPath: () => true,
    parseClaudeTranscriptToTurns: async () => [],
    // 真解析器会自己按 limit/fromTail 收口，桩要保持同样语义，否则测不出窗口行为。
    parseCodexRolloutToTurns: async (p, o = {}) => {
      const all = TRANSCRIPTS[p] || [];
      const limit = Number(o.limit);
      if (!Number.isFinite(limit) || limit >= all.length) return all;
      return o.fromTail === false ? all.slice(0, limit) : all.slice(all.length - limit);
    },
    sessionManager: { getSession: (id) => liveSessions[id] || null },
    transcriptTap: { getCodexRolloutPath: () => null },
    updateSessionTranscriptBinding: () => {},
  };
}

async function main() {
  const parent = {
    id: 'parent', hubId: 'parent', kind: 'codex',
    codexSid: 'sid-parent', transcriptPath: 'C:/rollout-parent.jsonl',
  };
  const child = {
    id: 'child', hubId: 'child', kind: 'codex',
    codexSid: 'sid-child', transcriptPath: 'C:/rollout-child.jsonl',
    branchSourceSessionId: 'parent', createdAt: 2500,
  };

  // --- 祖先是活会话 ---
  let result = await parseSessionTranscript(
    { hubSessionId: 'child' },
    makeDeps({ liveSessions: { parent, child } }),
  );
  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：先看一下方案', '父：方案要点如下',
    '子：换个方向试试', '子：好的，这样改',
  ], '分支前的两条要补回来，分支之后父会话自己那条要切掉');
  assert.deepStrictEqual(result.turns.map(t => !!t.inherited), [true, true, false, false]);

  // --- 祖先只剩落盘记录（休眠 / Hub 重启后） ---
  result = await parseSessionTranscript(
    { hubSessionId: 'child' },
    makeDeps({ liveSessions: { child }, persisted: [parent] }),
  );
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：先看一下方案', '父：方案要点如下',
    '子：换个方向试试', '子：好的，这样改',
  ]);

  // --- 子会话自己也只剩落盘记录：branchSourceSessionId 只在持久化记录里 ---
  result = await parseSessionTranscript(
    { hubSessionId: 'child', transcriptPath: 'C:/rollout-child.jsonl', kind: 'codex' },
    makeDeps({ liveSessions: {}, persisted: [parent, child] }),
  );
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：先看一下方案', '父：方案要点如下',
    '子：换个方向试试', '子：好的，这样改',
  ]);

  // --- 多级分支链：分支的分支要一路继承上去 ---
  const grandchild = {
    id: 'grandchild', hubId: 'grandchild', kind: 'codex',
    codexSid: 'sid-grandchild', transcriptPath: 'C:/rollout-grandchild.jsonl',
    branchSourceSessionId: 'child', createdAt: 3500,
  };
  result = await parseSessionTranscript(
    { hubSessionId: 'grandchild' },
    makeDeps({ liveSessions: { parent, child, grandchild } }),
  );
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：先看一下方案', '父：方案要点如下',
    '子：换个方向试试', '子：好的，这样改',
    '孙：再分一支',
  ]);

  // --- 多级链上中间那一级已经休眠：仍要一路继承到最上面 ---
  result = await parseSessionTranscript(
    { hubSessionId: 'grandchild' },
    makeDeps({ liveSessions: { grandchild }, persisted: [parent, child] }),
  );
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：先看一下方案', '父：方案要点如下',
    '子：换个方向试试', '子：好的，这样改',
    '孙：再分一支',
  ], '中间一级只剩落盘记录时不能只继承一层');

  // --- 非分支会话完全不受影响，也不会去解析别的 transcript ---
  const parsedPaths = [];
  const depsCounting = makeDeps({ liveSessions: { parent } });
  const innerParser = depsCounting.parseCodexRolloutToTurns;
  depsCounting.parseCodexRolloutToTurns = async (p, o) => { parsedPaths.push(p); return innerParser(p, o); };
  result = await parseSessionTranscript({ hubSessionId: 'parent' }, depsCounting);
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：先看一下方案', '父：方案要点如下', '父：分支之后我又问的',
  ]);
  assert.deepStrictEqual(parsedPaths, ['C:/rollout-parent.jsonl']);

  // --- 增量刷新（limit 很小）不该为了一条最新回答去解析父 transcript ---
  const incrementalPaths = [];
  const depsIncremental = makeDeps({ liveSessions: { parent, child } });
  const innerIncremental = depsIncremental.parseCodexRolloutToTurns;
  depsIncremental.parseCodexRolloutToTurns = async (p, o) => { incrementalPaths.push(p); return innerIncremental(p, o); };
  result = await parseSessionTranscript(
    { hubSessionId: 'child', opts: { limit: 1, fromTail: true } },
    depsIncremental,
  );
  assert.deepStrictEqual(incrementalPaths, ['C:/rollout-child.jsonl']);
  assert.strictEqual(result.turns.length, 1);

  // --- 合并后仍然遵守调用方的窗口大小 ---
  result = await parseSessionTranscript(
    { hubSessionId: 'child', opts: { limit: 6, fromTail: true } },
    makeDeps({ liveSessions: { parent, child } }),
  );
  assert.strictEqual(result.turns.length, 4);
  result = await parseSessionTranscript(
    { hubSessionId: 'child', opts: { limit: 3, fromTail: true } },
    makeDeps({ liveSessions: { parent, child } }),
  );
  assert.deepStrictEqual(result.turns.map(t => t.text), [
    '父：方案要点如下', '子：换个方向试试', '子：好的，这样改',
  ]);

  // --- 祖先记录已经彻底找不到时安静降级，不能把子会话自己的历史弄丢 ---
  result = await parseSessionTranscript(
    { hubSessionId: 'child' },
    makeDeps({ liveSessions: { child }, persisted: [] }),
  );
  assert.deepStrictEqual(result.turns.map(t => t.text), ['子：换个方向试试', '子：好的，这样改']);

  // --- 分支成环也必须终止 ---
  const loopA = { id: 'a', hubId: 'a', kind: 'codex', codexSid: 'sa', transcriptPath: 'C:/rollout-child.jsonl', branchSourceSessionId: 'b' };
  const loopB = { id: 'b', hubId: 'b', kind: 'codex', codexSid: 'sb', transcriptPath: 'C:/rollout-parent.jsonl', branchSourceSessionId: 'a' };
  result = await parseSessionTranscript(
    { hubSessionId: 'a' },
    makeDeps({ liveSessions: { a: loopA, b: loopB } }),
  );
  assert.ok(Array.isArray(result.turns) && result.turns.length > 0, '成环时应返回结果而不是挂死');

  console.log('unit-transcript-branch-inheritance: OK');
}

main().catch(err => { console.error(err); process.exit(1); });
