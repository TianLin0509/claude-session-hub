'use strict';
// Claude 家族（Claude / CodeAgent）分支在第一轮之前没有自己的记录文件（2026-10-13 公司版 CodeAgent 实测）：
// `--resume <id> --fork-session` 启动时 hook 就报上了分支的记录路径，但 CLI 第一轮才写这个文件。
// 卡片不能报「加载历史失败：ENOENT」，应显示分支前的源会话历史；文件出现后读到分支自己的记录；
// 发过消息的分支丢了文件，照旧报错。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers.js');
const { isUnsubmittedBranch } = require('../core/session-history-state');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-missing-'));
const parentFile = path.join(dir, 'parent.jsonl');
const childFile = path.join(dir, 'fork-child.jsonl');
fs.writeFileSync(parentFile, 'x');
const turn = (role, text, ts) => ({ id: `${role}-${ts}`, role, text, ts });
const TURNS = {
  [parentFile]: [turn('user', '父：KPI 怎么定', 1000), turn('assistant', '父：分三档', 1100)],
  [childFile]: [turn('user', '父：KPI 怎么定', 1000), turn('assistant', '父：分三档', 1100), turn('user', '子：换个口径', 3000)],
};
const parser = async (file) => {
  // 与真解析器一样，文件不存在就抛 ENOENT。
  fs.statSync(file);
  return TURNS[file] || [];
};

function deps(liveSessions, persisted = []) {
  return {
    defaultCodexSessionsRoot: dir, defer: async () => {},
    findCodexRolloutByCwd: () => null, findCodexRolloutBySid: () => null, findTranscriptByCCSessionId: () => null,
    getPersistedSessions: () => persisted,
    isCodexCliKind: kind => /^codex/.test(String(kind || '')),
    parseClaudeTranscriptToTurns: parser,
    parseCodexRolloutToTurns: async () => [],
    sessionManager: { getSession: id => liveSessions[id] || null },
    transcriptTap: { getCodexRolloutPath: () => null },
    updateSessionTranscriptBinding: () => {},
  };
}

(async () => {
  const parent = { id: 'p', hubId: 'p', kind: 'codeagent', ccSessionId: 'sid-p', transcriptPath: parentFile };
  const child = { id: 'c', hubId: 'c', kind: 'codeagent', ccSessionId: 'sid-c', transcriptPath: childFile,
    branchSourceSessionId: 'p', createdAt: 2000, freshLaunch: false };

  // 判定：带 allowBoundTranscript 时，已绑定路径的未发言分支也算「尚未产生自己的记录」。
  assert.strictEqual(isUnsubmittedBranch(child), false, '默认仍只认没有路径的分支（原有行为）');
  assert.strictEqual(isUnsubmittedBranch(child, { allowBoundTranscript: true }), true);
  assert.strictEqual(isUnsubmittedBranch({ ...child, runStartedAt: 5 }, { allowBoundTranscript: true }), false);

  for (const kind of ['codeagent', 'claude']) {
    const c = { ...child, kind };
    // 第一轮之前：没有 ENOENT，显示继承的源会话历史。
    for (const [label, d] of [['活会话', deps({ p: { ...parent, kind }, c })], ['休眠', deps({}, [{ ...parent, kind }, c])]]) {
      const result = await parseSessionTranscript({ hubSessionId: 'c', kind, transcriptPath: childFile }, d);
      assert.strictEqual(result.error, null, `${kind}/${label}：分支首轮前不报错`);
      assert.deepStrictEqual(result.turns.map(t => t.text), ['父：KPI 怎么定', '父：分三档'], `${kind}/${label}：显示分支前的历史`);
      assert.ok(result.turns.every(t => t.inherited), '标为继承');
    }
    // 增量刷新（limit:1）只要最新一条：不报错、也不白解析父会话。
    const tiny = await parseSessionTranscript({ hubSessionId: 'c', opts: { limit: 1, fromTail: true } }, deps({ p: { ...parent, kind }, c }));
    assert.strictEqual(tiny.error, null);
    assert.deepStrictEqual(tiny.turns, []);
    // 已经发过消息的分支丢了文件：照旧报错，不掩盖。
    const used = await parseSessionTranscript({ hubSessionId: 'c' }, deps({ p: { ...parent, kind }, c: { ...c, runStartedAt: 10 } }));
    assert.match(String(used.error), /ENOENT/, `${kind}：发过消息的分支缺文件要报出来`);
  }

  // 还没绑定路径的未发言分支：也先显示继承的历史（原来是空白欢迎页）。
  const unbound = { ...child, transcriptPath: null };
  const early = await parseSessionTranscript({ hubSessionId: 'c' }, deps({ p: parent, c: unbound }));
  assert.strictEqual(early.error, null);
  assert.deepStrictEqual(early.turns.map(t => t.text), ['父：KPI 怎么定', '父：分三档']);

  // CLI 写出分支记录后，自动读到分支自己的内容（复制来的父历史按签名去重，不重复）。
  fs.writeFileSync(childFile, 'x');
  const after = await parseSessionTranscript({ hubSessionId: 'c' }, deps({ p: parent, c: child }));
  assert.strictEqual(after.error, null);
  assert.deepStrictEqual(after.turns.map(t => t.text), ['父：KPI 怎么定', '父：分三档', '子：换个口径']);

  console.log('unit-branch-fork-missing-transcript: OK');
})().catch(error => { console.error(error); process.exit(1); });
