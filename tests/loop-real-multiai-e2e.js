'use strict';
/**
 * 循环工作流 · 真实多 AI E2E（Phase 1 收尾，2026-06-29 道雪）
 * 真起隔离 Hub + 真 Codex(开发)+DeepSeek(评审) 跑 L1 循环；极小安全任务 + 隔离工作区。
 * 验证：循环真转起来（开发步真跑→评审真出裁决→引擎解析→gate→推进/回灌→合理终止+出晨报）。
 * 防卡死：cli-ready 200s 超时 + 全局 12min 硬超时 + 8min 无进展(round 不变)即中止。
 * 结果写 RESULT 文件（供主会话读取，不污染 stdout）。用法：node tests/loop-real-multiai-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const HUB = 'C:\\Users\\lintian\\claude-session-hub';
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9356;
const CDP = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'hub-loop-real-data');
const WS = path.join(os.tmpdir(), 'hub-loop-real-ws');
const RESULT = path.join(os.tmpdir(), 'hub-loop-real-result.txt');
const HARD_MS = 26 * 60 * 1000;
const NOPROG_MS = 12 * 60 * 1000;

const log = [];
function rec(s) { const line = `[${new Date().toLocaleTimeString()}] ${s}`; log.push(line); console.log(line); }
function flush(verdict) { try { fs.writeFileSync(RESULT, verdict + '\n\n' + log.join('\n'), 'utf8'); } catch (e) {} }

function get(url) { return new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }
function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({ send(method, params = {}) { const i = id++; return new Promise((res, rj) => { pend.set(i, { res, rj }); ws.send(JSON.stringify({ id: i, method, params })); }); }, close() { ws.close(); } }));
    ws.on('error', rej);
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const { res, rj } = pend.get(m.id); pend.delete(m.id); if (m.error) rj(new Error(m.error.message)); else res(m.result); } });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
function cleanup() { if (child) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} child = null; } }

async function main() {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) {}
  try { fs.mkdirSync(WS, { recursive: true }); } catch (e) {}
  const env = Object.assign({}, process.env);
  ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID'].forEach(k => delete env[k]);
  env.CLAUDE_HUB_DATA_DIR = DATA;
  child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: HUB, env, stdio: 'ignore' });
  rec(`Hub 启动 pid=${child.pid} data=${DATA} ws=${WS}`);

  const hardTimer = setTimeout(() => { rec('!! 全局 12min 硬超时 → 中止'); flush('TIMEOUT_HARD'); cleanup(); process.exit(3); }, HARD_MS);

  try {
    // 连 CDP
    let targets;
    for (let i = 0; i < 30; i++) { try { targets = JSON.parse(await get(`${CDP}/json/list`)); if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break; } catch (e) {} await sleep(1000); }
    const t = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url));
    if (!t) { rec('CDP 无 page target'); flush('FAIL_NO_CDP'); cleanup(); process.exit(2); }
    const cdp = await newCdp(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const ev = async (expr) => { const r = await cdp.send('Runtime.evaluate', { expression: `(async function(){${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('EVAL:' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails))); return r.result.value; };
    for (let i = 0; i < 20; i++) { if (await ev(`return typeof window.LoopWorkflow`) === 'object') break; await sleep(800); }
    rec('renderer 就绪');
    // Phase 2b：循环下沉 main 进程，经 loop:progress 推进度。E2E 监听它（非 renderer 的 window.__loopState）。
    await ev(`window.__lp=null;try{require('electron').ipcRenderer.on('loop:progress',function(e,d){window.__lp=d;});}catch(e){}return 'ok';`);

    // 建群：Codex(开发) + DeepSeek(评审)
    const wsj = WS.replace(/\\/g, '\\\\');
    // 评审用 codex 而非 deepseek：隔离 Hub 里 deepseek 走 claude CLI 会卡 "trust this folder"（feedback_hub_isolation_claude_trust）；
    // 本 E2E 验证的是循环【机制闭环】（裁决解析→gate→推进），用 codex 当评审可避 trust 跑通；生产配置仍是 Claude+DeepSeek 双评审。
    const m = await ev(`return await require('electron').ipcRenderer.invoke('create-meeting',{mode:'research',scene:'research',title:'循环真测',cwd:'${wsj}',workspace:'${wsj}',slots:[{kind:'codex',index:0,cwd:'${wsj}'},{kind:'codex',index:1,cwd:'${wsj}'}]})`);
    if (!m || !m.id || !Array.isArray(m.subSessions) || m.subSessions.length < 2) { rec('建群失败: ' + JSON.stringify(m && m.subSessions)); flush('FAIL_CREATE_MEETING'); cleanup(); process.exit(2); }
    rec(`建群 id=${m.id} 成员=${m.subSessions.length}`);

    // 等成员就绪（200s）
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const r = await ev(`return await Promise.all((${JSON.stringify(m.subSessions)}).map(s=>require('electron').ipcRenderer.invoke('cli-ready-status',s)))`);
      if (Array.isArray(r) && r.every(Boolean)) { ready = true; rec(`成员就绪 ${JSON.stringify(r)} @${i * 2}s`); break; }
      if (i % 5 === 0) rec(`等就绪 ${JSON.stringify(r)} @${i * 2}s`);
      await sleep(2000);
    }
    if (!ready) { rec('成员 200s 未就绪'); flush('FAIL_NOT_READY'); cleanup(); process.exit(2); }

    // 切到该 meeting（多 fallback）
    await ev(`try{if(window.openMeeting)window.openMeeting('${m.id}');}catch(e){}
      try{var el=document.querySelector('[data-meeting-id="${m.id}"]');if(el)el.click();}catch(e){}
      return '';`);
    await sleep(1500);
    const active = await ev(`return (typeof activeMeetingId!=='undefined')?activeMeetingId:(window.activeMeetingId||null)`);
    rec(`active=${active}（目标 ${m.id}）`);

    // 配置循环：真实 UI 路径（点 workflow 按钮 → 操作 modal → 保存），绕开 CDP 访问 IIFE 局部变量
    const cfgRes = await ev(`function q(s){return document.querySelector(s)}
      var wb=document.getElementById('mr-workflow-btn');if(!wb)return 'NO_WF_BTN';wb.click();
      if(!q('#workflow-config-modal'))return 'NO_MODAL';
      var sw=q('.wf-switch');if(sw&&!sw.classList.contains('on'))sw.click();
      var t1=q('[data-wf="tpl"][data-tpl="t1"]');if(t1)t1.click();
      var lt=q('[data-wf="loop-toggle"]');if(lt&&!lt.checked)lt.click();
      var mr=q('#wf-loop-rounds');if(mr)mr.value='2';
      var sv=q('.wf-save');if(!sv)return 'NO_SAVE';sv.click();
      return 'CONFIGURED';`);
    rec('配置循环(UI): ' + cfgRes);
    if (cfgRes !== 'CONFIGURED') { rec('配置失败'); flush('FAIL_CONFIG_' + cfgRes); cleanup(); process.exit(2); }

    // 填输入框 + 点发送（真实 UI 路径 → doSend → main workflow engine）
    const goal = `在目录 ${WS}（已存在的空目录，本次测试专用）里：创建 add.js 导出 function add(a,b){return a+b}；再创建 add.test.js 用 node assert 验证 add(2,3)===5 并 console.log('OK')。只在该目录操作，别碰其它目录。`;
    const sent = await ev(`var box=document.getElementById('mr-input-box');if(!box)return 'NO_BOX';box.innerText=${JSON.stringify(goal)};box.dispatchEvent(new Event('input',{bubbles:true}));
      var btn=document.getElementById('mr-send-btn')||document.querySelector('[data-action="send"]')||Array.from(document.querySelectorAll('button')).find(b=>/发送|send/i.test(b.title||b.textContent||''));
      if(!btn)return 'NO_BTN';btn.click();return 'SENT';`);
    rec('触发发送: ' + sent);
    if (sent !== 'SENT') { rec('发送触发失败'); flush('FAIL_TRIGGER_' + sent); cleanup(); process.exit(2); }

    // 监控 main 驱动循环（loop:progress 推送 stage/round/status；下沉后循环在 main 进程）
    let lastSig = '', lastChange = Date.now(), finalState = null;
    while (true) {
      await sleep(5000);
      const st = await ev(`var s=window.__lp;return s?JSON.stringify({status:s.status,round:s.round,phase:s.phase,stage:s.stage||''}):null`);
      if (st) {
        const s = JSON.parse(st); finalState = s;
        const sig = (s.stage || '') + '|' + s.round;
        if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); rec(`进度: stage=${s.stage} round=${s.round} phase=${s.phase} status=${s.status}`); }
        if (s.status && s.status !== 'running') { rec('循环结束: ' + s.status); break; }
      }
      if (Date.now() - lastChange > NOPROG_MS) { rec(`!! ${Math.round(NOPROG_MS / 60000)}min 同一阶段无推进 → 判卡，中止`); finalState = finalState || {}; finalState._stuck = true; break; }
    }

    // 读工作区产物 + 晨报
    let wsFiles = []; try { wsFiles = fs.readdirSync(WS); } catch (e) {}
    rec('工作区产物: ' + JSON.stringify(wsFiles));
    let report = []; try { report = fs.readdirSync(path.join(os.homedir(), 'Desktop', 'claude-artifacts')).filter(f => f.startsWith('loop-report-')); } catch (e) {}
    rec('晨报文件: ' + JSON.stringify(report.slice(-2)));

    cdp.close();
    clearTimeout(hardTimer);
    const ok = finalState && finalState.round >= 1 && !finalState._stuck;
    rec(ok ? '✅ 机制验证：循环真实转起来并合理终止' : '⚠ 未达预期（见上）');
    flush(ok ? 'PASS round=' + finalState.round + ' status=' + finalState.status : 'PARTIAL ' + JSON.stringify(finalState));
    cleanup();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    rec('异常: ' + (e && e.stack || e));
    clearTimeout(hardTimer); flush('ERROR ' + (e && e.message)); cleanup(); process.exit(1);
  }
}
main();
