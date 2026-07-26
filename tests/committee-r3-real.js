'use strict';
// 投委会真五幕实测（r3）：隔离 Hub + DS+CX（避 Claude 冷启动）。验证：
//   点3b 体检有分（输空格股票拆多只）/ prompt 优化（rs/catalyst/主轴）/ 发言进群聊 messages / 五幕跑通。
//   点2 规则不重复看 Hub stdout 的 [PROMPT-PROBE] 日志。
const WebSocket = require('ws'); const http = require('http'); const fs = require('fs');
const CDP = process.env.CM_CDP || 'http://127.0.0.1:9347';
const ART = 'C:/Users/lintian/Desktop/claude-artifacts';
function get(u) { return new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => res(d)); }).on('error', rej); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.log(`[${ts()}] ${m}`); }
function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({ send(method, params = {}) { const i = id++; return new Promise((res, rj) => { pend.set(i, { res, rj }); ws.send(JSON.stringify({ id: i, method, params })); }); }, close() { ws.close(); } }));
    ws.on('error', rej);
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const { res, rj } = pend.get(m.id); pend.delete(m.id); if (m.error) rj(new Error(m.error.message)); else res(m.result); } });
  });
}
async function main() {
  let targets;
  for (let i = 0; i < 20; i++) { try { targets = JSON.parse(await get(`${CDP}/json/list`)); if (targets.find(x => x.type === 'page')) break; } catch (e) {} await sleep(800); }
  if (!targets) { log('CDP 连不上'); process.exit(2); }
  const t = targets.find(x => x.type === 'page' && /index\.html/.test(x.url)) || targets.find(x => x.type === 'page');
  const cdp = await newCdp(t.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
  const ev = async (expr) => { const r = await cdp.send('Runtime.evaluate', { expression: `(async function(){${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('EVAL EX: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails))); return r.result.value; };

  log('建 research 房（DS+CX 两家，避 Claude 冷启动）...');
  const m = await ev(`return await require('electron').ipcRenderer.invoke('create-meeting',{mode:'research',scene:'research',title:'投委会R3真测',slots:[{kind:'deepseek',index:0},{kind:'codex',index:1}]})`);
  const subs = (m && m.subSessions) || [];
  log(`建房: id=${m && m.id} scene=${m && m.scene} subSessions=${subs.length}`);
  if (!m || !m.id || subs.length < 2) { log(`FAIL: spawn 不足（${subs.length}/2）`); cdp.close(); process.exit(1); }
  log('✓ DS+CX spawn 成功');

  log('等 CLI ready 150s...'); await sleep(150000);
  log('真人 UI 触发：showModal + 填「沪电股份 沪硅产业」(空格,验parseStocks) + rounds 2 + 开始...');
  await ev(`window.committeeUI.closePanel&&window.committeeUI.closePanel();window.committeeUI.showModal({id:'${m.id}'});return '';`);
  await sleep(700);
  const clicked = await ev(`var ta=document.querySelector('[data-cm-stocks]');var rd=document.querySelector('[data-cm-rounds]');if(!ta||!rd)return 'NO_MODAL';ta.value='沪电股份 沪硅产业';rd.value='2';document.querySelector('[data-cm-start]').click();return 'CLICKED';`);
  log('点开始 → ' + clicked);
  if (clicked !== 'CLICKED') { log('FAIL: 弹窗未出现'); cdp.close(); process.exit(1); }

  const deadline = Date.now() + 780000; // 13min
  let lastAct = '';
  while (Date.now() < deadline) {
    await sleep(15000);
    let s;
    try { s = JSON.parse(await ev(`var s=window.committeeUI._getState();return JSON.stringify({active:s.active,done:s.done,curAct:s.curAct,actRound:s.actRound,nRows:(s.boards&&s.boards.rows||[]).length,error:s.error||''})`)); }
    catch (e) { log('轮询异常: ' + e.message); continue; }
    if (s.curAct !== lastAct) { log(`▶ 幕次=${s.curAct}${s.actRound ? ' 第' + s.actRound + '轮' : ''} rows=${s.nRows} ${s.error ? 'ERR:' + s.error : ''}`); lastAct = s.curAct; }
    if (s.done) { log('✓✓ 五幕 done=true'); break; }
  }

  // ── 抓证据 ──
  const st = JSON.parse(await ev(`return JSON.stringify(window.committeeUI._getState())`));
  const rows = (st.boards && st.boards.rows) || [];
  log('【点3b 体检】rows 数=' + rows.length + '（期望 2：沪电股份/沪硅产业各一行）');
  for (const r of rows) {
    const f = r.faces || {};
    log(`  · ${r.name || r.code}: 基${f.基本面 == null ? '空' : f.基本面}/技${f.技术面 == null ? '空' : f.技术面}/消${f.消息面 == null ? '空' : f.消息面} chase=${r.chase_agg} ambush=${r.ambush_agg} rs=${r.rs_agg == null ? '空' : r.rs_agg} cov=${r.coverage && r.coverage.gave}/${r.coverage && r.coverage.total}`);
    log(`    catalyst=${JSON.stringify(r.catalyst || '')} top_bull=${JSON.stringify((r.top_bull || []).slice(0, 2))}`);
  }
  // 发言进群聊 messages（committeeAct）：经 history record 的 acts 间接 + 直接查 orchestrator messages
  let histActs = 0, histSpeeches = 0;
  try { const h = JSON.parse(await ev(`var x=await require('electron').ipcRenderer.invoke('committee:history:list');return JSON.stringify(x)`)); if (h.items && h.items[0]) { const g = JSON.parse(await ev(`var x=await require('electron').ipcRenderer.invoke('committee:history:get',{id:'${h.items[0].id}'});return JSON.stringify(x)`)); histActs = (g.record && g.record.acts || []).length; histSpeeches = (g.record && g.record.acts || []).reduce((a, x) => a + (x.speeches || []).length, 0); } } catch (e) { log('history 查询异常: ' + e.message); }
  log(`【发言进群聊/历史】history record: ${histActs} 幕, ${histSpeeches} 条委员发言`);

  fs.writeFileSync(`${ART}/committee-r3-result.json`, JSON.stringify(st, null, 2));
  log('结果存盘 committee-r3-result.json · done=' + st.done);
  cdp.close();
  process.exit(st.done ? 0 : 1);
}
main().catch(e => { console.error('R3 THREW', e); process.exit(2); });
