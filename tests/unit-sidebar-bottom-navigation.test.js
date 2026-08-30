'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'), 'utf8');
const meetingRoom = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (err.message || err));
  }
}

test('普通 session 与群聊的侧栏点击都显式请求跳到最新', () => {
  assert.match(sidebar, /selectSession\(intent\.id,\s*\{\s*forceScrollBottom:\s*true\s*\}\)/);
  assert.match(sidebar, /selectMeeting\(intent\.id,\s*\{\s*forceScrollBottom:\s*true\s*\}\)/);
  assert.match(sidebar, /addEventListener\('pointerdown'/);
  assert.match(sidebar, /addEventListener\('pointerup'/);
});

test('renderer 把群聊侧栏请求完整传给 MeetingRoom', () => {
  assert.match(renderer, /selectMeeting:\s*\(id,\s*opts\)\s*=>\s*selectMeeting\(id,\s*opts\)/);
  assert.match(renderer, /MeetingRoom\.openMeeting\(meetingId,\s*meeting,\s*\{[\s\S]{0,120}forceScrollBottom:\s*opts\.forceScrollBottom\s*===\s*true/);
});

test('普通卡片视图不再把显式置底限定为 Codex', () => {
  assert.match(renderer, /const forceScrollBottom = requestedBottomPin\s*\|\|\s*!!\(isCodexKind/);
  assert.match(renderer, /if \(forceScrollBottom\) \{[\s\S]{0,220}container\.scrollTop = container\.scrollHeight/);
});

test('群聊置底同时覆盖聊天流与多 AI 卡片滚动容器', () => {
  const start = meetingRoom.indexOf('function _scrollMeetingContentToBottom');
  const body = meetingRoom.slice(start, start + 1800);
  assert.ok(start >= 0, '缺少群聊统一置底函数');
  assert.match(body, /\.mr-gc-messages/);
  assert.match(body, /\.mr-ft-preview, \.mr-ft-bottom/);
  assert.match(body, /requestAnimationFrame/);
});

test('只有显式导航才强制群聊到底，普通刷新继续捕获原阅读位置', () => {
  assert.match(meetingRoom, /const forceMeetingBottom = opts\.forceMeetingBottom === true/);
  assert.match(meetingRoom, /:\s*_captureGroupChatScroll\(panel, meeting\)/);
  assert.match(meetingRoom, /forceMeetingBottom:\s*opts\.forceScrollBottom === true/);
});

console.log('Running sidebar bottom navigation contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
