'use strict';
/**
 * 循环工作流 · 真实 CDP UI E2E（Phase 1，2026-06-29 道雪）
 * 自包含：自己起隔离 Hub（剥离 CLAUDE* env + 独立 data dir + --remote-debugging-port=9355）→
 *         连 renderer 真实 evaluate（不 mock）→ 验证模块加载/浏览器内逻辑/循环配置 UI 渲染+保存 → 按 PID 清理。
 * 不依赖真实 AI（快、稳）。真实多 AI 跑循环是另一支 E2E（需登录态 + 时间）。
 * 用法：node tests/loop-workflow-cdp-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');

const HUB = 'C:\\Users\\lintian\\claude-session-hub';
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9355;
const CDP = `http://127.0.0.1:${PORT}`;

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

function launchHub() {
  const env = Object.assign({}, process.env);
  // feedback_e2e_strip_claude_env：剥离嵌套会话 env，否则污染
  ['CLAUDECODE','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_SESSION_ID','CLAUDE_HUB_PORT','CLAUDE_HUB_TOKEN','CLAUDE_HUB_SESSION_ID'].forEach(k => delete env[k]);
  env.CLAUDE_HUB_DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-loop-e2e';
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: HUB, env, stdio: 'ignore' });
  return child;
}
function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} }

async function main() {
  const child = launchHub();
  let fails = 0; const results = [];
  const ok = (c, m) => { results.push((c ? '  ok   ' : ' FAIL ') + m); if (!c) fails++; };
  try {
    // 等 renderer page target 就绪（最多 ~30s）
    let targets;
    for (let i = 0; i < 30; i++) {
      try { targets = JSON.parse(await get(`${CDP}/json/list`)); if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break; } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    const t = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url)) || (targets || []).find(x => x.type === 'page');
    if (!t) { console.error('CDP 连不上 / 无 page target'); killTree(child.pid); process.exit(2); }
    const cdp = await newCdp(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    // 等 renderer 脚本执行完（window.LoopWorkflow 就绪），避免时序误判
    for (let i = 0; i < 20; i++) {
      try { const rdy = await cdp.send('Runtime.evaluate', { expression: `typeof window.LoopWorkflow`, returnByValue: true }); if (rdy.result && rdy.result.value === 'object') break; } catch (e) {}
      await new Promise(r => setTimeout(r, 800));
    }
    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true });
      if (r.exceptionDetails) throw new Error('EVAL EX: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails)));
      return r.result.value;
    };
    const okv = async (expr, expect, m) => { let v; try { v = await ev(expr); } catch (e) { v = 'THREW:' + e.message; } ok(v === expect, m + (v === expect ? '' : ` (got ${JSON.stringify(v)})`)); };

    // ── 0. 模块加载 ──
    await okv(`return typeof window.LoopWorkflow`, 'object', '0.1 loop-workflow.js 真实加载');
    await okv(`return typeof window.LoopWorkflow.parseVerdict`, 'function', '0.2 parseVerdict');
    await okv(`return typeof window.LoopWorkflow.mergeVerdicts`, 'function', '0.3 mergeVerdicts');
    await okv(`return typeof window.LoopWorkflow.advanceLoopState`, 'function', '0.4 advanceLoopState');
    await okv(`return typeof window.LoopWorkflow.PROMPTS.reviewer`, 'function', '0.5 PROMPTS.reviewer');
    await okv(`return typeof window.openWorkflowConfigModal`, 'function', '0.6 openWorkflowConfigModal 可用');

    // ── 1. 浏览器内逻辑（与单测一致，确认浏览器环境也对）──
    await okv(`return window.LoopWorkflow.parseVerdict('<<<VERDICT>>>{"decision":"pass","blockers":[],"verified":["x"]}<<<END>>>').decision`, 'pass', '1.1 parseVerdict pass');
    await okv(`return window.LoopWorkflow.parseVerdict('我觉得通过了')===null`, true, '1.2 无标记→null');
    await okv(`var r=window.LoopWorkflow.mergeVerdicts([{from:'A',verdict:{decision:'pass',blockers:[],verified:['x']}},{from:'B',verdict:{decision:'fail',blockers:[{what:'崩'}],verified:['y']}}]);return r.pass`, false, '1.3 OR-fail：一个 fail 整体 fail');
    await okv(`var s=window.LoopWorkflow.newLoopState();window.LoopWorkflow.advanceLoopState(s,{pass:true,blockers:[],suggestions:[],fullVerdicts:[]},Object.assign(window.LoopWorkflow.defaultConfig(),{polish:{enabled:false}}),0);return s.status`, 'done', '1.4 reaching+pass(无polish)→done');

    // ── 2. 循环配置 UI 真实渲染 + 保存 ──
    await ev(`window.__loopSaved=null;window.openWorkflowConfigModal({members:[{memberId:'m1',kind:'codex',title:'Codex'},{memberId:'m2',kind:'claude',title:'Claude'},{memberId:'m3',kind:'deepseek',title:'DeepSeek'}],config:null,onSave:function(c){window.__loopSaved=c;}});return '';`);
    await okv(`return !!document.querySelector('#workflow-config-modal')`, true, '2.1 工作流弹窗出现');
    await okv(`return !!document.querySelector('[data-wf="loop-toggle"]')`, true, '2.2 循环开关渲染');
    await okv(`return !!document.querySelector('#wf-loop-rounds')`, true, '2.3 轮次输入渲染');
    await okv(`return !!document.querySelector('#wf-loop-green')`, true, '2.4 连续绿轮输入渲染');
    // 点循环开关 → 重渲后 checked
    await ev(`document.querySelector('[data-wf="loop-toggle"]').click();return '';`);
    await okv(`return document.querySelector('[data-wf="loop-toggle"]').checked`, true, '2.5 点开关→重渲后勾选');
    // 改轮次为 5，保存
    await ev(`document.querySelector('#wf-loop-rounds').value='5';document.querySelector('.wf-save').click();return '';`);
    await okv(`return window.__loopSaved && window.__loopSaved.loop && window.__loopSaved.loop.enabled`, true, '2.6 保存→config.loop.enabled=true');
    await okv(`return window.__loopSaved.loop.maxRounds`, 5, '2.7 保存→maxRounds=5（输入被采纳）');
    await okv(`return Array.isArray(window.__loopSaved.steps) && window.__loopSaved.steps.length>0`, true, '2.8 保存→steps 非空（角色派生基础）');

    // ── 3. Phase 3：L1/L2/L3 预设 + 角色标签 ──
    await ev(`window.__loopSaved2=null;window.openWorkflowConfigModal({members:[{memberId:'m1',kind:'codex',title:'Codex'},{memberId:'m2',kind:'claude',title:'Claude'},{memberId:'m3',kind:'deepseek',title:'DeepSeek'}],config:null,onSave:function(c){window.__loopSaved2=c;}});return '';`);
    await ev(`var lt=document.querySelector('[data-wf="loop-toggle"]');if(lt&&!lt.checked)lt.click();return '';`);
    await okv(`return !!document.querySelector('[data-wf="loop-tpl"][data-ltpl="L2"]')`, true, '3.1 启用循环→出现 L1/L2/L3 预设');
    await ev(`document.querySelector('[data-wf="loop-tpl"][data-ltpl="L2"]').click();return '';`);
    await okv(`return document.querySelectorAll('.wf-step-row').length`, 3, '3.2 L2 预设→3 步（开发+2评审）');
    await okv(`return /开发/.test(document.querySelector('.wf-step-row').innerHTML)`, true, '3.3 第1步标"开发"');
    await okv(`var r=document.querySelectorAll('.wf-step-row');return /评审/.test(r[1].innerHTML)&&/评审/.test(r[2].innerHTML)`, true, '3.4 第2/3步标"评审"');
    await ev(`document.querySelector('.wf-save').click();return '';`);
    await okv(`return window.__loopSaved2 && window.__loopSaved2.loop.enabled && window.__loopSaved2.steps.length`, 3, '3.5 L2 保存→loop.enabled + 3 步');

    // ── 4. Phase 2b：断点续跑（resumeState + 续跑入口）──
    await okv(`return typeof window.__resumeLoopIfPending`, 'function', '4.1 续跑入口 __resumeLoopIfPending 存在');
    await okv(`return typeof window.LoopWorkflow.resumeState`, 'function', '4.2 resumeState 导出');
    await okv(`return window.LoopWorkflow.resumeState({status:'running',round:3,phase:'polishing',goal:'g',history:[]}).state.round`, 3, '4.3 浏览器内 resumeState 重建 round');
    await okv(`return window.LoopWorkflow.resumeState({status:'running',round:2,history:[{round:2,pass:false,blockers:[{what:'b'}]}]}).prevMerge.blockers[0].what`, 'b', '4.4 续跑回灌上一轮阻断项');
    await okv(`return window.__resumeLoopIfPending('nonexistent-meeting-id')`, false, '4.5 无该 meeting → 不误触发续跑');

    cdp.close();
  } catch (e) {
    ok(false, 'E2E 异常：' + (e && e.message));
  } finally {
    killTree(child.pid);
  }

  console.log('\n循环工作流 · CDP UI E2E');
  results.forEach(r => console.log(r));
  console.log('──────────────');
  console.log(`通过 ${results.length - fails} / 失败 ${fails}`);
  process.exit(fails > 0 ? 1 : 0);
}
main();
