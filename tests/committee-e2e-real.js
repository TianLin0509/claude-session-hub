'use strict';
/**
 * 投委会真三家 E2E（task#8）。连隔离 Hub，真实建 research 房（DS/CL/CX）→ 等 ready
 * → 真实 committee:start → 监控五幕（轮询 committee-ui 状态）→ 验证双榜/主席。
 *
 * 分阶段：STAGE=probe 只建房探测 spawn；STAGE=full 跑完整五幕。
 * 用法：node tests/committee-e2e-real.js
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const CDP = process.env.CM_CDP || 'http://127.0.0.1:9344';
const STAGE = process.env.STAGE || 'probe';
const ART = 'C:/Users/lintian/Desktop/claude-artifacts';

function get(url) { return new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => res(d)); }).on('error', rej); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.log(`[${ts()}] ${m}`); }
function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({
      send(method, params = {}) { const i = id++; return new Promise((res, rj) => { pend.set(i, { res, rj }); ws.send(JSON.stringify({ id: i, method, params })); }); },
      close() { ws.close(); },
    }));
    ws.on('error', rej);
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const { res, rj } = pend.get(m.id); pend.delete(m.id); if (m.error) rj(new Error(m.error.message)); else res(m.result); } });
  });
}

async function main() {
  let targets;
  for (let i = 0; i < 15; i++) { try { targets = JSON.parse(await get(`${CDP}/json/list`)); if (targets.find(x => x.type === 'page')) break; } catch (e) {} await sleep(800); }
  if (!targets) { log('CDP 连不上'); process.exit(2); }
  const t = targets.find(x => x.type === 'page' && /index\.html/.test(x.url)) || targets.find(x => x.type === 'page');
  const cdp = await newCdp(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(async function(){${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('EVAL EX: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails)));
    return r.result.value;
  };
  const shot = async (name) => { try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${ART}/${name}.png`, Buffer.from(r.data, 'base64')); log('截图 ' + name); } catch (e) { log('截图失败 ' + e.message); } };

  // ── 建房 ──
  log('建 research 三家房（DS/CL/CX）...');
  const m = await ev(`return await require('electron').ipcRenderer.invoke('create-meeting',{mode:'research',scene:'research',title:'投委会E2E真测',slots:[{kind:'deepseek',index:0},{kind:'claude',index:1},{kind:'codex',index:2}]})`);
  const subs = (m && m.subSessions) || [];
  log(`建房结果: id=${m && m.id} scene=${m && m.scene} subSessions=${subs.length}`);
  if (!m || !m.id) { log('FAIL: 建房返回无 id'); cdp.close(); process.exit(1); }
  if (subs.length < 3) { log(`FAIL: spawn 委员不足（${subs.length}/3）——可能 CLI auth/config 在隔离 dataDir 缺失`); cdp.close(); process.exit(1); }
  log('✓ 三家委员 spawn 成功');

  if (STAGE === 'probe') {
    log('等 30s 看委员启动...'); await sleep(30000);
    await shot('committee-e2e-room');
    log('probe 完成。meetingId=' + m.id);
    fs.writeFileSync(`${ART}/committee-e2e-meeting.json`, JSON.stringify({ meetingId: m.id, subSessions: subs }, null, 2));
    cdp.close(); process.exit(0);
  }

  // ── full: 等 ready + committee:start + 监控五幕 ──
  log('等三家 CLI ready（180s，加长确保全员就绪——根因诊断：120s 时主席 no_sent + 委员参差空回）...'); await sleep(180000);
  await shot('committee-e2e-ready');
  log('真人 UI 触发：showModal(设 _meetingId) + 填股票 + 点开始（避免直接 IPC 被 _meetingId 过滤）...');
  await ev(`window.committeeUI.closePanel();window.committeeUI.showModal({id:'${m.id}'});return '';`);
  await sleep(600);
  const clicked = await ev(`var ta=document.querySelector('[data-cm-stocks]');var rd=document.querySelector('[data-cm-rounds]');if(!ta||!rd)return 'NO_MODAL';ta.value='688256 寒武纪';rd.value='3';document.querySelector('[data-cm-start]').click();return 'CLICKED';`);
  log('点开始 → ' + clicked);
  if (clicked !== 'CLICKED') { log('FAIL: 弹窗未出现'); cdp.close(); process.exit(1); }

  const deadline = Date.now() + 1500000; // 25min
  let lastAct = '', boardsSeen = false, chairSeen = false;
  while (Date.now() < deadline) {
    await sleep(15000);
    let s;
    try { s = JSON.parse(await ev(`var s=window.committeeUI._getState();return JSON.stringify({active:s.active,done:s.done,curAct:s.curAct,actRound:s.actRound,hasBoards:!!(s.boards&&s.boards.chase_ranking&&s.boards.chase_ranking.length),chaseTop:s.boards&&s.boards.chase_ranking&&s.boards.chase_ranking[0]||null,hasChair:!!s.chairReport,error:s.error||''})`)); }
    catch (e) { log('轮询异常: ' + e.message); continue; }
    if (s.curAct !== lastAct) { log(`▶ 幕次: ${s.curAct}${s.actRound ? ' 第' + s.actRound + '轮' : ''}`); lastAct = s.curAct; await shot('committee-e2e-act-' + s.curAct); }
    if (s.error) log('⚠ error 态: ' + s.error);
    if (s.hasBoards && !boardsSeen) { boardsSeen = true; log('✓ 点评出双榜！追涨榜首: ' + JSON.stringify(s.chaseTop)); }
    if (s.hasChair && !chairSeen) { chairSeen = true; log('✓ 主席报告生成'); }
    if (s.done) { log('✓✓ 五幕全部完成 done=true'); break; }
  }
  await shot('committee-e2e-final');
  const final = await ev(`return JSON.stringify(window.committeeUI._getState())`);
  fs.writeFileSync(`${ART}/committee-e2e-result.json`, final);
  log('结果存盘 committee-e2e-result.json');
  log(`验证: 双榜=${boardsSeen} 主席=${chairSeen}`);
  cdp.close();
  process.exit(boardsSeen ? 0 : 1);
}

main().catch(e => { console.error('E2E THREW', e); process.exit(2); });
