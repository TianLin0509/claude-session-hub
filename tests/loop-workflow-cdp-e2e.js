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
const fs = require('fs');
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
    await okv(`return window.LoopWorkflow.parseVerdict('RESULT: PASS\\nBLOCKERS: 无\\nVERIFIED: test 3/3\\nNEXT: 无').decision`, 'pass', '1.5 v2 四行裁决可解析');

    // ── 2. 语义模板只是可选预填；自定义界面始终存在 ──
    await ev(`window.__loopSaved=null;window.openWorkflowConfigModal({members:[{memberId:'m1',kind:'codex',title:'Codex'},{memberId:'m2',kind:'claude',title:'Claude'},{memberId:'m3',kind:'deepseek',title:'DeepSeek'}],config:null,onSave:function(c){window.__loopSaved=c;}});return '';`);
    await okv(`return !!document.querySelector('#workflow-config-modal')`, true, '2.1 工作流弹窗出现');
    await okv(`return typeof window.WorkflowTemplates.createTemplateConfig`, 'function', '2.2 语义模板模块加载');
    await okv(`return !!document.querySelector('[data-wf="semantic-tpl"][data-stpl="review-plan-build-finalize"]')`, true, '2.3 语义模板可选');
    await okv(`return !!document.querySelector('[data-wf="tpl"][data-tpl="t1"]') && !!document.querySelector('[data-wf="tpl"][data-tpl="t3"]')`, true, '2.4 基础串行/自定义入口保留');
    await okv(`return !!document.querySelector('[data-wf-step-name]') && !!document.querySelector('[data-wf-step-prompt]')`, true, '2.5 步骤名称与 prompt 可编辑');
    await ev(`document.querySelector('.wf-switch').click();document.querySelector('[data-wf="semantic-tpl"][data-stpl="review-plan-build-finalize"]').click();return '';`);
    await okv(`return document.querySelectorAll('.wf-step-row').length`, 4, '2.6 方案模板填充 4 步');
    await okv(`return document.querySelectorAll('[data-wf-step-prompt]').length`, 4, '2.7 每一步都有独立 prompt');
    await ev(`var p=document.querySelector('[data-wf-step-prompt="0"]');p.value='用户自定义审视职责';p.dispatchEvent(new Event('input',{bubbles:true}));return '';`);
    await okv(`return document.querySelectorAll('.wf-tpl-card.selected').length`, 0, '2.8 手动编辑后自动转为自定义');
    await ev(`document.querySelector('.wf-save').click();return '';`);
    await okv(`return window.__loopSaved && window.__loopSaved.schemaVersion`, 2, '2.9 保存 v2 配置');
    await okv(`return window.__loopSaved.templateId`, null, '2.10 自定义后不再绑定模板');
    await okv(`return window.__loopSaved.stepConfigs[0].prompt`, '用户自定义审视职责', '2.11 自定义 prompt 持久化');

    // ── 3. 快速闭环：仅 FAIL 回修，无连续绿/自动打磨 ──
    await ev(`window.__loopSaved2=null;window.openWorkflowConfigModal({members:[{memberId:'m1',kind:'codex',title:'Codex'},{memberId:'m2',kind:'claude',title:'Claude'},{memberId:'m3',kind:'deepseek',title:'DeepSeek'}],config:null,onSave:function(c){window.__loopSaved2=c;}});return '';`);
    await ev(`document.querySelector('.wf-switch').click();document.querySelector('[data-wf="semantic-tpl"][data-stpl="fast-review-loop"]').click();return '';`);
    await okv(`return document.querySelectorAll('.wf-step-row').length`, 2, '3.1 快速闭环为 2 步');
    await okv(`return document.querySelector('[data-wf="loop-toggle"]').checked`, true, '3.2 闭环自动启用');
    await okv(`return document.querySelector('#wf-loop-rounds').value`, '3', '3.3 默认最多 3 次');
    await okv(`return !document.querySelector('#wf-loop-green')`, true, '3.4 连续绿设置已移除');
    await okv(`var r=document.querySelectorAll('.wf-step-row');return /执行/.test(r[0].innerHTML)&&/评审/.test(r[1].innerHTML)`, true, '3.5 执行/评审角色清晰');
    await ev(`document.querySelector('.wf-save').click();return '';`);
    await okv(`return window.__loopSaved2 && window.__loopSaved2.loop.enabled && window.__loopSaved2.steps.length`, 2, '3.6 闭环保存为 2 步');
    await okv(`return window.__loopSaved2.loop.polish`, false, '3.7 自动打磨明确关闭');

    // ── 4. Phase 2b：断点续跑（纯状态恢复 + main 单一驱动）──
    await okv(`return typeof require('electron').ipcRenderer.invoke`, 'function', '4.1 workflow 执行由 main IPC 驱动');
    await okv(`return typeof window.LoopWorkflow.resumeState`, 'function', '4.2 resumeState 导出');
    await okv(`return window.LoopWorkflow.resumeState({status:'running',round:3,phase:'polishing',goal:'g',history:[]}).state.round`, 3, '4.3 浏览器内 resumeState 重建 round');
    await okv(`return window.LoopWorkflow.resumeState({status:'running',round:2,history:[{round:2,pass:false,blockers:[{what:'b'}]}]}).prevMerge.blockers[0].what`, 'b', '4.4 续跑回灌上一轮阻断项');
    await okv(`return typeof window.LoopWorkflow.builderTaskText`, 'function', '4.5 renderer 仅保留纯工作流判定函数');

    // Optional visual evidence for manual/CI review. Normal test runs stay artifact-free.
    if (process.env.WORKFLOW_E2E_SCREENSHOT) {
      await ev(`window.openWorkflowConfigModal({members:[{memberId:'m1',kind:'codex',title:'Codex'},{memberId:'m2',kind:'claude',title:'Claude'},{memberId:'m3',kind:'deepseek',title:'DeepSeek'}],config:null,onSave:function(){}});document.querySelector('.wf-switch').click();document.querySelector('[data-wf="semantic-tpl"][data-stpl="review-plan-build-finalize"]').click();return '';`);
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const shotPath = path.resolve(process.env.WORKFLOW_E2E_SCREENSHOT);
      fs.mkdirSync(path.dirname(shotPath), { recursive: true });
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      ok(fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000, '5.1 UI 截图已生成');
      results.push('       screenshot: ' + shotPath);
    }

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
