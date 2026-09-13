'use strict';
// PTY 顶部大片空白（Codex / Claude 都出现过，用户 2026-07-27 多次反馈）。
// 排查发现两条置底路径互补却都漏掉了"Claude 会话被 resize"这一格：
//   showTerminal        pinOnShow = !isCodexSession && focus   → 只在"显示"时置底，且排除 Codex
//   fitAndResizeTerminal shouldAutoPinCodexTerminal 写死 isCodexKind → 只在"fit"后置底，且只认 Codex
// 于是终端行数一变，xterm 重排后视口可能停在旧位置、正文上方留白，且不会自愈。
// 这里锁住与 CLI 无关的通用规则：fit 前贴底 ⇒ fit 后仍贴底。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function fitBody() {
  const start = SRC.indexOf('function fitAndResizeTerminal(');
  assert.ok(start > 0, 'fitAndResizeTerminal must exist');
  const end = SRC.indexOf('\nfunction ', start + 10);
  return SRC.slice(start, end > 0 ? end : start + 2500);
}

console.log('Running terminal fit bottom-pin tests...');

test('bottom state is sampled before the fit, not after', () => {
  const body = fitBody();
  const sampleAt = body.indexOf('const wasAtBottom = isTerminalViewportAtBottom(cached)');
  const fitAt = body.indexOf('cached.fitAddon.fit()');
  assert.ok(sampleAt > 0, 'fit must record whether the viewport was pinned to the bottom');
  assert.ok(fitAt > sampleAt, 'the sample must be taken before fit() reflows the buffer');
});

function resize(session, { atBottom = true, follow = true } = {}) {
  const frames = [], calls = [];
  const cached = { opened: true, container: { offsetWidth: 800, getBoundingClientRect: () => ({width:800,height:600}) },
    terminal: { cols: 80, rows: 24 }, fitAddon: { fit() { calls.push('fit'); atBottom = false; } } };
  const native = s => ['codex-app-server','claude-stream-json','acp'].includes(s?.runtimeBackend);
  const codex = kind => /^codex(?:-resume)?$/.test(kind || '');
  vm.runInNewContext(fitBody() + '\nfitAndResizeTerminal("session", cached, {force:true});', {
    cached, sessions:new Map([['session',session]]), currentFontSize:14, currentZoom:1,
    isNativeAgent:native, isCodexKind:codex,
    isTerminalViewportAtBottom:()=>atBottom,
    shouldAutoPinCodexTerminal:()=>follow && (native(session) || codex(session.kind)),
    pinTerminalViewportToBottom:()=>{calls.push('pin');atBottom=true;},
    scheduleCodexBottomPin:()=>calls.push('follow'),
    requestAnimationFrame:fn=>frames.push(fn), ipcRenderer:{send:()=>calls.push('resize')},
  });
  return { calls, frames };
}

test('plain PTY bottom survives fit and the following reflow frame', () => {
  const {calls,frames}=resize({kind:'claude'});
  assert.deepEqual(calls,['fit','resize','pin']);
  assert.equal(frames.length,1);frames[0]();
  assert.deepEqual(calls,['fit','resize','pin','pin']);
});

test('every native provider uses the shared follow policy exactly once', () => {
  for(const [kind,runtimeBackend] of [['codex','codex-app-server'],['claude','claude-stream-json'],['qwen','acp']]) {
    const {calls,frames}=resize({kind,runtimeBackend});
    assert.deepEqual(calls,['fit','resize','follow'],kind);assert.equal(frames.length,0);
  }
});

test('upward native intent wins even while the DOM still reports the old bottom', () => {
  for(const [kind,runtimeBackend] of [['codex','codex-app-server'],['claude','claude-stream-json'],['qwen','acp']]) {
    const {calls,frames}=resize({kind,runtimeBackend},{atBottom:true,follow:false});
    assert.deepEqual(calls,['fit','resize'],kind);assert.equal(frames.length,0);
  }
});

test('a plain terminal scrolled away from the bottom is left alone', () => {
  const {calls,frames}=resize({kind:'claude'},{atBottom:false});
  assert.deepEqual(calls,['fit','resize']);assert.equal(frames.length,0);
});

if (!process.exitCode) console.log('All terminal fit bottom-pin tests passed.');
