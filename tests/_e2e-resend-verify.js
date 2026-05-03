'use strict';
// E2E for 圆桌 Resend & Auto-Recovery（2026-05-03 道雪）
// 验证场景：
//   Step 1  创建 3 claude 圆桌
//   Step 2  dispatch turn 1 + 等 settle（≤180s）
//   Step 3  场景 D — 手动 [📤 发送] IPC 验证（活跃 turn 或 settled 均合法返回）
//   Step 4  场景 C — mock send-stuck DOM → 验证 CSS 红边/黄底按钮渲染
//   Step 5  场景 E — smoke：turn 1 record 有 promptHeaderBy meta
//
// A/B 自动恢复分支（echoSeen 物理标志）由 unit-roundtable-resend.test.js 覆盖；
// E2E 只验证主路径打通 + CSS 可观测性。
//
// 启动（外部 PowerShell 先执行）：
//   $env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-resend-v1"
//   & "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" `
//       "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9253

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9253;

// ─── CDP 工具 ────────────────────────────────────────────────────────────────

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let _msgId = 0;
function makeSend(ws) {
  return function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++_msgId;
      const onMsg = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === id) {
          ws.off('message', onMsg);
          if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function evalInPage(send, expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  }
  return r.result && r.result.value;
}

function asrt(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.error('  ✗ ' + label); process.exitCode = 1; }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('[resend-e2e] connect CDP :' + CDP_PORT);
  let tabs;
  try {
    tabs = await getJson('http://127.0.0.1:' + CDP_PORT + '/json');
  } catch (e) {
    console.error('[resend-e2e] 无法连接 CDP，确认隔离 Hub 已在端口 ' + CDP_PORT + ' 启动');
    console.error('  启动命令：');
    console.error('    $env:CLAUDE_HUB_DATA_DIR = "C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-resend-v1"');
    console.error('    & "C:\\Users\\lintian\\claude-session-hub\\node_modules\\electron\\dist\\electron.exe" "C:\\Users\\lintian\\claude-session-hub" --remote-debugging-port=9253');
    process.exit(1);
  }

  const target = tabs.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!target) {
    console.error('[resend-e2e] 未找到 Hub index.html page，tabs:', tabs.map(t => t.url));
    process.exit(1);
  }
  console.log('[resend-e2e] 连接目标页面:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = makeSend(ws);
  await send('Runtime.enable');

  // ── Step 1：创建 3 claude 圆桌 ──────────────────────────────────────────
  console.log('\n[resend-e2e] === Step 1: create 3-claude meeting ===');
  const meeting = await evalInPage(send, `
    (async () => {
      const r = await ipcRenderer.invoke('create-meeting', {
        scene: 'general',
        slots: [
          { index: 0, kind: 'claude', model: 'claude-sonnet-4-5' },
          { index: 1, kind: 'claude', model: 'claude-sonnet-4-5' },
          { index: 2, kind: 'claude', model: 'claude-sonnet-4-5' },
        ],
      });
      // create-meeting 返回 meeting 对象直接（不是 { meeting: ... }）
      if (!r) return null;
      return { id: r.id, subCount: (r.subSessions || []).length };
    })()
  `);
  console.log('  meeting =', JSON.stringify(meeting));
  if (!meeting || !meeting.id) {
    console.error('[resend-e2e] meeting 创建失败，退出');
    ws.close();
    process.exit(1);
  }
  const meetingId = meeting.id;
  asrt(meeting.subCount >= 1, `subSessions 已挂载 (count=${meeting.subCount})`);

  // 等 CLI 起来（圆桌 3 个 claude CLI 最多需要 ~10s）
  console.log('  等待 CLI 初始化（10s）...');
  await new Promise(r => setTimeout(r, 10000));

  // ── Step 2：dispatch turn 1 + 等 settle（≤180s）──────────────────────────
  console.log('\n[resend-e2e] === Step 2: dispatch turn 1 + wait settle ===');
  const dispatchResult = await evalInPage(send, `
    (async () => {
      return await ipcRenderer.invoke('roundtable:turn', {
        meetingId: '${meetingId}',
        mode: 'fanout',
        userInput: '请用一句话简述你的功能',
      });
    })()
  `);
  console.log('  dispatch result =', JSON.stringify(dispatchResult));

  // 等 turn settle：每 5s 检查 state.turns.length > 0，最多 180s
  let settled = false;
  let turnsCount = 0;
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const stateObj = await evalInPage(send, `
      (async () => {
        // roundtable:get-state 直接返回 state 对象
        return await ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' });
      })()
    `);
    turnsCount = stateObj && Array.isArray(stateObj.turns) ? stateObj.turns.length : 0;
    const currentMode = stateObj && stateObj.currentMode;
    if (turnsCount > 0 && currentMode === 'idle') {
      settled = true;
      console.log(`  ✓ turn 1 settled at ~${(i + 1) * 5}s，turns=${turnsCount}，mode=${currentMode}`);
      break;
    }
    if ((i + 1) % 6 === 0) {
      console.log(`  ... 等待中 ${(i + 1) * 5}s，turns=${turnsCount}，mode=${currentMode}`);
    }
  }
  asrt(settled, `turn 1 在 180s 内 settle（turns=${turnsCount}）`);

  // ── Step 3：场景 D — roundtable-resend-prompt IPC 验证 ──────────────────
  // turn 1 settle 后 currentMode='idle'，resend 会返回 no_active_turn（正常）。
  // 发 turn 2，在进行中时立即调 resend 才会拿到有效 prompt。
  // 但 CLI 可能很快就处理完——所以我们验证：
  //   a) IPC 本身可调用不报异常
  //   b) 返回值是合法结构 { ok, reason? / mode? }
  //   c) 若有 mode：必须是 enter_only 或 rewrite_full
  console.log('\n[resend-e2e] === Step 3: 手动 [📤 发送] IPC 可达性验证 ===');

  // 先拿 subSessions[0]
  const firstSid = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      const m = Array.isArray(meetings) ? meetings.find(x => x.id === '${meetingId}') : null;
      return m && Array.isArray(m.subSessions) && m.subSessions.length > 0 ? m.subSessions[0] : null;
    })()
  `);
  console.log('  firstSid =', firstSid);
  asrt(!!firstSid, '获取到 firstSid');

  if (firstSid) {
    // 发 turn 2 并立刻（不等 settle）调 resend
    await evalInPage(send, `
      ipcRenderer.invoke('roundtable:turn', {
        meetingId: '${meetingId}',
        mode: 'fanout',
        userInput: '再补充一点',
      });
    `, false);  // 不 await，让 turn 在后台跑
    // 稍微等一下让 recordTurnPrompt 写入
    await new Promise(r => setTimeout(r, 2000));

    const resendResult = await evalInPage(send, `
      (async () => {
        return await ipcRenderer.invoke('roundtable-resend-prompt', {
          meetingId: '${meetingId}',
          sid: '${firstSid}',
        });
      })()
    `);
    console.log('  resend result =', JSON.stringify(resendResult));

    // IPC 必须返回合法对象（不是 null/undefined/异常）
    asrt(resendResult !== null && resendResult !== undefined, 'roundtable-resend-prompt IPC 可达且返回非空');
    asrt(typeof resendResult.ok === 'boolean', 'resendResult.ok 是 boolean');

    if (resendResult.ok === true) {
      // 成功路径：必须有 mode
      asrt(
        resendResult.mode === 'enter_only' || resendResult.mode === 'rewrite_full',
        `mode in {enter_only, rewrite_full}, got: ${resendResult.mode}`
      );
      console.log(`  ✓ 场景 D 完整命中：ok=true mode=${resendResult.mode}`);
    } else {
      // 失败路径：reason 必须是已知值（not unknown/exception）
      const knownReasons = ['no_active_turn', 'no_active_prompt', 'meeting_not_found', 'invalid_args', 'verify_failed'];
      asrt(
        knownReasons.includes(resendResult.reason),
        `resend reason 是已知值: ${resendResult.reason}（因为 turn 已 settle，no_active_turn 是合法状态）`
      );
    }
  }

  // 等 turn 2 settle（最多 90s），避免影响后续状态检查
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const stateObj = await evalInPage(send, `
      (async () => { return await ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' }); })()
    `);
    const mode2 = stateObj && stateObj.currentMode;
    if (mode2 === 'idle') {
      console.log('  turn 2 settle 完成');
      break;
    }
  }

  // ── Step 4：场景 C — mock send-stuck DOM → 验证 CSS 红边/黄底按钮渲染 ──
  console.log('\n[resend-e2e] === Step 4: mock send-stuck → 验证 CSS 视觉渲染 ===');
  // 确保圆桌房间已打开（selectMeeting 是 renderer.js 顶层函数，CDP 可直接调用）
  await evalInPage(send, `
    (function(){
      const mid = '${meetingId}';
      if (typeof selectMeeting === 'function') {
        selectMeeting(mid);
      } else if (typeof window.selectMeeting === 'function') {
        window.selectMeeting(mid);
      }
      return true;
    })()
  `, false);
  // 等 DOM 渲染完成（卡片 DOM 生成）
  await new Promise(r => setTimeout(r, 3000));

  // 先验证 CSSOM 中 send-stuck 规则已注册
  const cssomCheck = await evalInPage(send, `
    (function(){
      const sheets = document.styleSheets;
      let found = [];
      for(let i=0; i<sheets.length; i++){
        try {
          const rules = sheets[i].cssRules;
          for(let j=0; j<rules.length; j++){
            const r = rules[j];
            if(r.selectorText && r.selectorText.includes('send-stuck') && r.style){
              found.push({ sel: r.selectorText, text: r.style.cssText });
            }
          }
        } catch(e){}
      }
      return found;
    })()
  `, false);
  console.log('  CSSOM send-stuck rules:', JSON.stringify(cssomCheck));

  // 先加 send-stuck 类，同时禁用 CSS transition 避免颜色渐变导致读取时序问题
  await evalInPage(send, `
    (function(){
      const sid = '${firstSid || ''}';
      let card = sid ? document.querySelector('.mr-ft[data-ft-sid="' + sid + '"]') : null;
      if (!card) card = document.querySelector('.mr-ft');
      if (!card) return false;
      // 暂时禁用 transition 让颜色立即生效
      card.style.transition = 'none';
      const btn = card.querySelector('button[data-rt-escape="resend-prompt"]');
      if (btn) btn.style.transition = 'none';
      card.classList.add('send-stuck');
      const stEl = card.querySelector('.mr-ft-status');
      if (stEl) stEl.classList.add('send-stuck');
      // 强制 reflow 刷新样式
      void card.getBoundingClientRect();
      return true;
    })()
  `, false);

  // 等 Chromium 样式重算完成（transition 已禁用，200ms 足够）
  await new Promise(r => setTimeout(r, 200));

  const stuckResult = await evalInPage(send, `
    (function(){
      // 找卡片
      const sid = '${firstSid || ''}';
      let card = sid ? document.querySelector('.mr-ft[data-ft-sid="' + sid + '"]') : null;
      if (!card) card = document.querySelector('.mr-ft');
      if (!card) return { found: false, reason: 'no mr-ft card in DOM' };

      const btn = card.querySelector('button[data-rt-escape="resend-prompt"]');

      // 读取已重算后的计算样式
      var cs = window.getComputedStyle(card);
      var blColor = cs.borderLeftColor;
      var blWidth = cs.borderLeftWidth;
      var blStyle = cs.borderLeftStyle;

      var btnBg = null;
      if (btn) {
        btnBg = window.getComputedStyle(btn).backgroundColor;
      }

      // 解析 rgb(R, G, B) 字符串——用 split 而非正则，避免模板字符串转义问题
      function parseRgb(str) {
        if (!str || str.indexOf('rgb(') < 0) return null;
        var inner = str.slice(str.indexOf('(') + 1, str.lastIndexOf(')'));
        var parts = inner.split(',').map(function(x) { return parseInt(x.trim(), 10); });
        return (parts.length >= 3 && !isNaN(parts[0])) ? parts : null;
      }
      var bl = parseRgb(blColor);
      // RGB(248, 81, 73) = #f85149（send-stuck 红）：R>230, G<120, B<120
      var hasRedBorder = !!(bl && bl[0] > 230 && bl[1] < 120 && bl[2] < 120
        && (blStyle !== 'none') && (parseFloat(blWidth) >= 3));

      // RGB(255, 193, 7) = #ffc107（黄底）：R>240, G>150, B<50
      var bg = btnBg ? parseRgb(btnBg) : null;
      var hasYellowBtn = !!(bg && bg[0] > 240 && bg[1] > 150 && bg[2] < 50);

      return {
        found: true,
        hasBtn: !!btn,
        blColor, blWidth, blStyle,
        btnBg,
        hasRedBorder,
        hasYellowBtn,
        cardClass: card.className,
      };
    })()
  `, false);
  console.log('  stuckResult =', JSON.stringify(stuckResult));

  asrt(stuckResult.found, 'DOM 中找到圆桌卡片(.mr-ft)');
  asrt(stuckResult.hasBtn, '[📤 发送] 按钮(button[data-rt-escape="resend-prompt"]) 已渲染');
  asrt(stuckResult.hasRedBorder,
    `send-stuck 红边渲染（border-left: ${stuckResult.blWidth} ${stuckResult.blStyle} ${stuckResult.blColor}）`);
  asrt(stuckResult.hasYellowBtn,
    `[📤 发送] 按钮黄底渲染（background: ${stuckResult.btnBg}）`);

  // ── Step 5：场景 E — promptHeaderBy 元数据 smoke ────────────────────────
  console.log('\n[resend-e2e] === Step 5: patch-after-settle smoke — turn 1 promptHeaderBy ===');
  const stateForMeta = await evalInPage(send, `
    (async () => {
      return await ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' });
    })()
  `);
  const turns = stateForMeta && Array.isArray(stateForMeta.turns) ? stateForMeta.turns : [];
  const t1 = turns.length > 0 ? turns[0] : null;
  console.log('  turn 1 record keys =', t1 ? Object.keys(t1).join(', ') : '(no turns)');

  if (t1) {
    const hasPromptHeaderBy = !!(t1.promptHeaderBy && Object.keys(t1.promptHeaderBy).length > 0);
    asrt(hasPromptHeaderBy, 'turn 1 record 有 promptHeaderBy meta（recordTurnPrompt + completeTurn 集成正常）');
    if (hasPromptHeaderBy) {
      const headerSample = Object.values(t1.promptHeaderBy)[0];
      console.log('  promptHeaderBy[0] =', String(headerSample).slice(0, 80));
    }
  } else {
    // 如果轮次为空，说明 turn 根本没跑成功（可能 CLI 没 ready）
    asrt(false, 'turn 1 record 存在（需要 CLI 真实完成一轮）— 可能 CLI 未就绪，此场景标记跳过');
  }

  // ── 清理 ────────────────────────────────────────────────────────────────
  ws.close();
  const exitCode = process.exitCode || 0;
  console.log('\n[resend-e2e] DONE — exit code', exitCode);
  if (exitCode !== 0) {
    console.log('\n[resend-e2e] 部分断言失败。A/B/C mock 场景由单元测试覆盖（unit-roundtable-resend.test.js）。');
  }
})().catch(e => {
  console.error('[resend-e2e] fatal:', e && (e.stack || e.message));
  process.exit(1);
});
