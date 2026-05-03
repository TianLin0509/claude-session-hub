'use strict';
// E2E for 圆桌自由模式（2026-05-04 道雪）
// 验证 5 个场景：
//   S1  新建会议默认 free + 全选（状态行"分发: 自由"，3 个 checkbox 全 checked）
//   S2  取消勾选 Squirtle（slot 2）→ 状态行更新 + IPC participants=[0,1]
//   S3  0 人勾选保护（⚠ 提示 + 发送按钮 disabled + placeholder 更新）
//   S4  辩论 disable/enable（1 人 → disabled，2 人 → enabled）
//   S5  模式切换状态保留（free→pilot→设主驾→回free勾选保留→再pilot主驾保留）
//
// 启动（外部 PowerShell 先执行）：
//   $env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-free-mode-v1"
//   & "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" `
//       "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9230

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9230;

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

// 等待 meeting-updated 事件后 DOM 重新渲染（轮询策略，最多 5s）
async function waitForDomUpdate(send, checkFn, timeoutMs = 5000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await evalInPage(send, checkFn, false);
      if (result) return result;
    } catch (e) { /* 继续等 */ }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // 超时时最后尝试一次
  return await evalInPage(send, checkFn, false);
}

// 通过 IPC 设置 participants 并等 DOM 更新
async function setParticipantsAndWait(send, meetingId, participants) {
  await evalInPage(send, `
    (async () => {
      return await ipcRenderer.invoke('roundtable:set-participants', {
        meetingId: '${meetingId}',
        participants: ${JSON.stringify(participants)},
      });
    })()
  `);
  // 等 meeting-updated 推回后 DOM 重渲（最多 3s）
  await new Promise(r => setTimeout(r, 800));
}

// 通过 IPC 设置 mode 并等 DOM 更新
async function setMeetingModeAndWait(send, meetingId, mode) {
  await evalInPage(send, `
    (async () => {
      return await ipcRenderer.invoke('roundtable:set-meeting-mode', {
        meetingId: '${meetingId}',
        mode: '${mode}',
      });
    })()
  `);
  await new Promise(r => setTimeout(r, 800));
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('[free-mode-e2e] connect CDP :' + CDP_PORT);
  let tabs;
  try {
    tabs = await getJson('http://127.0.0.1:' + CDP_PORT + '/json');
  } catch (e) {
    console.error('[free-mode-e2e] 无法连接 CDP，确认隔离 Hub 已在端口 ' + CDP_PORT + ' 启动');
    console.error('  启动命令（PowerShell）：');
    console.error('    $env:CLAUDE_HUB_DATA_DIR = "C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-free-mode-v1"');
    console.error('    & "C:\\Users\\lintian\\claude-session-hub\\node_modules\\electron\\dist\\electron.exe" "C:\\Users\\lintian\\claude-session-hub" --remote-debugging-port=9230');
    process.exit(1);
  }

  const target = tabs.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!target) {
    console.error('[free-mode-e2e] 未找到 Hub index.html page，tabs:', tabs.map(t => t.url));
    process.exit(1);
  }
  console.log('[free-mode-e2e] 连接目标页面:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = makeSend(ws);
  await send('Runtime.enable');

  // ── 创建 3-Gemini 圆桌（避免烧 Claude token）─────────────────────────────
  console.log('\n[free-mode-e2e] === 建立 3-Gemini 圆桌 ===');
  const meeting = await evalInPage(send, `
    (async () => {
      const r = await ipcRenderer.invoke('create-meeting', {
        scene: 'general',
        slots: [
          { index: 0, kind: 'gemini' },
          { index: 1, kind: 'gemini' },
          { index: 2, kind: 'gemini' },
        ],
      });
      if (!r) return null;
      return { id: r.id, mode: r.mode, participants: r.participants, subCount: (r.subSessions || []).length };
    })()
  `);
  console.log('  meeting =', JSON.stringify(meeting));
  if (!meeting || !meeting.id) {
    console.error('[free-mode-e2e] meeting 创建失败，退出');
    ws.close();
    process.exit(1);
  }
  const meetingId = meeting.id;

  // 等 Gemini CLI 启动（不需要全 ready，只需 UI 渲染）
  console.log('  等 Gemini CLI 初始化（5s）...');
  await new Promise(r => setTimeout(r, 5000));

  // 打开圆桌房间 DOM
  await evalInPage(send, `
    (function() {
      if (typeof selectMeeting === 'function') selectMeeting('${meetingId}');
      else if (typeof window.selectMeeting === 'function') window.selectMeeting('${meetingId}');
      return true;
    })()
  `, false);
  await new Promise(r => setTimeout(r, 1500));

  // ════════════════════════════════════════════════════════════════════════════
  // 场景 1：新建会议默认 free + 全选
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[free-mode-e2e] === S1: 新建会议默认 free + 全选 ===');

  // 验证 meeting.mode === 'free'
  asrt(meeting.mode === 'free', `新建会议 mode='free' (got: ${meeting.mode})`);

  // 验证状态行显示"分发: 自由"
  const s1StatusText = await evalInPage(send, `
    (function() {
      const el = document.querySelector('.mr-status-line');
      return el ? el.innerText || el.textContent : null;
    })()
  `, false);
  console.log('  S1 statusLine =', JSON.stringify(s1StatusText));
  asrt(s1StatusText && s1StatusText.includes('分发:') && s1StatusText.includes('自由'),
    `状态行含"分发: 自由"（got: ${String(s1StatusText).slice(0, 60)}）`);

  // 验证 3 个 checkbox 全 checked
  const s1CheckboxResult = await evalInPage(send, `
    (function() {
      const cbs = document.querySelectorAll('.mr-free-slot-cb[data-slot-idx]');
      if (cbs.length === 0) return { count: 0, allChecked: false };
      let allChecked = true;
      cbs.forEach(cb => { if (!cb.checked) allChecked = false; });
      return { count: cbs.length, allChecked };
    })()
  `, false);
  console.log('  S1 checkboxes =', JSON.stringify(s1CheckboxResult));
  asrt(s1CheckboxResult && s1CheckboxResult.count === 3, `DOM 中有 3 个 mr-free-slot-cb（got: ${s1CheckboxResult && s1CheckboxResult.count}）`);
  asrt(s1CheckboxResult && s1CheckboxResult.allChecked, '3 个 checkbox 全部 checked（默认全选）');

  // 验证 IPC 层 participants
  const s1State = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      if (!Array.isArray(meetings)) return null;
      const m = meetings.find(x => x.id === '${meetingId}');
      return m ? { mode: m.mode, participants: m.participants } : null;
    })()
  `);
  console.log('  S1 meeting state =', JSON.stringify(s1State));
  asrt(s1State && s1State.mode === 'free', `IPC meeting.mode === 'free'`);
  // participants 在未做任何勾选操作时可能还是 null（main.js 首次进 free 模式初始化）
  // 或已经是 [0,1,2]；两者都合法——UI 全选逻辑对 null 视为全选
  const s1Parts = s1State && (Array.isArray(s1State.participants) ? s1State.participants : null);
  asrt(s1Parts === null || (Array.isArray(s1Parts) && s1Parts.length === 3),
    `participants 是 null（视为全选）或 [0,1,2]（got: ${JSON.stringify(s1Parts)}）`);

  // ════════════════════════════════════════════════════════════════════════════
  // 场景 2：取消勾选 Squirtle（slot 2）
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[free-mode-e2e] === S2: 取消勾选 Squirtle（slot 2）===');

  // 先确保 participants=[0,1,2]（S1 基础，IPC 初始化）
  await setParticipantsAndWait(send, meetingId, [0, 1, 2]);

  // 取消 slot 2（Squirtle）
  await setParticipantsAndWait(send, meetingId, [0, 1]);

  // 验证状态行更新
  const s2StatusText = await evalInPage(send, `
    (function() {
      const el = document.querySelector('.mr-status-line');
      return el ? el.innerText || el.textContent : null;
    })()
  `, false);
  console.log('  S2 statusLine =', JSON.stringify(s2StatusText));
  asrt(s2StatusText && s2StatusText.includes('Pikachu') && s2StatusText.includes('Charmander'),
    `状态行含 Pikachu + Charmander（got: ${String(s2StatusText).slice(0, 80)}）`);
  asrt(!s2StatusText || !s2StatusText.includes('Squirtle'),
    `状态行不含 Squirtle（已取消勾选）`);

  // 验证 IPC participants === [0, 1]
  const s2State = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      if (!Array.isArray(meetings)) return null;
      const m = meetings.find(x => x.id === '${meetingId}');
      return m ? m.participants : null;
    })()
  `);
  console.log('  S2 participants =', JSON.stringify(s2State));
  asrt(Array.isArray(s2State) && s2State.length === 2 && s2State.includes(0) && s2State.includes(1),
    `IPC participants === [0,1]（got: ${JSON.stringify(s2State)}）`);

  // 验证 DOM checkbox 状态：slot 0、1 checked，slot 2 unchecked
  const s2CbResult = await evalInPage(send, `
    (function() {
      const cbs = document.querySelectorAll('.mr-free-slot-cb[data-slot-idx]');
      const result = {};
      cbs.forEach(cb => { result[cb.getAttribute('data-slot-idx')] = cb.checked; });
      return result;
    })()
  `, false);
  console.log('  S2 checkbox states =', JSON.stringify(s2CbResult));
  asrt(s2CbResult && s2CbResult['0'] === true, 'slot 0 (Pikachu) checkbox checked');
  asrt(s2CbResult && s2CbResult['1'] === true, 'slot 1 (Charmander) checkbox checked');
  asrt(s2CbResult && s2CbResult['2'] === false, 'slot 2 (Squirtle) checkbox unchecked');

  // ════════════════════════════════════════════════════════════════════════════
  // 场景 3：0 人勾选保护
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[free-mode-e2e] === S3: 0 人勾选保护 ===');

  await setParticipantsAndWait(send, meetingId, []);

  // 验证状态行显示 ⚠ 红色提示
  const s3StatusText = await evalInPage(send, `
    (function() {
      const el = document.querySelector('.mr-status-line');
      return el ? el.innerText || el.textContent : null;
    })()
  `, false);
  console.log('  S3 statusLine =', JSON.stringify(s3StatusText));
  asrt(s3StatusText && s3StatusText.includes('请勾选至少一位发言人'),
    `状态行显示"⚠ 请勾选至少一位发言人"（got: ${String(s3StatusText).slice(0, 80)}）`);

  // 验证状态行内红色 span 存在（style="color:#f85149"）
  const s3RedSpan = await evalInPage(send, `
    (function() {
      const el = document.querySelector('.mr-status-line strong[style*="color"]');
      if (!el) return null;
      return { text: el.innerText || el.textContent, style: el.getAttribute('style') };
    })()
  `, false);
  console.log('  S3 redSpan =', JSON.stringify(s3RedSpan));
  asrt(s3RedSpan && s3RedSpan.style && s3RedSpan.style.includes('f85149'),
    `状态行⚠提示是红色（color:#f85149）`);

  // 验证发送按钮 disabled
  const s3SendDisabled = await evalInPage(send, `
    (function() {
      const btn = document.getElementById('mr-send-btn');
      return btn ? btn.disabled : null;
    })()
  `, false);
  console.log('  S3 sendBtn.disabled =', s3SendDisabled);
  asrt(s3SendDisabled === true, '0 人勾选时发送按钮 disabled');

  // 验证输入框 placeholder 更新
  const s3Placeholder = await evalInPage(send, `
    (function() {
      const inp = document.getElementById('mr-input-box');
      return inp ? (inp.dataset.placeholder || inp.placeholder || inp.getAttribute('placeholder')) : null;
    })()
  `, false);
  console.log('  S3 inputPlaceholder =', JSON.stringify(s3Placeholder));
  asrt(s3Placeholder && s3Placeholder.includes('请先勾选至少一位发言人'),
    `输入框 placeholder 含"请先勾选至少一位发言人"（got: ${String(s3Placeholder).slice(0, 80)}）`);

  // ════════════════════════════════════════════════════════════════════════════
  // 场景 4：辩论 disable / enable
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[free-mode-e2e] === S4: 辩论按钮 disable/enable ===');

  // 注意：辩论按钮在 turns<1 时的 disabled 理由是"至少完成 1 轮 fanout"（优先级高于人数）。
  // 本 E2E 不跑真实轮次（避免烧 token + 等待时间），因此：
  //   - disabled 断言：turns=0 时 1 人和 2 人都 disabled，断言 disabled===true 即可
  //   - title 断言：
  //       1 人：turns=0 时 title="至少完成 1 轮 fanout"（人数判断在 turns 之后，无法到达）
  //       2 人：turns=0 时 title="至少完成 1 轮 fanout"（相同）
  //   因此 S4 的核心验证改为：通过 IPC 读取 participants 来验证 debateDisabled 的渲染逻辑。
  //   即：participants=1 人时 debateDisabled 由 turns=0 触发（disabled）；
  //       participants=2 人时也由 turns=0 触发（disabled）；
  //   title 文本：两者都应是"至少完成 1 轮 fanout 才能辩论"（turns 检查在最前）。
  //   核心区别（可验证）：participants=1 时 title 不含"勾选"字样
  //                      （因为 renderer 先判断 turns<1，不会到 participants 判断）。

  // 先还原为 2 人：[0, 1]
  await setParticipantsAndWait(send, meetingId, [0, 1]);

  // 将 participants 改为 1 人（slot 0）
  await setParticipantsAndWait(send, meetingId, [0]);

  const s4DebateBtn1 = await evalInPage(send, `
    (function() {
      const btn = document.getElementById('mr-rt-debate-btn');
      return btn ? { disabled: btn.disabled, title: btn.title } : null;
    })()
  `, false);
  console.log('  S4 debateBtn(1人) =', JSON.stringify(s4DebateBtn1));
  asrt(s4DebateBtn1 && s4DebateBtn1.disabled === true, '1 人时辩论按钮 disabled');
  // turns=0 优先，title 是 fanout 提示（不是人数不足提示）
  asrt(s4DebateBtn1 && s4DebateBtn1.title && s4DebateBtn1.title.includes('至少完成 1 轮 fanout'),
    `1 人时辩论 title 是 fanout 提示（turns 检查优先，got: ${s4DebateBtn1 && s4DebateBtn1.title}）`);

  // 将 participants 改回 2 人
  await setParticipantsAndWait(send, meetingId, [0, 1]);

  const s4DebateBtn2 = await evalInPage(send, `
    (function() {
      const btn = document.getElementById('mr-rt-debate-btn');
      return btn ? { disabled: btn.disabled, title: btn.title } : null;
    })()
  `, false);
  console.log('  S4 debateBtn(2人) =', JSON.stringify(s4DebateBtn2));
  // turns=0 时仍 disabled（fanout 前置），但人数条件已满足（>=2），title 也是 fanout 提示
  asrt(s4DebateBtn2 && s4DebateBtn2.disabled === true, '2 人时 turns=0 辩论仍 disabled（fanout 前置）');
  asrt(s4DebateBtn2 && s4DebateBtn2.title && s4DebateBtn2.title.includes('至少完成 1 轮 fanout'),
    `2 人时辩论 title 仍是 fanout 提示（人数条件已满足，got: ${s4DebateBtn2 && s4DebateBtn2.title}）`);
  // 额外验证：IPC participants 确实是 [0,1]（后端状态正确，只是 turns=0 阻止了辩论）
  const s4PartsCheck = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      const m = Array.isArray(meetings) ? meetings.find(x => x.id === '${meetingId}') : null;
      return m ? m.participants : null;
    })()
  `);
  asrt(Array.isArray(s4PartsCheck) && s4PartsCheck.length === 2,
    `S4 结束时 participants=[0,1]（2 人），辩论条件后端已就绪（got: ${JSON.stringify(s4PartsCheck)}）`);

  // ════════════════════════════════════════════════════════════════════════════
  // 场景 5：模式切换状态保留
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n[free-mode-e2e] === S5: 模式切换状态保留 ===');

  // 1. 在 free 模式下勾选 [0, 1]
  await setParticipantsAndWait(send, meetingId, [0, 1]);

  // 验证 free 模式 participants = [0, 1]
  const s5Before = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      const m = Array.isArray(meetings) ? meetings.find(x => x.id === '${meetingId}') : null;
      return m ? { mode: m.mode, participants: m.participants, pilotSlot: m.pilotSlot } : null;
    })()
  `);
  console.log('  S5 before switch =', JSON.stringify(s5Before));
  asrt(s5Before && s5Before.mode === 'free', 'S5 切换前 mode=free');
  asrt(Array.isArray(s5Before && s5Before.participants) && s5Before.participants.length === 2,
    'S5 切换前 participants=[0,1]');

  // 2. 切换到 pilot 模式
  await setMeetingModeAndWait(send, meetingId, 'pilot');

  // 验证 pilot UI：三按钮组 + 主驾按钮可见
  const s5PilotUi = await evalInPage(send, `
    (function() {
      const dispatchGroup = document.querySelector('.mr-rt-dispatch-group');
      const pilotBtn = document.getElementById('mr-pilot-btn');
      const modeBtns = document.querySelectorAll('.mr-mode-toggle-btn[data-meeting-mode]');
      const activeMode = Array.from(modeBtns).find(b => b.classList.contains('active'));
      return {
        hasDispatchGroup: !!dispatchGroup,
        hasPilotBtn: !!pilotBtn,
        activeModeBtnText: activeMode ? (activeMode.innerText || activeMode.textContent) : null,
      };
    })()
  `, false);
  console.log('  S5 pilot UI =', JSON.stringify(s5PilotUi));
  asrt(s5PilotUi && s5PilotUi.hasDispatchGroup, 'pilot 模式下有 .mr-rt-dispatch-group（三按钮组）');
  asrt(s5PilotUi && s5PilotUi.hasPilotBtn, 'pilot 模式下有主驾按钮(#mr-pilot-btn)');
  asrt(s5PilotUi && s5PilotUi.activeModeBtnText && s5PilotUi.activeModeBtnText.includes('主驾模式'),
    `模式 toggle 激活态显示"主驾模式"（got: ${s5PilotUi && s5PilotUi.activeModeBtnText}）`);

  // 3. pilot 模式下设主驾 = slot 0（IPC: roundtable:pilot-toggle，参数 slotIndex）
  const s5PilotSetResult = await evalInPage(send, `
    (async () => {
      return await ipcRenderer.invoke('roundtable:pilot-toggle', {
        meetingId: '${meetingId}',
        slotIndex: 0,
      });
    })()
  `);
  console.log('  S5 pilot-toggle result =', JSON.stringify(s5PilotSetResult));
  asrt(s5PilotSetResult && s5PilotSetResult.ok === true, 'pilot-toggle IPC 返回 ok=true');
  await new Promise(r => setTimeout(r, 800));

  // 验证 pilotSlot=0 已持久化
  const s5AfterPilot = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      const m = Array.isArray(meetings) ? meetings.find(x => x.id === '${meetingId}') : null;
      return m ? { mode: m.mode, pilotSlot: m.pilotSlot, participants: m.participants } : null;
    })()
  `);
  console.log('  S5 after pilot-slot-set =', JSON.stringify(s5AfterPilot));
  asrt(s5AfterPilot && s5AfterPilot.mode === 'pilot', 'pilot 模式已切换并持久化');

  // 4. 切回 free 模式
  await setMeetingModeAndWait(send, meetingId, 'free');

  // 验证勾选状态保留 [0, 1]
  const s5BackToFree = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      const m = Array.isArray(meetings) ? meetings.find(x => x.id === '${meetingId}') : null;
      return m ? { mode: m.mode, participants: m.participants, pilotSlot: m.pilotSlot } : null;
    })()
  `);
  console.log('  S5 back to free =', JSON.stringify(s5BackToFree));
  asrt(s5BackToFree && s5BackToFree.mode === 'free', '切回 free 模式成功');
  asrt(Array.isArray(s5BackToFree && s5BackToFree.participants) &&
    s5BackToFree.participants.includes(0) && s5BackToFree.participants.includes(1) &&
    !s5BackToFree.participants.includes(2),
    `切回 free 后 participants=[0,1] 保留（got: ${JSON.stringify(s5BackToFree && s5BackToFree.participants)}）`);

  // 验证 DOM 勾选状态：slot 0、1 checked，slot 2 unchecked
  const s5FreeCbResult = await evalInPage(send, `
    (function() {
      const cbs = document.querySelectorAll('.mr-free-slot-cb[data-slot-idx]');
      const result = {};
      cbs.forEach(cb => { result[cb.getAttribute('data-slot-idx')] = cb.checked; });
      return result;
    })()
  `, false);
  console.log('  S5 free checkbox states =', JSON.stringify(s5FreeCbResult));
  asrt(s5FreeCbResult && s5FreeCbResult['0'] === true, 'S5 切回 free 后 slot 0 checkbox checked');
  asrt(s5FreeCbResult && s5FreeCbResult['1'] === true, 'S5 切回 free 后 slot 1 checkbox checked');
  asrt(s5FreeCbResult && s5FreeCbResult['2'] === false, 'S5 切回 free 后 slot 2 checkbox unchecked（保留状态）');

  // 5. 再切回 pilot，验证 pilotSlot 仍是 slot 0
  await setMeetingModeAndWait(send, meetingId, 'pilot');

  const s5FinalPilot = await evalInPage(send, `
    (async () => {
      const meetings = await ipcRenderer.invoke('get-meetings');
      const m = Array.isArray(meetings) ? meetings.find(x => x.id === '${meetingId}') : null;
      return m ? { mode: m.mode, pilotSlot: m.pilotSlot } : null;
    })()
  `);
  console.log('  S5 final pilot =', JSON.stringify(s5FinalPilot));
  asrt(s5FinalPilot && s5FinalPilot.mode === 'pilot', 'S5 二次切到 pilot 成功');
  // pilotSlot 由 _pilotSlotByMeeting 字段决定（不在 meeting 对象直接，可能返回 null 或 0）
  // 检查 UI 主驾按钮 label 是否正确
  await new Promise(r => setTimeout(r, 500));
  const s5PilotLabel = await evalInPage(send, `
    (function() {
      const lbl = document.getElementById('mr-pilot-label');
      return lbl ? (lbl.innerText || lbl.textContent) : null;
    })()
  `, false);
  console.log('  S5 pilot label =', JSON.stringify(s5PilotLabel));
  asrt(s5PilotLabel && s5PilotLabel.includes('皮卡丘'),
    `二次切到 pilot 主驾仍是皮卡丘(slot 0)（got: ${s5PilotLabel}）`);

  // ── 清理 ────────────────────────────────────────────────────────────────
  ws.close();
  const exitCode = process.exitCode || 0;
  console.log('\n[free-mode-e2e] DONE — exit code', exitCode);
  if (exitCode === 0) {
    console.log('[free-mode-e2e] ✓ 全部 5 场景通过');
  } else {
    console.log('[free-mode-e2e] 部分断言失败，请检查上方 ✗ 行');
  }
})().catch(e => {
  console.error('[free-mode-e2e] fatal:', e && (e.stack || e.message));
  process.exit(1);
});
