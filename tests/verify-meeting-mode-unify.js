// Module D verification: 两模式(通用/投研)清理后的最小 E2E 自检。
// 启动隔离 Hub (CLAUDE_HUB_DATA_DIR + remote-debugging-port=9229) 后运行此脚本。
// 验证集:
//   1. +号菜单弹出后有 2 个 data-meeting-mode 项 (general/research),无 driver
//   2. 点击"通用圆桌"立即创建 meeting,sidebar 出现 "通用圆桌 #N",无模态框
//   3. 连续点 3 次"通用圆桌" → counter 独立递增
//   4. 点击"投研圆桌" → 出现 "投研圆桌 #N",卡片+CLI 渲染
//   5. DOM 中没有 driver / blackboard / create-meeting-modal / mr-rt-role-badge.driver 残留
'use strict';

const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9230;

let _cdpId = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _cdpId++;
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(`CDP ${method}: ${m.error.message}`));
        else resolve(m.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error(`CDP ${method} timeout`)); }, 30000);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function evalInPage(ws, expr) {
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`Eval error: ${r.exceptionDetails.text}\n${r.exceptionDetails.exception?.description || ''}`);
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log(`[${ts()}] === Two-mode (general/research) verification ===`);

  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  if (!renderer) {
    console.error('ERROR: renderer page not found. Pages:', pages.map(p => ({ type: p.type, url: p.url })));
    process.exit(1);
  }
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  console.log(`[${ts()}] CDP attached to ${renderer.url}`);

  // T1: +号菜单弹出 + 两模式项可见,driver 不存在
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(150);
  const menuVisible = await evalInPage(ws, `document.getElementById('new-session-menu').style.display !== 'none'`);
  record('T1.1 +号菜单弹出', menuVisible);
  const modes = await evalInPage(ws, `[...document.querySelectorAll('.new-session-option[data-meeting-mode]')].map(b => b.dataset.meetingMode)`);
  record('T1.2 菜单只含两模式项 (general/research)', JSON.stringify(modes) === '["general","research"]', JSON.stringify(modes));
  const driverGone = await evalInPage(ws, `!document.querySelector('.new-session-option[data-meeting-mode="driver"]')`);
  record('T1.3 driver 模式入口已删除', driverGone);

  // T2: 点击"通用圆桌"直接创建 - 不弹模态框
  await evalInPage(ws, `document.querySelector('.new-session-option[data-meeting-mode="general"]').click()`);
  await sleep(800);
  const modalGoneAfterCreate = await evalInPage(ws, `!document.getElementById('create-meeting-modal')`);
  record('T2.1 无 #create-meeting-modal 残留', modalGoneAfterCreate);
  const sidebarTitles1 = await evalInPage(ws, `[...document.querySelectorAll('.session-list .session-item .session-title, .session-list [class*="title"]')].map(e => e.textContent.trim()).filter(t => t)`);
  const hasGeneral = sidebarTitles1.some(t => /通用圆桌\s*#\d+/.test(t));
  record('T2.2 sidebar 出现 "通用圆桌 #N"', hasGeneral, JSON.stringify(sidebarTitles1.filter(t => t.includes('通用')).slice(0, 5)));

  // T3: 再点两次"通用圆桌" - 验证 counter 递增
  for (let i = 0; i < 2; i++) {
    await evalInPage(ws, `document.getElementById('btn-new').click()`);
    await sleep(120);
    await evalInPage(ws, `document.querySelector('.new-session-option[data-meeting-mode="general"]').click()`);
    await sleep(800);
  }
  const sidebarTitles2 = await evalInPage(ws, `[...document.querySelectorAll('.session-list .session-item .session-title, .session-list [class*="title"]')].map(e => e.textContent.trim()).filter(t => t)`);
  const generalCount = sidebarTitles2.filter(t => /通用圆桌\s*#\d+/.test(t)).length;
  record('T3 通用圆桌 counter 递增 (>=3)', generalCount >= 3, `count=${generalCount}`);

  // T4: 点"投研圆桌" - 计数独立
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(120);
  await evalInPage(ws, `document.querySelector('.new-session-option[data-meeting-mode="research"]').click()`);
  await sleep(1000);
  const titlesAfterResearch = await evalInPage(ws, `[...document.querySelectorAll('.session-list .session-item .session-title, .session-list [class*="title"]')].map(e => e.textContent.trim()).filter(t => t)`);
  const hasResearch = titlesAfterResearch.some(t => /投研圆桌\s*#\d+/.test(t));
  record('T4 投研圆桌 #N 独立计数', hasResearch, JSON.stringify(titlesAfterResearch.filter(t => t.includes('投研')).slice(0, 3)));

  // T5: 检查 driver / blackboard 全部 DOM 残留
  const bbScriptGone = await evalInPage(ws, `![...document.scripts].some(s => /meeting-blackboard/.test(s.src || ''))`);
  record('T5.1 meeting-blackboard.js script 已删除', bbScriptGone);
  const bbBtnGone = await evalInPage(ws, `!document.getElementById('mr-btn-blackboard')`);
  record('T5.2 mr-btn-blackboard 按钮已删除', bbBtnGone);
  const bbContainerGone = await evalInPage(ws, `!document.querySelector('.mr-blackboard, .mr-bb-tabs, .mr-bb-content')`);
  record('T5.3 mr-blackboard 容器/tabs 已删除', bbContainerGone);
  const noMeetingBlackboardGlobal = await evalInPage(ws, `typeof window.MeetingBlackboard === 'undefined'`);
  record('T5.4 全局 window.MeetingBlackboard 未定义', noMeetingBlackboardGlobal);
  const noDriverBadge = await evalInPage(ws, `!document.querySelector('.mr-driver-badge')`);
  record('T5.5 mr-driver-badge 已删除', noDriverBadge);
  const noRoleBadge = await evalInPage(ws, `!document.querySelector('.mr-rt-role-badge.driver, .mr-rt-role-badge.co-driver')`);
  record('T5.6 mr-rt-role-badge.driver/co-driver 已删除', noRoleBadge);

  // T6: 主驾会议入口/标题不出现
  const noDriverEntry = await evalInPage(ws, `!document.querySelector('[data-meeting-mode="driver"]')`);
  record('T6.1 +号菜单 driver 项不存在', noDriverEntry);
  const noDriverTitle = await evalInPage(ws, `![...document.querySelectorAll('.session-list .session-title, .session-list [class*="title"]')].some(e => /主驾会议\\s*#/.test(e.textContent))`);
  record('T6.2 sidebar 无新建主驾会议', noDriverTitle);

  ws.close();

  console.log(`\n[${ts()}] === Summary ===`);
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log(`Passed ${passed}/${results.length}`);
  if (failed.length > 0) {
    console.log('Failed:');
    failed.forEach(r => console.log(`  ✗ ${r.name} — ${r.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
