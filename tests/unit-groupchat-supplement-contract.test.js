'use strict';
/**
 * 群聊插话闭环的契约（源码级）。
 *
 * 复现的缺陷：循环运行中在群聊输入框发一句话，renderer 照样调 loop:start，
 * 主进程以 already_running 拒绝，消息被退回输入框 —— 一个字都没送出去。
 *
 * 这几条断言守的是修完之后不许退回去：路由判据取主进程、不开新一轮、
 * 走闭环提交而不是盲发回车、送达确认之后才标已读。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

const room = read('renderer/meeting-room.js');
const dispatcher = read('main/groupchat/dispatcher.js');
const handler = read('main/ipc/groupchat-supplement-handlers.js');
const orchestrator = read('core/group-chat-orchestrator.js');

console.log('groupchat 插话闭环契约');

test('循环在跑时输入框不再调 loop:start，改走插话路径', () => {
  const branch = room.slice(room.indexOf('async function _routeLoopInput'), room.indexOf('function _startLoopWithGoal'));
  assert(/invoke\('loop:status'/.test(branch), '在不在跑要问主进程，不能信 renderer 缓存');
  assert(/_sendUserSupplement\(m, finalText\)/.test(branch), '在跑 → 插话');
  assert(/_startLoopWithGoal\(m, finalText, heroIdBySid\)/.test(branch), '没在跑 → 才是新任务');
  assert(!/loop:start/.test(branch), '插话路径里不许再出现 loop:start');
});

test('插话不开新一轮：主进程不走 dispatchGroupChatTurn', () => {
  assert(!/dispatchGroupChatTurn/.test(handler),
    '插话若走派发就会新开一轮、抢占当前步骤，语义完全错了');
  assert(/groupChatWatcher\.sendToPty\(/.test(handler), '要走和派工同一套闭环提交');
  assert(/requireReady: false/.test(handler), 'CLI 正在回答，不该再走一次 60 秒冷启动轮询');
  assert(!/terminal-input/.test(handler), '禁止裸 terminal-input 盲发回车');
});

test('先落盘，再谈投递：顺序不能反', () => {
  const appendAt = handler.indexOf('appendUserSupplement');
  const sendAt = handler.indexOf('sendToPty');
  assert(appendAt > 0 && sendAt > appendAt, '发送失败时消息也必须已经在群聊里留着');
});

test('送达确认之后才标已读；失败走另一条分支，账本原样留着', () => {
  const okBranch = dispatcher.slice(dispatcher.indexOf('if (ok) {'), dispatcher.indexOf('} else {', dispatcher.indexOf('if (ok) {')));
  assert(/markUserSupplementsDelivered\(t\.sid, t\.supplementSeqs\)/.test(okBranch),
    '标已读必须在发送成功分支里');
  assert(/orch\.markUserSupplementsDelivered\(sid, \[added\.seq\]\)/.test(handler));
  const failBlock = handler.slice(handler.indexOf('} else {', handler.indexOf('sendToPty')));
  assert(!/markUserSupplementsDelivered/.test(failBlock.slice(0, 400)),
    '发送失败不能标已读 —— 状态不明要保留待确认，不盲目重发');
});

test('待送达的补充逐条进下一次 prompt，且不动 assistant 增量游标', () => {
  assert(/pendingUserSupplementsFor\(member\.sid\)/.test(dispatcher), '每位成员各查各的账本');
  assert(/supplementBlock \? `\$\{basePrompt\}/.test(dispatcher), '没有待送达就一个字都不加');
  const methods = orchestrator.slice(orchestrator.indexOf('appendUserSupplement(text, opts'), orchestrator.indexOf('buildUserSupplementBlock(sid)'));
  assert(!/lastDeliveredSeq/.test(methods),
    '插话账本不许碰 assistant 发言游标，否则待命成员会跳过没读过的队友发言');
});

test('不靠 role 判身份：Hub 自己的阶段指令带 origin 标记，永远不进插话账本', () => {
  assert(/origin: ORIGIN_HUB/.test(orchestrator), '派发卡片标 hub');
  assert(/origin: ORIGIN_SYSTEM/.test(orchestrator), '系统提示标 system');
  assert(/m\.supplement === true && m\.origin === ORIGIN_USER/.test(orchestrator),
    '账本只认真实用户补充；老状态文件里没有 origin 的一律不进，避免把历史派工重新灌回去');
});

test('休眠成员只记账不唤醒', () => {
  assert(/不为了刷「全员已读」额外唤醒它/.test(handler), '这条取舍必须写在代码里，别只写在报告里');
  assert(!/resumeSession|wake/i.test(handler));
});

console.log(`\n${pass} passed`);
