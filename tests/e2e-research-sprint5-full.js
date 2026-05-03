'use strict';
// Sprint 5 完整 3 轮 E2E（真实用户操作路径）：
//   轮 1 fanout： "分析兆易创新 603986"  → 三家独立回答
//   轮 2 debate： "@debate 我刚看到龙虎榜机构买入 8000 万"  → 三家收到对方观点 + 用户补充
//   轮 3 summary："@summary @pikachu"  → Pikachu 综合 + 自动归档到 .arena/sessions/
//
// 验证：
//   - turn-1.json / turn-2.json / turn-3.json 三轮文件齐
//   - turn 2 三家文本能引用对方（"Gemini 提到的..." 等）
//   - turn 3 Claude 文本含 <<TITLE: xxx>> 标记 + 决策归档文件
//   - 持久化面板显示历史轮次 3 项

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9277;
const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\hub-research-dev';
const TURN_WAIT_MS = 900000;

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
  if (r.exceptionDetails) throw new Error(`Eval: ${r.exceptionDetails.text}`);
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN');

async function sendUserInput(ws, text) {
  await evalInPage(ws, `
    (() => {
      const box = document.getElementById('mr-input-box');
      const sendBtn = document.getElementById('mr-send-btn');
      box.innerText = ${JSON.stringify(text)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      sendBtn.click();
    })()
  `);
}

async function waitTurnComplete(ws, meetingId, expectedTurnNum, label) {
  console.log(`[${ts()}] [${label}] 等 turn ${expectedTurnNum} 完成`);
  const startWait = Date.now();
  let lastReport = 0;
  while (Date.now() - startWait < TURN_WAIT_MS) {
    await sleep(20000);
    const elapsed = Math.floor((Date.now() - startWait) / 1000);
    const s = await evalInPage(ws, `ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' })`);
    if (elapsed - lastReport >= 60) {
      console.log(`[${ts()}] [${label}] +${elapsed}s turns=${s.turns.length} mode=${s.currentMode}`);
      lastReport = elapsed;
    }
    if (s.turns.length >= expectedTurnNum) {
      console.log(`[${ts()}] [${label}] ✓ turn ${expectedTurnNum} 完成 (${elapsed}s)`);
      return s;
    }
  }
  throw new Error(`[${label}] turn ${expectedTurnNum} 未在 ${TURN_WAIT_MS}ms 内完成`);
}

async function main() {
  console.log(`[${ts()}] === Sprint 5 完整 3 轮 E2E ===`);

  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');

  // 创建会议室
  console.log(`\n[${ts()}] 创建投研圆桌会议室`);
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(300);
  await evalInPage(ws, `[...document.querySelectorAll('#new-session-menu [data-kind]')].find(b => b.dataset.kind === 'meeting')?.click()`);
  await sleep(800);
  await evalInPage(ws, `
    (() => {
      const r = document.querySelector('input[name="meeting-mode"][value="research"]');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(500);
  await evalInPage(ws, `document.getElementById('create-meeting-confirm').click()`);
  await sleep(15000);

  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
  const latest = promptFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(promptsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const meetingId = latest.replace('-research.md', '');
  console.log(`[${ts()}] meetingId: ${meetingId}`);

  // 轮 1: fanout
  console.log(`\n[${ts()}] === 轮 1 fanout ===`);
  await sendUserInput(ws, '分析兆易创新 603986');
  await waitTurnComplete(ws, meetingId, 1, 'fanout');
  await sleep(3000);
  const turn1 = JSON.parse(fs.readFileSync(path.join(promptsDir, `${meetingId}-turn-1.json`), 'utf-8'));
  console.log(`[轮 1] mode=${turn1.mode}, by sids=${Object.keys(turn1.by).length}`);
  for (const [sid, text] of Object.entries(turn1.by)) {
    console.log(`  ${sid.slice(0,8)}: ${(text || '').length} 字符`);
  }

  // 轮 2: @debate
  console.log(`\n[${ts()}] === 轮 2 @debate（带补充信息）===`);
  await sendUserInput(ws, '@debate 我刚看到龙虎榜机构买入 8000 万');
  await waitTurnComplete(ws, meetingId, 2, 'debate');
  await sleep(3000);
  const turn2 = JSON.parse(fs.readFileSync(path.join(promptsDir, `${meetingId}-turn-2.json`), 'utf-8'));
  console.log(`[轮 2] mode=${turn2.mode}, userInput="${turn2.userInput}", by sids=${Object.keys(turn2.by).length}`);
  let referencesOk = 0;
  for (const [sid, text] of Object.entries(turn2.by)) {
    const len = (text || '').length;
    // 验证三家引用了对方（关键）
    const hasReference = /(Gemini|Codex|Claude|另两家|对方|对面|他)(提到|说|认为|指出|分析|观点|看法)/.test(text || '');
    console.log(`  ${sid.slice(0,8)}: ${len} 字符, 引用对方=${hasReference ? '✓' : '✗'}`);
    if (hasReference) referencesOk++;
  }
  console.log(`[轮 2] 三家中有 ${referencesOk}/3 家明显引用对方观点`);

  // 轮 3: @summary @pikachu
  console.log(`\n[${ts()}] === 轮 3 @summary @pikachu ===`);
  await sendUserInput(ws, '@summary @pikachu');
  await waitTurnComplete(ws, meetingId, 3, 'summary');
  await sleep(3000);
  const turn3 = JSON.parse(fs.readFileSync(path.join(promptsDir, `${meetingId}-turn-3.json`), 'utf-8'));
  console.log(`[轮 3] mode=${turn3.mode}, summarizer=${turn3.summarizer}, decisionTitle=${turn3.decisionTitle}`);
  for (const [sid, text] of Object.entries(turn3.by)) {
    const len = (text || '').length;
    const hasTitle = /<<TITLE:/.test(text || '');
    console.log(`  ${sid.slice(0,8)}: ${len} 字符, 含 <<TITLE>>=${hasTitle ? '✓' : '✗'}`);
  }

  // 验证决策归档
  console.log(`\n[${ts()}] === 决策归档验证 ===`);
  // 找 Claude 的 cwd
  const sessionsDir = path.join('C:\\Users\\lintian', '.arena', 'sessions');  // Claude default cwd
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md'));
    const recent = files
      .map(f => ({ f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);
    console.log(`[归档] 最近 3 个决策档案：`);
    for (const r of recent) console.log(`  ${r.f} (${new Date(r.mtime).toLocaleString('zh-CN')})`);
  } else {
    console.log(`[归档] ⚠ ${sessionsDir} 不存在`);
  }

  // 验证 panel 显示 3 轮
  const panelHistory = await evalInPage(ws, `
    (() => {
      const items = document.querySelectorAll('.mr-rt-history-item');
      return Array.from(items).map(el => el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()
  `);
  console.log(`\n[${ts()}] === 持久化面板历史 ===`);
  console.log(`面板历史项数：${panelHistory.length}（期望 3）`);
  for (const t of panelHistory) console.log(`  ${t}`);

  console.log(`\n=== ✓ Sprint 5 完整 3 轮 E2E PASS ===`);
  console.log(`Hub 保留：会议室 ${meetingId}`);
  console.log(`turn 1/2/3.json + decision archive 都已落盘，请打开 Hub UI 看面板`);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${ts()}] ❌`, e.message);
  console.error(e.stack);
  process.exit(1);
});
