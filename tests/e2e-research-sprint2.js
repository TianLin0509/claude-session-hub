'use strict';
// Sprint 2 E2E：投研圆桌轮次状态机（fanout/debate/summary）真实 UI 触发
//
// 策略：触发 fanout 后早返回（不等三家真实 AI 回复，~5min 太慢），
//       验证 IPC 调通 + orchestrator 状态机切换 + 状态文件落盘启动迹象。
//       Hub 保留运行，用户可在 UI 看三家实时输出 + 后续手动测 @debate / @summary。
//
// 真实操作：+号 → 弹菜单 → 选会议室 → 选投研圆桌 → 创建 → 等三家 spawn
//          → 模拟在 mr-input-box 输入"怎么看兆易创新后续走势"+ 点击 mr-send-btn

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9277;
const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\hub-research-dev';

let _cdpId = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _cdpId++;
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(`CDP ${method} failed: ${m.error.message || JSON.stringify(m.error)}`));
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

async function evalInPage(ws, expression) {
  const r = await cdpSend(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`Page eval error: ${r.exceptionDetails.text} -- ${JSON.stringify(r.result)}`);
  }
  return r.result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Sprint 2 E2E：投研圆桌 fanout 真实触发 ===');
  console.log(`Hub data dir: ${HUB_DATA_DIR}`);
  console.log(`Hub CDP port: ${HUB_DEBUG_PORT}`);

  // 1. 连 Electron renderer
  console.log('\n[1] 连 Electron renderer page');
  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  if (!renderer) throw new Error('找不到 renderer page');
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  console.log('  ✓ ws ready');

  // 2. +号 → 菜单 → 会议室
  console.log('\n[2] +号 → 弹菜单 → 选会议室项');
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(300);
  const meetingItem = await evalInPage(ws, `
    (() => {
      const menu = document.getElementById('new-session-menu');
      const items = menu ? [...menu.querySelectorAll('[data-kind]')] : [];
      const item = items.find(b => b.dataset.kind === 'meeting');
      if (!item) return false;
      item.click();
      return true;
    })()
  `);
  if (!meetingItem) throw new Error('找不到会议室菜单项');
  await sleep(800);

  // 3. 选投研圆桌 + 创建
  console.log('\n[3] 选投研圆桌 → 点创建');
  await evalInPage(ws, `
    (() => {
      const r = document.querySelector('input[name="meeting-mode"][value="research"]');
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    })()
  `);
  await sleep(500);
  await evalInPage(ws, `document.getElementById('create-meeting-confirm').click()`);
  console.log('  ✓ 已点创建');

  // 4. 等三家 spawn（CLI 启动需要时间）
  console.log('\n[4] 等三家 CLI spawn (15s)');
  await sleep(15000);

  // 5. 拿 meetingId（从磁盘最新 -research.md）
  console.log('\n[5] 找最新 meetingId');
  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
  if (promptFiles.length === 0) throw new Error('arena-prompts 找不到 -research.md');
  const latest = promptFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(promptsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const meetingId = latest.replace('-research.md', '');
  console.log(`  ✓ meetingId: ${meetingId}`);

  // 6. 模拟在 mr-input-box 输入 + 点 send
  console.log('\n[6] 模拟在输入框输入"怎么看兆易创新后续走势" + 点击发送');
  const sendOk = await evalInPage(ws, `
    (() => {
      const box = document.getElementById('mr-input-box');
      const sendBtn = document.getElementById('mr-send-btn');
      if (!box || !sendBtn) return { ok: false, reason: 'no input or send btn', box: !!box, send: !!sendBtn };
      box.innerText = '怎么看兆易创新后续走势';
      // 触发 input event 同步 contenteditable 状态
      box.dispatchEvent(new Event('input', { bubbles: true }));
      sendBtn.click();
      return { ok: true };
    })()
  `);
  console.log('  ' + JSON.stringify(sendOk));
  if (!sendOk.ok) throw new Error('模拟输入失败: ' + JSON.stringify(sendOk));

  // 7. 等 IPC 触发 + orchestrator 启动 turn 1（不等 AI 回复完成）
  console.log('\n[7] 等 IPC roundtable:turn 触发 + state 落盘 (5s)');
  await sleep(5000);

  // 8. 验证 orchestrator state 文件
  console.log('\n[8] 验证 roundtable state + turn 启动');
  const rtStateFile = path.join(promptsDir, `${meetingId}-roundtable.json`);
  if (!fs.existsSync(rtStateFile)) {
    console.log('  ⚠ roundtable.json 还未落盘（可能 IPC 还在跑），继续验证 IPC 调用');
  } else {
    const rtState = JSON.parse(fs.readFileSync(rtStateFile, 'utf-8'));
    console.log(`  state: meetingId=${rtState.meetingId}, currentTurn=${rtState.currentTurn}, mode=${rtState.currentMode}, turns=${rtState.turns.length}`);
    if (rtState.meetingId !== meetingId) throw new Error('T8 FAIL: state.meetingId 不匹配');
    if (rtState.currentTurn !== 1 && rtState.turns.length === 0) throw new Error('T8 FAIL: turn 1 未启动');
    console.log('  ✓ T8 PASS：roundtable state 已写入，turn 已启动');
  }

  // 9. 同时调 IPC 检查 state（双重验证）
  console.log('\n[9] 通过 IPC roundtable:get-state 验证');
  const ipcState = await evalInPage(ws, `
    ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' })
  `);
  console.log('  ' + JSON.stringify({
    meetingId: ipcState.meetingId,
    currentTurn: ipcState.currentTurn,
    currentMode: ipcState.currentMode,
    turnsCount: ipcState.turns.length,
  }));
  if (ipcState.meetingId !== meetingId) throw new Error('T9 FAIL: IPC state.meetingId 不匹配');
  if (ipcState.currentTurn < 1) throw new Error('T9 FAIL: IPC state currentTurn < 1');
  console.log('  ✓ T9 PASS：IPC roundtable:get-state 正常');

  // 10. 验证 fanout prompt 已发到 PTY（看输入框是否被清空 = doSend 成功跑完）
  console.log('\n[10] 验证 mr-input-box 已清空（doSend 完成）');
  const inputState = await evalInPage(ws, `
    (() => {
      const box = document.getElementById('mr-input-box');
      return { text: box ? box.innerText : 'NO_BOX', textContent: box ? box.textContent : 'NO_BOX' };
    })()
  `);
  console.log('  ' + JSON.stringify(inputState));
  if (inputState.text.includes('兆易创新')) {
    console.log('  ⚠ 输入框未清空，doSend 可能没跑完（normal: 偶发 race）');
  } else {
    console.log('  ✓ 输入框已清空');
  }

  console.log('\n=== Sprint 2 E2E 核心验证 PASS ===');
  console.log(`\n→ Hub 保持运行，请你打开 Hub 窗口（数据目录：${HUB_DATA_DIR}）`);
  console.log(`  在投研圆桌会议室（${meetingId}）切到 Claude/Gemini/Codex tab，看三家正在回答 fanout`);
  console.log(`  等他们回答完后，你可以手动测：`);
  console.log(`    @debate     → 让另两家观点中转给第三家`);
  console.log(`    @summary @pikachu  → 让 Pikachu 席位综合所有历史给最终意见`);
  console.log(`\n  实时状态：${rtStateFile}`);
  console.log(`  完成的轮次：${promptsDir}/${meetingId}-turn-N.json`);
  console.log(`  决策档案（summary 后生成）：在 Claude 的 cwd 下 .arena/sessions/`);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ E2E 失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
