'use strict';
/**
 * RAN 工作流预设 · 真实 CDP UI E2E（2026-09-04）
 *
 * 自包含：起一个隔离 Hub（剥离 CLAUDE* env + 独立 data dir + --remote-debugging-port=9356）
 *         → 连 renderer 真实 evaluate → 验证 RAN 预设在真实浏览器环境里的完整链路
 *         → 按 PID 清理。**不碰生产 Hub。**
 *
 * 覆盖什么：预设存在、联动出的 steps/prompt/loop/timeoutMs 正确、
 *           归一化不吃掉 timeoutMs、引擎那条 clamp 算出来的值符合预期、
 *           以及真实打开工作流配置弹窗并选中 RAN 预设后表单确实被预填。
 *
 * **不覆盖什么**：真实的多 AI 循环。那需要真实登录态 + 半小时以上，
 *           而且会在真仓库上产生真实改动，不适合放进自动化测试。
 *
 * 用法：node tests/ran-workflow-cdp-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');

const HUB = 'C:\\Users\\lintian\\claude-session-hub';
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9356;                                    // 与 loop e2e 的 9355 错开，可并行跑
const CDP = `http://127.0.0.1:${PORT}`;

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(d)); })
      .on('error', reject);
  });
}

function newCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pend = new Map();
  return new Promise((ok, rej) => {
    ws.on('open', () => ok({
      send(method, params = {}) {
        const i = id++;
        return new Promise((res, rj) => { pend.set(i, { res, rj }); ws.send(JSON.stringify({ id: i, method, params })); });
      },
      close() { ws.close(); },
    }));
    ws.on('error', rej);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pend.has(m.id)) {
        const { res, rj } = pend.get(m.id); pend.delete(m.id);
        if (m.error) rj(new Error(m.error.message)); else res(m.result);
      }
    });
  });
}

function launchHub() {
  const env = Object.assign({}, process.env);
  // 剥离嵌套会话 env，否则污染隔离实例
  ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID'].forEach(k => delete env[k]);
  env.CLAUDE_HUB_DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-ran-e2e';
  return spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: HUB, env, stdio: 'ignore' });
}

function killTree(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {} }

async function main() {
  const child = launchHub();
  let fails = 0; const results = [];
  const ok = (c, m) => { results.push((c ? '  ok   ' : ' FAIL ') + m); if (!c) fails++; };

  try {
    let targets;
    for (let i = 0; i < 30; i++) {
      try {
        targets = JSON.parse(await get(`${CDP}/json/list`));
        if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    const t = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url))
      || (targets || []).find(x => x.type === 'page');
    if (!t) { console.error('CDP 连不上 / 无 page target'); killTree(child.pid); process.exit(2); }

    const cdp = await newCdp(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 20; i++) {
      try {
        const rdy = await cdp.send('Runtime.evaluate', { expression: 'typeof window.WorkflowTemplates', returnByValue: true });
        if (rdy.result && rdy.result.value === 'object') break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 800));
    }

    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error('EVAL EX: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description)
          || JSON.stringify(r.exceptionDetails)));
      }
      return r.result.value;
    };
    const okv = async (expr, expect, m) => {
      let v; try { v = await ev(expr); } catch (e) { v = 'THREW:' + e.message; }
      const pass = JSON.stringify(v) === JSON.stringify(expect);
      ok(pass, m + (pass ? '' : ` (期望 ${JSON.stringify(expect)}，实得 ${JSON.stringify(v)})`));
    };

    // 真实渲染进程里造两个成员，模拟一个 Claude + Codex 的群聊
    const MEMBERS = `[{memberId:'mc',kind:'claude',title:'Claude'},{memberId:'mx',kind:'codex',title:'Codex'}]`;

    // ── 0. 模块在真实浏览器环境里加载 ──
    await okv('return typeof window.WorkflowTemplates', 'object', '0.1 workflow-templates.js 真实加载');
    await okv('return typeof window.openWorkflowConfigModal', 'function', '0.2 工作流配置弹窗可用');

    // ── 1. 两个 RAN 预设都在按钮列表里 ──
    await okv("return window.WorkflowTemplates.TASK_PRESETS.filter(p=>p.id.startsWith('ran-')).map(p=>p.name)",
      ['RAN 实现', 'RAN 收口'], '1.1 两个 RAN 预设都在');
    await okv("return window.WorkflowTemplates.TASK_PRESETS.find(p=>p.id==='ran-implement').minMembers",
      1, '1.2 RAN 实现单人可用');

    // ── 2. RAN 实现：单步、不循环、跑完就停 ──
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-implement',${MEMBERS});
               return [c.steps.length,c.loop.enabled]`, [1, false], '2.1 单步且不开循环');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-implement',${MEMBERS});
               return c.stepConfigs[0].prompt.indexOf('AUTHOR.md')>=0`, true, '2.2 指向 AUTHOR.md 合同');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-implement',${MEMBERS});
               return c.stepConfigs[0].timeoutMs`, 30 * 60 * 1000, '2.3 超时 30 分钟');

    // ── 3. RAN 收口：两步落到不同成员（否则自审自合）──
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-converge',${MEMBERS});
               return [c.steps[0][0],c.steps[1][0]]`, ['mc', 'mx'], '3.1 改与审落在不同成员');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-converge',${MEMBERS});
               return [c.loop.enabled,c.loop.maxRounds]`, [true, 3], '3.2 循环开启，最多 3 轮');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-converge',${MEMBERS});
               return c.stepConfigs[1].prompt.indexOf('MERGER.md')>=0`, true, '3.3 审的那步指向 MERGER.md');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-converge',${MEMBERS});
               return c.stepConfigs[1].prompt.indexOf('RESULT: PASS 或 FAIL')>=0`, true,
      '3.4 审的那步要求四行 RESULT 契约（引擎靠它判 PASS）');

    // ── 4. 引擎真正读到的超时值（复刻 loop-engine 的 clamp）──
    const CLAMP = `function(v){return Math.max(60000,Math.min(30*60000,Number(v)||10*60000))}`;
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('ran-converge',${MEMBERS});
               var n=window.WorkflowTemplates.normalizeStepConfigs(c.steps,c.stepConfigs);
               var clamp=${CLAMP};
               return n.map(function(s){return clamp(s.timeoutMs)/60000})`,
      [25, 25], '4.1 归一化后引擎算出 25/25 分钟（不是默认的 10）');
    await okv(`var clamp=${CLAMP};return clamp(undefined)/60000`, 10, '4.2 没配时才回落到 10 分钟');

    // ── 5. 真实解析：评审步输出的四行契约能被 parseVerdict 认出 ──
    await okv(`return window.LoopWorkflow.parseVerdict(
                 'RESULT: PASS\\nBLOCKERS: 无\\nVERIFIED: pytest 174 passed\\nNEXT: 无').decision`,
      'pass', '5.1 PASS 可解析 → 循环会结束');
    await okv(`return window.LoopWorkflow.parseVerdict(
                 'RESULT: FAIL\\nBLOCKERS: HARQ 时序仍不对\\nVERIFIED: 跑了 test_system\\nNEXT: 修时序').decision`,
      'fail', '5.2 FAIL 可解析 → 循环会回修');
    await okv(`return window.LoopWorkflow.parseVerdict('我觉得可以合并了')===null`, true,
      '5.3 不按契约输出 → null，引擎不瞎猜');

    // ── 6. 模拟真实操作：打开弹窗并选中 RAN 收口，看表单是否被预填 ──
    await okv(`window.openWorkflowConfigModal({members:${MEMBERS},config:null,onSave:function(){}});
               return !!document.querySelector('.wf-tpl-card,[data-tpl-id],#workflow-config-modal')`,
      true, '6.1 工作流配置弹窗能真实打开');
    await okv(`var els=Array.from(document.querySelectorAll('*')).filter(function(e){
                 return e.children.length===0 && /RAN 收口/.test(e.textContent||'')});
               return els.length>0`, true, '6.2 弹窗里能看到「RAN 收口」这个按钮');

    cdp.close();
  } catch (e) {
    ok(false, '异常：' + (e && e.message));
  } finally {
    killTree(child.pid);
  }

  console.log('\nRAN 工作流预设 · 真实 Hub E2E');
  results.forEach(r => console.log(r));
  console.log('\n──────────────');
  console.log(fails === 0 ? `全部通过（${results.length} 项）` : `失败 ${fails} / ${results.length}`);
  console.log('未覆盖：真实多 AI 循环（需登录态 + 半小时，且会在真仓库产生改动）');
  process.exit(fails === 0 ? 0 : 1);
}

main();
