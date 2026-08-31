'use strict';
// 2026-07-12 道雪：群聊气泡状态渲染契约（截图血泪回归）。
//   症状1：消息 errored + 空 content 落库后渲染成"空气泡 + 裸图标排"，用户不知道发生了什么；
//   症状2：pending 期 errored 显示「正在发言」+ 失败文案并存（状态矛盾）+ 光标还在闪；
//   症状3：同步按钮点失败后短暂显示裸「失败」，紧挨「正在发言」被误读成 AI 回答失败。
//   本测试用源码契约锁住修复形态，防回退。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const dispatcherSrc = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const orchestratorSrc = fs.readFileSync(path.join(root, 'core', 'group-chat-orchestrator.js'), 'utf8');
const cssSrc = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

// 1. errored 优先于 pending：不再出现「正在发言 + 发送失败」矛盾态。
//    组件内统一 settle 态防御（_isSettledStatus + isPending），不依赖调用方清 flag。
//    2026-07-29 道雪：状态列表从散落的硬编码改为集中判定 _isGcSettledStatus（新增
//    'interrupted' 用户中断态）。契约不变——settle 态一律排除 pending；这里改为锁
//    「必须走集中判定 + 集中判定必须覆盖四个无回答终态」，比硬编码列表更难漏。
assert.ok(
  /const _GC_SETTLED_NO_ANSWER = new Set\(\[[^\]]*'errored'[^\]]*\]\)/.test(rendererSrc) &&
  ["'errored'", "'absent'", "'superseded'", "'interrupted'"].every(
    s => new RegExp(`const _GC_SETTLED_NO_ANSWER = new Set\\(\\[[^\\]]*${s}[^\\]]*\\]\\)`).test(rendererSrc)),
  '集中的无回答终态集合必须覆盖 errored / absent / superseded / interrupted',
);
assert.ok(
  rendererSrc.includes('const _isSettledStatus = _isGcSettledStatus(status);') &&
  rendererSrc.includes('const isPending = !!opts.pending && !_isSettledStatus;') &&
  /const statusText = sendStuck \? '输入未提交'\s*\n\s*: status === 'errored' \? '发送失败'\s*\n\s*: isPending \? '正在发言'/.test(rendererSrc),
  'statusText 必须先区分输入未提交，再判 errored / pending，且 settle 态统一排除 pending',
);

// 2. superseded / absent 有明确状态标签，不再默默空白
assert.ok(
  rendererSrc.includes("status === 'superseded' ? '被新提问覆盖'") &&
  rendererSrc.includes("status === 'absent' ? '已跳过'"),
  'superseded/absent 消息需要明确状态标签',
);

// 3. 空内容非成功态消息渲染占位文案（不再是空气泡），且 CSS 有对应样式
assert.ok(
  rendererSrc.includes('mr-gc-empty-placeholder') &&
  rendererSrc.includes('本轮未收到回答') &&
  rendererSrc.includes('本轮回答被下一轮提问覆盖，未收录。') &&
  rendererSrc.includes('本轮已跳过该 AI，无回答。'),
  '空内容消息必须按 status 渲染占位文案',
);
assert.ok(cssSrc.includes('.mr-gc-empty-placeholder'), '占位文案必须有专属样式');

// 4. 旧的硬编码 pending 失败文案已移除（占位统一走 _renderGroupChatMessage）
assert.ok(
  !rendererSrc.includes('本轮发送失败，可切换到卡片视图查看处理按钮。'),
  '过时的"切换到卡片视图"硬编码文案应移除（聊天视图本身有同步按钮）',
);

// 5. 成功态但空内容仍显示「同步」逃生入口
assert.ok(
  /const _syncSettled = \(status === 'completed' \|\| status === 'manual_extracted'\) && hasContent;/.test(rendererSrc),
  '同步按钮显隐必须同时考虑状态与内容非空（PTY 干净退出兜底 settle 会产生空 completed）',
);

// 6. pending 光标对 settle 态（errored/absent/superseded）不闪；
//    settle 态被误标 empty 时不显示"思考中"（已结束的轮不存在思考中）
assert.ok(
  rendererSrc.includes("isPending ? '<span class=\"mr-ft-cursor\"></span>'"),
  'settle 态不得渲染闪烁输入光标（isPending 已含 settle 排除）',
);
assert.ok(
  rendererSrc.includes('if (opts.empty && !_isSettledStatus) {'),
  'settle 态即使 empty 也不得显示"思考中"占位',
);

// 7. pending 渲染调用方：settle 态（errored/absent/superseded/interrupted）不算 pending
//    2026-07-29 起两处都走集中判定 _isGcSettledStatus，不允许再散落硬编码列表。
assert.ok(
  (rendererSrc.match(/const settledPending = _isGcSettledStatus\(status\);/g) || []).length >= 2,
  '_renderGroupChatPending 与 _patchGroupChatPendingMessage 都必须排除 settle 态的 pending 标记',
);
assert.ok(
  !/const settledPending = status === 'errored'/.test(rendererSrc),
  'pending 判定不得回退到硬编码状态列表（漏一个状态就是永久"思考中"卡死）',
);

// 8. 失败原因链路：dispatcher partial-update 透传 reason → renderer 缓存 → 占位文案解释
assert.ok(dispatcherSrc.includes('reason: partial.reason'), 'dispatcher partial-update 必须带失败原因');
assert.ok(
  /groupchat-partial-update', \(_event, \{ meetingId, turnNum, sid, status, text, thinkSec, tokens, blocks, source, cleanBufLen, reason \}\)/.test(rendererSrc) &&
  rendererSrc.includes('reason: reason || undefined'),
  'renderer 必须接收并缓存 partial 的失败原因',
);
assert.ok(
  rendererSrc.includes('function _gcFailReasonLabel(reason)') &&
  rendererSrc.includes("if (r === 'auth_required') return"),
  '失败原因需映射为用户可读中文标签',
);

// 9. orchestrator 持久化 statusReason，手动补全成功后撤销
assert.ok(
  orchestratorSrc.includes('msg.statusReason = _failReason') &&
  orchestratorSrc.includes('delete msg.statusReason'),
  'orchestrator 必须持久化失败原因并在补全成功后清除',
);

// 10. 同步按钮失败短暂文案写全「同步失败」
assert.ok(
  !/btn\.textContent = '失败';/.test(rendererSrc) &&
  rendererSrc.includes("btn.textContent = '同步失败';"),
  '手动同步失败的按钮文案必须写全「同步失败」，防止与 AI 回答失败混淆',
);

console.log('gc message state render contract ok');
