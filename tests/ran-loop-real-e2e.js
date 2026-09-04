'use strict';
/**
 * RAN 循环 · 真实多 AI E2E（2026-09-04）
 *
 * 这支测的是唯一没法靠单测覆盖的东西：**Claude ↔ Codex 的循环到底转不转得起来**。
 * 真起 CLI 会话、真跑代码、真判 RESULT、真推进轮次。
 *
 * 安全边界（重要）：
 *   · 隔离 Hub：独立 data dir + 独立 CDP 端口 9357，跑完按 PID 清理，不碰生产 Hub
 *   · **不用 RAN 预设本身** —— 那两个预设会让 agent 改真仓库并合并 PR。
 *     这里用同构的两步循环（builder → reviewer + RESULT 契约），
 *     工作目录指向一次性沙箱，验的是同一条引擎路径。
 *   · 沙箱：一个故意写错的 add()，AI 修好它就算走通
 *
 * 用法：node tests/ran-loop-real-e2e.js
 * 需要：本机 Claude 与 Codex CLI 已登录（读的是文件态凭据，不依赖 env）
 */
const WebSocket = require('ws');
const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HUB = 'C:\\Users\\lintian\\claude-session-hub';
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9357;
const CDP = `http://127.0.0.1:${PORT}`;
const SANDBOX = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\ran-loop-sandbox';
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-ran-loop-e2e';

const TOTAL_BUDGET_MS = 22 * 60 * 1000;      // 整支测试的上限
const t0 = Date.now();
const el = () => `${String(Math.floor((Date.now() - t0) / 1000)).padStart(4)}s`;
const log = (m) => console.log(`[${el()}] ${m}`);

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
  });
}

function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({
      send(method, params = {}) {
        const i = id++;
        return new Promise((r, j) => { pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
      },
      close() { ws.close(); },
    }));
    ws.on('error', rej);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pend.has(m.id)) {
        const { r, j } = pend.get(m.id); pend.delete(m.id);
        if (m.error) j(new Error(m.error.message)); else r(m.result);
      }
    });
  });
}

function launchHub() {
  const env = Object.assign({}, process.env);
  ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID'].forEach(k => delete env[k]);
  env.CLAUDE_HUB_DATA_DIR = DATA_DIR;
  return spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: HUB, env, stdio: 'ignore' });
}
const killTree = (pid) => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} };

function resetSandbox() {
  fs.writeFileSync(path.join(SANDBOX, 'calc.py'),
    'def add(a, b):\n    return a - b          # 故意写错：应该是 a + b\n', 'utf-8');
}

function sandboxFixed() {
  try {
    execSync('python test_calc.py', { cwd: SANDBOX, stdio: 'ignore', timeout: 30000 });
    return true;
  } catch (e) { return false; }
}

async function main() {
  if (!fs.existsSync(SANDBOX)) { console.error('沙箱不存在：' + SANDBOX); process.exit(2); }
  resetSandbox();
  log(`沙箱已重置，测试当前状态：${sandboxFixed() ? '意外通过（应为失败）' : '失败（符合预期）'}`);

  const child = launchHub();
  let verdict = { ok: false, why: '未开始' };

  try {
    log('等隔离 Hub 起来…');
    let targets;
    for (let i = 0; i < 40; i++) {
      try {
        targets = JSON.parse(await get(`${CDP}/json/list`));
        if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    const tgt = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url));
    if (!tgt) throw new Error('CDP 无 page target');

    const cdp = await newCdp(tgt.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const ev = async (expr, awaitPromise = true) => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) {
        throw new Error('EVAL: ' + ((r.exceptionDetails.exception || {}).description || 'unknown'));
      }
      return r.result.value;
    };
    for (let i = 0; i < 25; i++) {
      if (await ev('typeof window.WorkflowTemplates').catch(() => '') === 'object') break;
      await new Promise(r => setTimeout(r, 800));
    }
    log('renderer 就绪');

    // ── 建群聊：Claude + Codex，工作目录指向沙箱 ──
    const meetingId = await ev(`(async()=>{
      const { ipcRenderer } = require('electron');
      const m = await ipcRenderer.invoke('create-meeting', {
        title: 'RAN 循环真实 E2E',
        workspace: ${JSON.stringify(SANDBOX)},
        slots: [{ index:0, kind:'claude' }, { index:1, kind:'codex' }],
      });
      return m && m.id;
    })()`);
    if (!meetingId) throw new Error('建群聊失败');
    log(`群聊已建：${meetingId}`);

    // ── 等两个 CLI 会话就绪 ──
    // memberId 是位置约定：loop-engine 的 sidOf() 把 'm1' 解析成 subSessions[0]。
    // 所以要等的是 meeting.subSessions 长到 2，不是去问 groupchat:get-state
    // （那个返回的是聊天记录状态，不是成员，第一版就栽在这儿）。
    let subs = [];
    for (let i = 0; i < 90; i++) {
      subs = await ev(`(async()=>{
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = (ms || []).find(x => x.id === ${JSON.stringify(meetingId)});
        return (m && m.subSessions) || [];
      })()`).catch(() => []);
      if (subs.length >= 2) break;
      if (i % 10 === 9) log(`  …已等 ${(i + 1) * 2}s，subSessions=${subs.length}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (subs.length < 2) throw new Error('会话没起来，subSessions=' + JSON.stringify(subs));
    const claude = { id: 'm1' };
    const codex = { id: 'm2' };
    log(`会话就绪：subSessions=${subs.length} → builder=m1 / reviewer=m2`);
    await new Promise(r => setTimeout(r, 25000));       // 给 CLI 首屏一点时间

    // ── 写工作流：与 RAN 收口同构的两步循环 ──
    const wf = {
      enabled: true,
      steps: [[claude.id], [codex.id]],
      stepConfigs: [
        {
          name: '修复',
          timeoutMs: 8 * 60 * 1000,
          prompt: '修好当前目录 calc.py 里的 add()，让 python test_calc.py 通过。'
            + '只改这一处，不要动别的文件。改完自己跑一次 python test_calc.py 确认。'
            + '若收到上一轮的阻断项，只修阻断项。',
        },
        {
          name: '验收',
          timeoutMs: 8 * 60 * 1000,
          prompt: '只读审查，不要改代码。亲自运行 python test_calc.py 看真实结果。'
            + '通过才判 PASS。\n最后严格输出四行：\nRESULT: PASS 或 FAIL\n'
            + 'BLOCKERS: 无，或列出必须修复的问题\nVERIFIED: 实际执行的验证及结果\nNEXT: 无，或下一步建议',
        },
      ],
      loop: { enabled: true, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false },
    };
    await ev(`(()=>{
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('update-meeting', { meetingId: ${JSON.stringify(meetingId)},
        fields: { serialWorkflow: ${JSON.stringify(wf)} } });
      return true;
    })()`, false);
    await new Promise(r => setTimeout(r, 1500));
    log('工作流已写入（builder=Claude，reviewer=Codex，maxRounds=3）');

    // ── 启动循环 ──
    const started = await ev(`(async()=>{
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('loop:start', {
        meetingId: ${JSON.stringify(meetingId)},
        userInput: '修好 calc.py 里的 add()，让 test_calc.py 通过',
      });
    })()`);
    log('loop:start → ' + JSON.stringify(started));
    if (!started || !started.ok) throw new Error('启动失败：' + JSON.stringify(started));

    // ── 盯状态 ──
    let last = '';
    while (Date.now() - t0 < TOTAL_BUDGET_MS) {
      await new Promise(r => setTimeout(r, 15000));
      const st = await ev(`(async()=>{
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('loop:status', { meetingId: ${JSON.stringify(meetingId)} });
      })()`).catch(() => null);
      const brief = JSON.stringify(st);
      if (brief !== last) { log('状态 ' + brief); last = brief; }
      // 状态在 st.loopState.status —— 不是 st.status，也不是 st.state.status。
      // 第一版取错层级，永远拿到空串，明明 done 了还一直轮询到超预算。
      const ls = (st && st.loopState) || {};
      const s = ls.status || '';
      const running = st && (st.running === true);
      if (s) {
        const rounds = ls.round || 0;
        const passes = (ls.history || []).filter(h => h.pass).length;
        if (s === 'done') {
          verdict = { ok: true, why: `达标结束，${rounds} 轮，${passes} 次 PASS`, status: s, rounds };
          break;
        }
        if (!running) { verdict = { ok: false, why: '非达标结束：' + s, status: s, rounds }; break; }
      } else if (!running && Date.now() - t0 > 60000) {
        verdict = { ok: false, why: '循环没跑起来（status 为空且已停）' }; break;
      }
    }
    if (!verdict.status) verdict = { ok: false, why: '超出预算仍未结束' };

    cdp.close();
  } catch (e) {
    verdict = { ok: false, why: '异常：' + (e && e.message) };
  } finally {
    killTree(child.pid);
  }

  const fixed = sandboxFixed();
  console.log('\n────────── 结果 ──────────');
  console.log('循环结束状态 :', verdict.status || '(无)');
  console.log('轮数         :', verdict.rounds != null ? verdict.rounds : '(无)');
  console.log('循环判定     :', verdict.ok ? '正常结束' : '未正常结束 —— ' + verdict.why);
  console.log('沙箱测试     :', fixed ? '已修好，python test_calc.py 通过' : '仍失败');
  console.log('耗时         :', Math.round((Date.now() - t0) / 1000) + 's');
  const pass = verdict.ok && fixed;
  console.log('\n' + (pass ? '通过：Claude ↔ Codex 循环真实跑通并把代码改对了'
    : '未通过：见上面的状态'));
  process.exit(pass ? 0 : 1);
}

main();
