'use strict';
/**
 * 投委会真实 CDP E2E（task#8 · TDD）。连隔离 Hub 的 renderer，真实执行 committee-ui + IPC，
 * 模拟用户潜在场景：开投委会弹窗（各输入格式）→ 全自动五幕面板渲染 → 矛盾/隔离/主席/降级/错误态
 * → 技术初筛按钮真实点击 → IPC 真实链路 → XSS 边界。不 mock，真实 DOM + 真实 ipcRenderer.invoke。
 *
 * 用法：起隔离 Hub（--remote-debugging-port=9344）后  node tests/committee-cdp-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');

const CDP = process.env.CM_CDP || 'http://127.0.0.1:9344';

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}
function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({
      send(method, params = {}) { const i = id++; return new Promise((res, rj) => { pend.set(i, { res, rj }); ws.send(JSON.stringify({ id: i, method, params })); }); },
      close() { ws.close(); },
    }));
    ws.on('error', rej);
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const { res, rj } = pend.get(m.id); pend.delete(m.id); if (m.error) rj(new Error(m.error.message)); else res(m.result); } });
  });
}

async function main() {
  let targets;
  for (let i = 0; i < 20; i++) {
    try { targets = JSON.parse(await get(`${CDP}/json/list`)); if (targets.find(x => x.type === 'page')) break; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!targets) { console.error('CDP 连不上 ' + CDP); process.exit(2); }
  const t = targets.find(x => x.type === 'page' && /index\.html/.test(x.url)) || targets.find(x => x.type === 'page');
  const cdp = await newCdp(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  let fails = 0;
  const results = [];
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(async function(){${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('EVAL EX: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails)));
    return r.result.value;
  };
  const ok = (c, m) => { results.push((c ? '  ok   ' : ' FAIL ') + m); if (!c) fails++; };
  const okv = async (expr, expect, m) => { let v; try { v = await ev(expr); } catch (e) { v = 'THREW:' + e.message; } ok(v === expect, m + (v === expect ? '' : ` (got ${JSON.stringify(v)})`)); };

  // 清理工具
  const reset = async () => { await ev(`if(window.committeeUI){window.committeeUI.closeModal();window.committeeUI.closePanel();}document.querySelectorAll('.cm-toast').forEach(e=>e.remove());return '';`); };

  // ── 场景 0：加载完整性 ──
  await okv(`return typeof window.committeeUI`, 'object', '0.1 committee-ui.js 真实加载');
  await okv(`return typeof window.committeeUI.showModal`, 'function', '0.2 showModal API');
  await okv(`return typeof window.committeeUICore`, 'object', '0.3 committee-ui-core 加载');
  await okv(`return !!require('electron').ipcRenderer`, true, '0.4 renderer 有 ipcRenderer (nodeIntegration)');
  // CSS 生效（.cm-start 规则存在）
  await okv(`var f=false;for(var i=0;i<document.styleSheets.length;i++){try{var rs=document.styleSheets[i].cssRules;for(var j=0;j<rs.length;j++){if(rs[j].selectorText&&rs[j].selectorText.indexOf('.cm-panel')>=0){f=true}}}catch(e){}}return f`, true, '0.5 committee-ui.css 真实加载(.cm-panel 规则)');

  // ── 场景 1：开投委会弹窗（用户输股票各格式）──
  await reset();
  await ev(`window.committeeUI.showModal({id:'e2e-1'});return '';`);
  await okv(`return !!document.querySelector('.cm-modal-mask')`, true, '1.1 showModal → 弹窗出现');
  await okv(`return !!(document.querySelector('[data-cm-stocks]')&&document.querySelector('[data-cm-rounds]')&&document.querySelector('[data-cm-start]'))`, true, '1.2 弹窗含 输股票+轮次+开始');
  await okv(`return document.querySelector('[data-cm-rounds]').value`, '4', '1.3 默认 4 轮');
  // 空输入点开始 → 校验报错，弹窗不关
  await ev(`document.querySelector('[data-cm-stocks]').value='';document.querySelector('[data-cm-start]').click();return '';`);
  await new Promise(r => setTimeout(r, 100));
  await okv(`return !!document.querySelector('.cm-modal-mask') && document.querySelector('[data-cm-err]').textContent.length>0`, true, '1.4 空输入→校验报错+弹窗不关');
  // 取消关闭
  await ev(`document.querySelector('[data-cm-cancel]').click();return '';`);
  await okv(`return !!document.querySelector('.cm-modal-mask')`, false, '1.5 取消→弹窗关闭');

  // ── 场景 2：全自动面板渲染（模拟五幕 committee:progress）──
  await reset();
  await ev(`window.committeeUI.onProgress({type:'start',meetingId:'e2e-1',stocks:[{code:'688256',name:'寒武纪'},{code:'603823',name:'百合花'}],rounds:4,chair:'Claude',members:[{label:'DeepSeek',face:'技术面'},{label:'Claude',face:'基本面',isChair:true},{label:'Codex',face:'消息面'}]});return '';`);
  await okv(`return !!document.querySelector('.cm-panel')`, true, '2.1 start → 面板出现');
  await okv(`return document.querySelector('.cm-badge').textContent.indexOf('自动巡航')>=0`, true, '2.2 徽章=自动巡航中');
  // 幕次推进
  await ev(`window.committeeUI.onProgress({type:'act',meetingId:'e2e-1',act:'点评'});return '';`);
  await okv(`return !!document.querySelector('.cm-act.on')`, true, '2.3 act → 幕次进度条高亮当前幕');
  // 点评出双榜
  await ev(`window.committeeUI.onProgress({type:'board',meetingId:'e2e-1',boards:{rows:[{code:'688256',name:'寒武纪',faces:{基本面:60,技术面:88,消息面:80},lean_consensus:'追涨',coverage:{gave:3,total:3}},{code:'603823',name:'百合花',faces:{基本面:45,技术面:40,消息面:70},lean_consensus:'低吸',coverage:{gave:2,total:3,degraded:true}}],chase_ranking:[{code:'688256',name:'寒武纪',chase_agg:85},{code:'603823',name:'百合花',chase_agg:35}],ambush_ranking:[{code:'603823',name:'百合花',ambush_agg:65},{code:'688256',name:'寒武纪',ambush_agg:45}],probes:[{code:'603823',name:'百合花',detail:'追涨分分歧 50'}],isolated:[]}});return '';`);
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('寒武纪')>=0 && document.querySelector('.cm-panel').textContent.indexOf('85')>=0`, true, '2.4 board → 双榜寒武纪85');
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('矛盾探针')>=0`, true, '2.5 矛盾探针渲染');
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('2/3')>=0`, true, '2.6 coverage 降级标注');
  // 收敛主席报告
  await ev(`window.committeeUI.onProgress({type:'act',meetingId:'e2e-1',act:'收敛'});window.committeeUI.onProgress({type:'chair',meetingId:'e2e-1',chair:{chase_buys:[{code:'688256',name:'寒武纪',rank:1,reason:'最强龙'}],ambush_buys:[{code:'603823',name:'百合花',rank:1}],cross_advice:'先追寒武纪',appendix:'宁错过不做错',degraded:false}});return '';`);
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('换帽子')>=0 && document.querySelector('.cm-panel').textContent.indexOf('三道保险')>=0`, true, '2.7 主席换帽子+三道保险');
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('宁错过不做错')>=0`, true, '2.8 主席附言');
  // done 自动闭庭
  await ev(`window.committeeUI.onProgress({type:'done',meetingId:'e2e-1'});return '';`);
  await okv(`return document.querySelector('.cm-badge').textContent.indexOf('闭庭')>=0`, true, '2.9 done → 已闭庭徽章(自动退出)');

  // ── 场景 3：风险隔离 + 错误态 ──
  await reset();
  await ev(`window.committeeUI.onProgress({type:'start',meetingId:'e2e-1',stocks:[{code:'603823',name:'百合花'}],rounds:4,chair:'Claude'});window.committeeUI.onProgress({type:'board',meetingId:'e2e-1',boards:{rows:[],chase_ranking:[],ambush_ranking:[],probes:[],isolated:[{code:'603823',name:'百合花',by:['DeepSeek','Claude']}]}});return '';`);
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('风险隔离')>=0 && document.querySelector('.cm-panel').textContent.indexOf('隔离观察')>=0`, true, '3.1 风险隔离渲染');
  await ev(`window.committeeUI.onProgress({type:'error',meetingId:'e2e-1',reason:'房间无委员'});return '';`);
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('房间无委员')>=0`, true, '3.2 error 态渲染');

  // ── 场景 4：技术初筛面板（解耦但可见进度/结果）──
  await reset();
  await okv(`return !!(window.MeetingRoom && window.MeetingRoom.openMeeting)`, true, '4.0 meeting-room API 可用');
  await okv(`
    var orig = window.committeeUI.showScreenerHint;
    window.__screenerArg = null;
    window.committeeUI.showScreenerHint = function(arg){ window.__screenerArg = arg; return orig.call(window.committeeUI, arg); };
    var m = { id:'e2e-scr-room', title:'技术初筛按钮真点', scene:'research', mode:'research', groupChat:true, sessions:[], subSessions:[] };
    window.MeetingRoom.openMeeting(m.id, m);
    await new Promise(r => setTimeout(r, 250));
    var btn = document.querySelector('[data-committee-screener]');
    if (!btn) return 'NO_BTN';
    btn.click();
    await new Promise(r => setTimeout(r, 250));
    return window.__screenerArg && window.__screenerArg.id || 'NO_ARG';
  `, 'e2e-scr-room', '4.1 真实技术初筛按钮点击传入当前 meeting');
  await okv(`return !!document.querySelector('.cm-panel') && document.querySelector('.cm-panel').textContent.indexOf('技术初筛')>=0`, true, '4.2 技术初筛点击→面板出现');
  await okv(`return document.querySelector('.cm-panel').style.display !== 'none'`, true, '4.3 技术初筛面板未被 session 可见性逻辑隐藏');
  await okv(`return document.querySelector('.cm-panel').textContent.indexOf('已生成')>=0 || document.querySelector('.cm-panel').textContent.indexOf('初筛进行中')>=0`, true, '4.4 技术初筛面板显示进度/结果状态');

  // ── 场景 5：XSS 边界（股票名注入）──
  await reset();
  await ev(`window.committeeUI.onProgress({type:'start',meetingId:'e2e-1',stocks:[{code:'x',name:'<img src=x onerror=window.__xss=1>'}],chair:'C'});return '';`);
  await new Promise(r => setTimeout(r, 100));
  await okv(`return window.__xss===undefined`, true, '5.1 XSS 股票名未执行(escape 生效)');

  // ── 场景 6：IPC 真实链路（main 进程 conductor）──
  await reset();
  await okv(`var r=await require('electron').ipcRenderer.invoke('committee:start',{});return r&&r.status`, 'error', '6.1 IPC committee:start 空参→error(handler 真实注册)');
  await okv(`var r=await require('electron').ipcRenderer.invoke('committee:start',{meetingId:'fake-no-room',stocks:[{code:'688256',name:'寒武纪'}],rounds:4});return r&&r.status`, 'started', '6.2 IPC committee:start 假meeting→started(fire-and-forget)');

  await reset();
  cdp.close();
  console.log(results.join('\n'));
  console.log('\n' + (fails === 0 ? '=== 投委会 CDP E2E 全绿 ===' : '=== ' + fails + ' FAILED ==='));
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error('E2E THREW', e); process.exit(2); });
