'use strict';
// 2026-09-26 真机（Codex 0.153.4）：TUI 里的 /new 先打印「To continue this session … (<旧线程>)」，
// 新线程要到第一次提问才报 SessionStart，而且 source 是 startup（不是 clear）。旧规则把它当成
// 嵌套 codex 丢弃：/new 之后的问答全部「未确认」、卡片不更新、关闭再开回到旧线程。
// 另外 task_complete 之后 Codex 仍在收尾，这时发的斜杠命令会被拒绝（is disabled while a task
// is in progress），收尾中的工作行却被当成「已开工」而误报成功。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { detectCodexThreadEnded } = require('../core/host-shell-detector');
const { createCodexPtyHookHandler } = require('../main/codex-pty-hook');

const SID = '01a0dd92-e239-7101-99bc-a34e5914fe81';
// ConPTY 用光标右移代替空格，长 id 在行尾折行。
const conpty = text => text.replace(/ /g, '\x1b[1C');
const ended = sid => conpty(`Token usage: total=17,529\r\nTo continue this session, run codex resume, then select 只回复 READY (${sid.slice(0, 9)}\r\n${sid.slice(9)})\r\n`);

test('thread-ended evidence survives ConPTY spacing and wrapping, and must name the bound thread', () => {
  assert.equal(detectCodexThreadEnded('\x1b[?25l' + ended(SID) + '\x1b[2K› Ask Codex to do anything', SID), true);
  assert.equal(detectCodexThreadEnded(ended(SID), 'other-thread'), false);
  assert.equal(detectCodexThreadEnded('› just a prompt', SID), false);
  // 只看最后一次提示：之后又结束了别的线程，旧 id 不再算数。
  assert.equal(detectCodexThreadEnded(ended(SID) + 'x'.repeat(50) + ended('01a0ffff-0000-7000-8000-000000000000'), SID), false);
});

function harness({ threadEnded }) {
  const session = { id: 'hub-1', kind: 'codex', agentRuntime: 'pty', runtimeBackend: null, codexSid: 'T1', transcriptPath: 'C:/s/rollout-T1.jsonl' };
  const calls = [];
  const sessionManager = {
    updateSessionMeta: (id, patch) => { Object.assign(session, patch); return { ...session }; },
    noteAgentTurnStarted: () => calls.push('turn-started'),
    isHostShellActive: () => false,
    isCodexThreadEnded: (id, bound) => threadEnded && bound === 'T1',
    _refreshOpenIdentity: () => {},
  };
  const tap = new EventEmitter();
  tap.bindCodexFromHook = async (id, options) => { calls.push(['bind', options.codexSid, options.rebind]); return true; };
  tap.notePrompt = () => {};
  tap.getCodexRolloutPath = () => session.transcriptPath;
  const handle = createCodexPtyHookHandler({ sessionManager, transcriptTap: tap, sendToRenderer: () => {},
    readCodexRolloutMeta: () => ({ id: 'x' }), isCodexTopLevelRolloutMeta: () => true, logger: { warn() {} }, now: () => 1 });
  return { session, calls, handle };
}

test('startup SessionStart after the TUI ended the bound thread moves the session (Codex /new)', async () => {
  const h = harness({ threadEnded: true });
  const out = await h.handle(h.session, 'session-start', { claudeSessionId: 'T2', transcriptPath: 'C:/s/rollout-T2.jsonl', source: 'startup' });
  assert.deepEqual(out, { ok: true });
  assert.equal(h.session.codexSid, 'T2');
  assert.deepEqual(h.calls.filter(c => c[0] === 'bind'), [['bind', 'T2', true]]);
  await h.handle(h.session, 'prompt', { claudeSessionId: 'T2', transcriptPath: 'C:/s/rollout-T2.jsonl', prompt: 'q' });
  assert.ok(h.calls.includes('turn-started'), 'the first prompt of the new thread is acknowledged');
});

test('without that evidence a startup SessionStart is still a nested codex and is ignored', async () => {
  const h = harness({ threadEnded: false });
  assert.deepEqual(await h.handle(h.session, 'session-start', { claudeSessionId: 'N1', transcriptPath: 'C:/s/rollout-N1.jsonl', source: 'startup' }),
    { ignored: 'foreign-session' });
  assert.equal(h.session.codexSid, 'T1');
});

test('the Hub records the ended thread when it confirms /new, and busy rejections are retried exactly once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  assert.match(src, /const CODEX_THREAD_SWITCH_COMMAND_RE = \/\^\\s\*\\\/\(\?:new\|clear\)\(\?:\\s\|\$\)\/i;/);
  assert.match(src, /detectCodexThreadEnded\([\s\S]{0,120}, sidBefore\)\) \{\s*sessionManager\.noteCodexThreadEnded\?\.\(sid, sidBefore\);\s*return 'switched';/);
  assert.match(src, /acknowledgementSource: 'codex-thread-switch'/);
  // 被拒就是没执行：只在未重试过时再提交一次，第二次仍被拒则如实报「未发送」。
  const retries = src.match(/if \(!options\.retriedAfterBusyReject\) \{/g) || [];
  assert.equal(retries.length, 2, 'both the /new path and the generic slash path retry once');
  assert.match(src, /retriedAfterBusyReject: true, workspaceRulesPrepared: true/);
  assert.match(src, /notSent: true, sendStatus: 'rejected', error: 'cli-busy-rejected'/);
  // 重绘会把旧提示再画一遍：比较的是可见屏幕上的条数，而不是输出流里出现过没有。
  assert.match(src, /visibleBusyRejections\(livePtyObserver\) > busyBaseline/);
  const sm = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(sm, /if \(s\.codexEndedThreadSid === String\(boundSid\)\) return true;/);
  assert.match(sm, /detectCodexThreadEnded\(this\.getSessionOutputSince\(sessionId, s\.codexBoundOutputMark \|\| 0\), boundSid\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'main', 'codex-pty-hook.js'), 'utf8'),
    /source === 'startup' && \(!!sessionManager\.isHostShellActive\?\.\(hubSessionId\)\s*\|\| !!sessionManager\.isCodexThreadEnded\?\.\(hubSessionId, boundSid\)\)/);
});
