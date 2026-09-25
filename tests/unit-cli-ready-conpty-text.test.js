'use strict';
// 2026-09-25 真机：就绪检测对新版 CLI 全部失效 —— ConPTY 用光标右移代替空格、
// TUI 空闲时不停重画同一屏、Codex 0.153 新会话没有 "Context" 底栏；
// 同时启动选择框（模型退役提示）吞掉第一条粘贴，回车还替用户选了默认项。
const test = require('node:test');
const assert = require('node:assert/strict');
const ready = require('../core/group-chat-cli-ready-detector');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const E = '\x1b';

test('multi-word markers match through ConPTY cursor-forward spacing', () => {
  const raw = `${E}[38;5;244m⏸${E}[1Cmanual${E}[1Cmode${E}[1Con${E}[1C·${E}[1C←${E}[1Cfor${E}[1Cagents${E}[m`;
  assert.match(ready.terminalText(raw), /manual mode on · ← for agents/);
});

test('an idle TUI that keeps repainting the same screen still becomes ready', async () => {
  const sid = 'claude-repaint';
  ready.cleanup(sid);
  const frame = `${E}[?25l${E}[H› ${E}[2mTry "how does <filepath> work?"${E}[m\n${E}[1C⏸${E}[1Cmanual${E}[1Cmode${E}[1Con${E}[?25h`;
  let buf = 'x'.repeat(600);
  let readyAt = null;
  const end = Date.now() + ready.STABLE_MS + 1500;
  while (Date.now() < end && !readyAt) {
    buf += frame + `${E}[?25h${E}[?25l`;   // 光标闪烁：字节一直在涨，画面不变
    if (ready.isReady(sid, 'claude', buf)) readyAt = Date.now();
    await sleep(100);
  }
  assert.ok(readyAt, 'stable screen is ready even though the byte length keeps growing');
});

test('a startup choice dialog blocks readiness until the input row is back', async () => {
  const sid = 'codex-dialog';
  ready.cleanup(sid);
  const dialog = 'x'.repeat(600) + '\nGPT-5.5 retires on October 14, 2026.\n› 1. Try new model\n  2. Use existing model\n  Use ↑/↓ to move, press enter to confirm';
  assert.equal(ready.isChoiceDialogVisible('codex', dialog), true);
  ready.isReady(sid, 'codex', dialog);
  await sleep(ready.STABLE_MS + 100);
  assert.equal(ready.isReady(sid, 'codex', dialog), false, 'never ready while the dialog is up');
  const after = dialog + '\n╭ OpenAI Codex ╮\n› Ask Codex to do anything\n  gpt-5.6-sol low · ~\\work';
  assert.equal(ready.isChoiceDialogVisible('codex', after), false);
  ready.isReady(sid, 'codex', after);
  await sleep(ready.STABLE_MS + 100);
  assert.equal(ready.isReady(sid, 'codex', after), true);
});
