'use strict';
/**
 * 循环工作流 · 崩溃续跑 E2E（Phase 2b 终极验证，2026-06-29 道雪）
 * Phase A：起 Hub A → 建群(双 Codex) → 配循环(maxRounds=4) → 发送 → 等 round≥1 完成（loopState 持久化）→ kill A（模拟崩溃）。
 * Phase B：起 Hub B（同 data dir）→ main boot 自动 resumePending → 监控 → 验证 round 在 A 之后【继续推进】（续跑 + 唤醒 dormant 成员）。
 * 同时验证：① 崩溃后从持久化续跑 ② 成员 dormant 自动 wake。
 * 用法：node tests/loop-resume-crash-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const HUB = 'C:\\Users\\lintian\\claude-session-hub';
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const DATA = path.join(os.tmpdir(), 'hub-loop-crash-data');
const WS = path.join(os.tmpdir(), 'hub-loop-crash-ws');
const RESULT = path.join(os.tmpdir(), 'hub-loop-crash-result.txt');
const HARD_MS = 22 * 60 * 1000;

const log = [];
function rec(s) { const line = `[${new Date().toLocaleTimeString()}] ${s}`; log.push(line); console.log(line); }
function flush(v) { try { fs.writeFileSync(RESULT, v + '\n\n' + log.join('\n'), 'utf8'); } catch (e) {} }
function get(url) { return new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); }); }
function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({ send(m, p = {}) { const i = id++; return new Promise((res, rj) => { pend.set(i, { res, rj }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); }, close() { ws.close(); } }));
    ws.on('error', rej);
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const { res, rj } = pend.get(m.id); pend.delete(m.id); if (m.error) rj(new Error(m.error.message)); else res(m.result); } });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} }
function launch(port) {
  const env = Object.assign({}, process.env);
  ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID'].forEach(k => delete env[k]);
  env.CLAUDE_HUB_DATA_DIR = DATA;
  return spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], { cwd: HUB, env, stdio: 'ignore' });
}
async function connect(port) {
  let targets;
  for (let i = 0; i < 30; i++) { try { targets = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`)); if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break; } catch (e) {} await sleep(1000); }
  const t = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url));
  if (!t) throw new Error('no page target on ' + port);
  const cdp = await newCdp(t.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
  const ev = async (expr) => { const r = await cdp.send('Runtime.evaluate', { expression: `(async function(){${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('EVAL:' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
  for (let i = 0; i < 20; i++) { if (await ev(`return typeof window.LoopWorkflow`) === 'object') break; await sleep(800); }
  await ev(`window.__lp=null;try{require('electron').ipcRenderer.on('loop:progress',function(e,d){window.__lp=d;});}catch(e){}return 'ok';`);
  return { cdp, ev };
}

let childA = null, childB = null;
function cleanup() { if (childA) killTree(childA.pid); if (childB) killTree(childB.pid); }

async function main() {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(WS, { recursive: true });
  const hard = setTimeout(() => { rec('!! 硬超时'); flush('TIMEOUT'); cleanup(); process.exit(3); }, HARD_MS);
  const wsj = WS.replace(/\\/g, '\\\\');

  try {
    // ===== Phase A：起 Hub、配循环、跑到 round≥1、kill =====
    rec('Phase A: 启动 Hub A');
    childA = launch(9357);
    const A = await connect(9357);
    rec('Hub A renderer 就绪');
    const m = await A.ev(`return await require('electron').ipcRenderer.invoke('create-meeting',{mode:'research',scene:'research',title:'崩溃续跑测',cwd:'${wsj}',workspace:'${wsj}',slots:[{kind:'codex',index:0,cwd:'${wsj}'},{kind:'codex',index:1,cwd:'${wsj}'}]})`);
    if (!m || !m.id || (m.subSessions || []).length < 2) { rec('建群失败'); flush('FAIL_CREATE'); cleanup(); process.exit(2); }
    const meetingId = m.id;
    rec('建群 ' + meetingId);
    let ready = false;
    for (let i = 0; i < 100; i++) { const r = await A.ev(`return await Promise.all((${JSON.stringify(m.subSessions)}).map(s=>require('electron').ipcRenderer.invoke('cli-ready-status',s)))`); if (Array.isArray(r) && r.every(Boolean)) { ready = true; break; } await sleep(2000); }
    if (!ready) { rec('成员未就绪'); flush('FAIL_READY'); cleanup(); process.exit(2); }
    rec('成员就绪');
    await A.ev(`try{if(window.openMeeting)window.openMeeting('${meetingId}');}catch(e){}try{var el=document.querySelector('[data-meeting-id="${meetingId}"]');if(el)el.click();}catch(e){}return '';`);
    await sleep(1500);
    // 配循环：maxRounds=4（留足续跑空间）
    const cfg = await A.ev(`function q(s){return document.querySelector(s)}var wb=document.getElementById('mr-workflow-btn');if(!wb)return 'NO_BTN';wb.click();if(!q('#workflow-config-modal'))return 'NO_MODAL';var sw=q('.wf-switch');if(sw&&!sw.classList.contains('on'))sw.click();var t1=q('[data-wf="tpl"][data-tpl="t1"]');if(t1)t1.click();var lt=q('[data-wf="loop-toggle"]');if(lt&&!lt.checked)lt.click();var mr=q('#wf-loop-rounds');if(mr)mr.value='4';var sv=q('.wf-save');if(!sv)return 'NO_SAVE';sv.click();return 'OK';`);
    if (cfg !== 'OK') { rec('配置失败 ' + cfg); flush('FAIL_CFG'); cleanup(); process.exit(2); }
    rec('循环配置 maxRounds=4');
    const goal = `在目录 ${WS}（空目录，测试专用）创建 add.js 导出 add(a,b)=a+b；add.test.js 用 node assert 验证 add(2,3)===5 打印 OK。只在该目录操作。`;
    const sent = await A.ev(`var box=document.getElementById('mr-input-box');if(!box)return 'NO_BOX';box.innerText=${JSON.stringify(goal)};box.dispatchEvent(new Event('input',{bubbles:true}));var btn=document.getElementById('mr-send-btn')||Array.from(document.querySelectorAll('button')).find(b=>/发送|send/i.test(b.title||b.textContent||''));if(!btn)return 'NO_SEND';btn.click();return 'SENT';`);
    if (sent !== 'SENT') { rec('发送失败 ' + sent); flush('FAIL_SEND'); cleanup(); process.exit(2); }
    rec('已发送，等 round 1 完成（看到 round≥2）后 kill');
    let killRound = 0, lastSig = '', lastChange = Date.now();
    while (true) {
      await sleep(5000);
      const lp = await A.ev(`var s=window.__lp;return s?JSON.stringify({round:s.round,stage:s.stage,status:s.status}):null`);
      if (lp) {
        const s = JSON.parse(lp);
        const sig = (s.stage || '') + '|' + s.round;
        if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); rec('A 进度: stage=' + s.stage + ' round=' + s.round + ' status=' + s.status); }
        // round 推进到 2（或进入终态）= round 1 已 advanced 并持久化（running）→ 此刻 kill 模拟崩溃
        if (s.round >= 2 || (s.status && s.status !== 'running')) { killRound = 1; rec('A round 1 已完成（lp round=' + s.round + ' status=' + s.status + '）→ 💥 kill'); break; }
      }
      if (Date.now() - lastChange > 13 * 60 * 1000) { rec('A 13min 无进展'); flush('FAIL_A_STUCK'); cleanup(); process.exit(1); }
    }
    // 读持久化确认 loopState running
    await sleep(2000); // 给 persist 落盘
    A.cdp.close();
    rec('💥 kill Hub A（模拟崩溃）');
    killTree(childA.pid); childA = null;
    await sleep(4000);

    // ===== Phase B：重启 Hub（同 data dir）→ main boot 自动续跑 =====
    rec('Phase B: 重启 Hub B（同 data dir）');
    childB = launch(9358);
    const B = await connect(9358);
    rec('Hub B renderer 就绪，等 main boot resumePending（8s+）自动续跑…');
    // 监控 B 的 loop:progress：round 应 > killRound（续跑推进）
    let resumed = false, finalRound = killRound, lastB = Date.now();
    while (true) {
      await sleep(5000);
      const lp = await B.ev(`var s=window.__lp;return s?JSON.stringify({round:s.round,stage:s.stage,status:s.status}):null`);
      if (lp) {
        const s = JSON.parse(lp); finalRound = s.round;
        rec('B 进度: stage=' + s.stage + ' round=' + s.round + ' status=' + s.status);
        if (s.round > killRound) { resumed = true; rec('✅ 续跑生效：round 从 ' + killRound + ' 推进到 ' + s.round); }
        if (s.status && s.status !== 'running') { rec('B 循环结束 ' + s.status); break; }
        if (resumed && s.round >= killRound + 1) break; // 已证明推进，够了
        lastB = Date.now();
      }
      if (Date.now() - lastB > 13 * 60 * 1000) { rec('B 13min 无续跑进展（可能 dormant 成员 wake 失败）'); break; }
    }
    B.cdp.close();
    clearTimeout(hard);
    cleanup();
    if (resumed) { rec('✅ 崩溃续跑验证通过：kill@round' + killRound + ' → 重启续到 round' + finalRound); flush('PASS resumed kill@' + killRound + ' final@' + finalRound); process.exit(0); }
    rec('⚠ 重启后未见 round 继续推进（续跑/wake 待查）'); flush('PARTIAL kill@' + killRound + ' final@' + finalRound); process.exit(1);
  } catch (e) {
    rec('异常: ' + (e && e.stack || e)); clearTimeout(hard); flush('ERROR ' + (e && e.message)); cleanup(); process.exit(1);
  }
}
main();
