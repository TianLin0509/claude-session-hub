'use strict';
// 2026-05-15 道雪 群聊弹顶 bug E2E 真实滚动保留验证
//
// 流程：
//   1. 启动隔离 Hub（CLAUDE_HUB_DATA_DIR + remote-debugging-port）
//   2. CDP attach
//   3. 按 e2e-group-chat-mode.js 模板创建 4 成员群聊 meeting，切到聊天视图
//   4. 通过 ipcRenderer 真实 invoke 'groupchat:turn' 发一条 user 消息
//      → 触发 triggerGroupChat → optimisticPartialBy 写 4 个 sid 的 thinking partial
//      → refreshRoundtablePanel 渲染 4 个 pending article（data-gc-msg-id=pending-${sid}）
//   5. 程序设置 .mr-gc-messages scrollTop 到中间位置（撑高内容确保可滚）
//   6. 直接通过 ipcRenderer.emit 触发 'groupchat-partial-update' 模拟 backend
//      流式回调（事件结构与真实 backend 一致，是 main → renderer 通道的内部 dispatch）
//   7. 断言 .mr-gc-messages 仍存在、scrollTop 没被钳到 0
//      （旧代码：partial 走 fallback panel.innerHTML 重渲 → scrollTop 被清；
//        新代码：走 _patchGroupChatPendingMessage 局部 patch → scrollTop 保留）
//
// PID 白名单：spawn 时记主进程 PID + 后续 diff 取 children；清理仅 kill 这些 PID。

const { spawn } = require('child_process');
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = parseInt(process.env.CDP_PORT || '9298', 10);
const DATA_DIR = process.env.HUB_DATA || path.join(os.tmpdir(), 'hub-e2e-scroll-preserve-' + Date.now());
const SCREENSHOT_DIR = path.join(HUB_DIR, 'tests', 'screenshots', 'group-chat-scroll-preserve');

let msgId = 0;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function rpc(ws, method, params = {}, timeout = 20000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`${method} timeout`)); }, timeout);
    function onMsg(raw) {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer); ws.off('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression, timeout = 20000) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1200));
  return r.result.value;
}

async function screenshot(ws, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fp = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 15000);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log(`  📸 ${fp}`);
  return fp;
}

async function attach(port) {
  for (let i = 0; i < 60; i++) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    const page = Array.isArray(list) && list.find(x => x.type === 'page' && !String(x.url).startsWith('devtools://'));
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      await rpc(ws, 'Page.enable'); await rpc(ws, 'Runtime.enable');
      return ws;
    }
    await sleep(1000);
  }
  throw new Error('CDP attach timeout');
}

function snapshotElectronPids() {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', { encoding: 'utf-8' });
    return new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number));
  } catch { return new Set(); }
}

function killPids(pids) {
  for (const pid of pids) {
    try { execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`); } catch {}
  }
}

function assertOk(cond, message, detail) {
  if (!cond) {
    const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
    throw new Error(message + suffix);
  }
  console.log('  ✓ ' + message);
}

(async () => {
  console.log(`[setup] isolated data dir: ${DATA_DIR}`);
  console.log(`[setup] CDP port: ${CDP_PORT}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // PID 白名单：启动前快照（feedback_e2e_pid_whitelist 铁律）
  const beforePids = snapshotElectronPids();
  console.log(`[setup] electron PIDs before: ${beforePids.size}`);

  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', c => logs.push(c.toString()));
  proc.stderr.on('data', c => logs.push(c.toString()));
  console.log(`[setup] spawned isolated Hub main PID=${proc.pid}`);

  // 等 3s 让 electron 把所有子进程拉起来再 diff
  await sleep(3500);
  const afterPids = snapshotElectronPids();
  const myPids = new Set([...afterPids].filter(p => !beforePids.has(p)));
  console.log(`[setup] my electron PIDs (after diff): ${[...myPids].join(',') || '(empty - using proc.pid)'}`);
  if (myPids.size === 0) myPids.add(proc.pid);

  let ws;
  let exitCode = 0;
  try {
    ws = await attach(CDP_PORT);
    console.log('[setup] CDP attached');
    await sleep(1500);

    // === 1. 打开群聊创建 modal ===
    await evalJs(ws, `document.getElementById('btn-group-chat').click()`);
    await sleep(800);
    await screenshot(ws, '1-modal-open');

    // === 2. 创建 4 成员群聊 ===
    await evalJs(ws, `document.getElementById('mcm-add-member').click()`);
    await sleep(400);
    await evalJs(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);

    // 等 meeting 创建完成
    let meeting = null;
    for (let i = 0; i < 60; i++) {
      const raw = await evalJs(ws, `(async () => {
        const { ipcRenderer } = require('electron');
        const meetings = await ipcRenderer.invoke('get-meetings') || [];
        return JSON.stringify(meetings.find(m => m.groupChat) || null);
      })()`, 10000);
      meeting = raw ? JSON.parse(raw) : null;
      if (meeting && Array.isArray(meeting.subSessions) && meeting.subSessions.length === 4) break;
      await sleep(1000);
    }
    assertOk(meeting && meeting.groupChat && meeting.subSessions.length === 4, '群聊 meeting 创建成功（4 成员）', meeting);

    // === 3. 打开群聊 meeting 并切到聊天视图 ===
    await evalJs(ws, `(() => {
      localStorage.removeItem('mr-group-chat-view-mode');
      const item = Array.from(document.querySelectorAll('.session-item.meeting')).find(el => el.textContent.includes('AI 群聊'));
      if (item) item.click();
    })()`);
    await sleep(1800);
    const view0 = await evalJs(ws, `(() => ({
      hasShell: !!document.querySelector('.mr-gc-shell'),
      hasMessages: !!document.querySelector('.mr-gc-messages'),
      messagesScrollHeight: document.querySelector('.mr-gc-messages')?.scrollHeight || 0,
      messagesClientHeight: document.querySelector('.mr-gc-messages')?.clientHeight || 0,
    }))()`);
    assertOk(view0.hasShell && view0.hasMessages, '群聊视图 DOM 就绪（mr-gc-shell + mr-gc-messages 存在）', view0);
    await screenshot(ws, '2-chat-view');

    // === 4. 通过真实 IPC 发起一轮（用户输入 → triggerGroupChat 写 optimisticPartialBy → 渲染 pending article） ===
    const subSessions = meeting.subSessions;
    const meetingId = meeting.id;
    const triggerResult = await evalJs(ws, `(async () => {
      // 模拟真人输入 + 回车流程：直接 invoke groupchat:turn（hub UI 的 input 回车也是这个 IPC）
      const { ipcRenderer } = require('electron');
      const r = await ipcRenderer.invoke('groupchat:turn', {
        meetingId: ${JSON.stringify(meetingId)},
        userInput: '滚动保留测试：请说一句话',
      });
      return r;
    })()`, 30000).catch(e => ({ error: e.message }));
    console.log('  [trigger] groupchat:turn result:', JSON.stringify(triggerResult).slice(0, 200));

    // 等 pending article 出现 + DOM 渲染完成
    let waited = 0;
    let pendingCount = 0;
    while (waited < 8000) {
      const r = await evalJs(ws, `document.querySelectorAll('.mr-gc-msg[data-gc-msg-id^="pending-"]').length`);
      pendingCount = r;
      if (pendingCount > 0) break;
      await sleep(400); waited += 400;
    }
    assertOk(pendingCount >= 1, `pending article 已渲染（带 data-gc-msg-id="pending-..." anchor），count=${pendingCount}`);

    // === 5. 撑高 .mr-gc-messages 内容（注入 spacer divs 确保可滚），并把 scrollTop 设到中间 ===
    const scrollSetup = await evalJs(ws, `(() => {
      const el = document.querySelector('.mr-gc-messages');
      // 注入 spacer 把内容撑出可滚动高度（每个 200px，10 个 = 2000px）
      for (let i = 0; i < 10; i++) {
        const spacer = document.createElement('div');
        spacer.style.cssText = 'height:200px;background:rgba(255,255,255,0.01);';
        spacer.className = 'mr-gc-msg ai test-spacer';
        spacer.setAttribute('data-gc-msg-id', 'test-spacer-' + i);
        el.appendChild(spacer);
      }
      // force layout
      void el.offsetHeight;
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      // 设到 maxTop/2 中间位置（确保不在底部 48px 内）
      const target = Math.floor(maxTop / 2);
      el.scrollTop = target;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, maxTop, target, actual: el.scrollTop };
    })()`);
    console.log('  [scroll] setup:', scrollSetup);
    assertOk(scrollSetup.maxTop >= 200, '.mr-gc-messages 可滚动（maxTop≥200）', scrollSetup);
    assertOk(scrollSetup.actual > 48 && scrollSetup.actual < scrollSetup.maxTop - 48, 'scrollTop 已设到中间（不在底部 48px stickToBottom 阈值内）', scrollSetup);
    await screenshot(ws, '3-scrolled-to-middle');

    // === 6. 真实 dispatch 一次 'groupchat-partial-update' 事件（结构与 backend 真实 emit 一致） ===
    //   ipcRenderer 是 EventEmitter，main 进程 webContents.send 在 renderer 端走的就是 emit。
    //   这里 renderer 自己 emit 等价于"main 真发了一次"，事件 payload 与真实 backend
    //   transcript-tap.js / groupchat-partial-update 路径完全一致。
    const sidForPartial = subSessions[0];
    const partialResult = await evalJs(ws, `(() => {
      const { ipcRenderer } = require('electron');
      // 模拟一次 streaming partial（status='streaming', text 含一段文字）
      ipcRenderer.emit('groupchat-partial-update', null, {
        meetingId: ${JSON.stringify(meetingId)},
        sid: ${JSON.stringify(sidForPartial)},
        status: 'streaming',
        text: '这是一段流式回答的中间内容，模拟 AI 思考输出。'.repeat(3),
        thinkSec: 2,
        tokens: { total: 100 },
        source: 'test_e2e_scroll_preserve',
      });
      return { dispatched: true };
    })()`);
    console.log('  [partial] dispatched:', partialResult);

    // 让 rAF + patch 完成
    await sleep(300);

    // === 7. 断言 scrollTop 没被钳到 0 ===
    const after = await evalJs(ws, `(() => {
      const el = document.querySelector('.mr-gc-messages');
      const pendingArticle = el?.querySelector('.mr-gc-msg[data-gc-msg-id="pending-${sidForPartial}"]');
      return {
        elExists: !!el,
        scrollTop: el?.scrollTop ?? -1,
        scrollHeight: el?.scrollHeight ?? -1,
        clientHeight: el?.clientHeight ?? -1,
        pendingArticleExists: !!pendingArticle,
        pendingArticleHtml: pendingArticle ? pendingArticle.outerHTML.slice(0, 400) : null,
      };
    })()`);
    console.log('  [after-partial] state:', after);
    await screenshot(ws, '4-after-partial');

    assertOk(after.elExists, '.mr-gc-messages 容器在 partial 之后仍然存在（没被 innerHTML 销毁重建）', after);
    assertOk(after.scrollTop >= scrollSetup.target - 5, `scrollTop 保留：partial 后 ${after.scrollTop} ≥ 期望中间值 ${scrollSetup.target}（容差 5px）`, after);
    assertOk(after.pendingArticleExists, 'pending article 被 outerHTML 替换后仍能按 anchor 找到', after);

    // === 8. 再来一次 partial（completed 态）— 完整 streaming → completed 流程 ===
    await evalJs(ws, `(() => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.emit('groupchat-partial-update', null, {
        meetingId: ${JSON.stringify(meetingId)},
        sid: ${JSON.stringify(sidForPartial)},
        status: 'completed',
        text: '【完成态】这是 AI 最终回答的完整内容。'.repeat(5),
        thinkSec: 5,
        tokens: { total: 200 },
        source: 'test_e2e_scroll_preserve',
      });
      return { dispatched: true };
    })()`);
    await sleep(300);
    const after2 = await evalJs(ws, `(() => {
      const el = document.querySelector('.mr-gc-messages');
      return { scrollTop: el?.scrollTop ?? -1, scrollHeight: el?.scrollHeight ?? -1 };
    })()`);
    console.log('  [after-completed] state:', after2);
    await screenshot(ws, '5-after-completed');
    assertOk(after2.scrollTop >= scrollSetup.target - 5, `completed 态后 scrollTop 仍保留：${after2.scrollTop} ≥ ${scrollSetup.target}（容差 5px）`, after2);

    console.log('\n✓ E2E PASSED：群聊在 partial-update (streaming/completed) 后 scrollTop 完整保留');
  } catch (e) {
    console.error('\n✗ E2E FAILED:', e.message);
    if (ws) { try { await screenshot(ws, 'failure'); } catch {} }
    console.error('---- Hub stdout/stderr tail ----');
    console.error(logs.join('').split('\n').slice(-30).join('\n'));
    exitCode = 1;
  } finally {
    if (ws) try { ws.close(); } catch {}
    // 清理：仅 kill diff 出来的 PID（feedback_e2e_pid_whitelist 铁律）
    console.log(`[cleanup] killing my PIDs: ${[...myPids].join(',')}`);
    killPids(myPids);
    // 二次 diff 确认所有新 PID 已清
    await sleep(1500);
    const finalPids = snapshotElectronPids();
    const stragglers = [...finalPids].filter(p => !beforePids.has(p));
    if (stragglers.length > 0) {
      console.warn(`[cleanup] stragglers detected (will retry kill): ${stragglers.join(',')}`);
      killPids(new Set(stragglers));
      await sleep(800);
    }
    // 清隔离数据目录
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); console.log(`[cleanup] removed ${DATA_DIR}`); } catch (e) { console.warn('[cleanup] rm DATA_DIR failed:', e.message); }
    process.exit(exitCode);
  }
})();
