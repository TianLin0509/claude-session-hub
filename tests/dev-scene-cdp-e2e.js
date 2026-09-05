'use strict';
/**
 * 开发场景 · 真实 CDP UI E2E（2026-09-05）
 *
 * 单测覆盖不到的是「在真实浏览器环境里，这几个模块拼起来还成不成立」：
 * 模块加载顺序、window 挂载、建群时默认工作流真的写进了 meeting、看板真的渲染得出来。
 *
 * 自包含：起隔离 Hub（剥离嵌套 env + 独立 data dir + CDP 9358）→ 验证 → 按 PID 清理。
 * **不碰生产 Hub。**
 *
 * 用法：node tests/dev-scene-cdp-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');

const HUB = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9358;
const CDP = `http://127.0.0.1:${PORT}`;
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-devscene-e2e';

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

async function main() {
  const child = launchHub();
  let fails = 0; const results = [];
  const ok = (c, m) => { results.push((c ? '  ok   ' : ' FAIL ') + m); if (!c) fails++; };

  try {
    let targets;
    for (let i = 0; i < 40; i++) {
      try {
        targets = JSON.parse(await get(`${CDP}/json/list`));
        if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    const t = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url));
    if (!t) { console.error('CDP 连不上'); killTree(child.pid); process.exit(2); }

    const cdp = await newCdp(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 25; i++) {
      const r = await cdp.send('Runtime.evaluate',
        { expression: 'typeof window.DevProgress', returnByValue: true }).catch(() => null);
      if (r && r.result && r.result.value === 'object') break;
      await new Promise(r => setTimeout(r, 800));
    }

    const ev = async (expr, awaitPromise = false) => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) {
        throw new Error('EVAL: ' + ((r.exceptionDetails.exception || {}).description || 'unknown'));
      }
      return r.result.value;
    };
    const okv = async (expr, expect, m, awaitPromise = false) => {
      let v; try { v = await ev(expr, awaitPromise); } catch (e) { v = 'THREW:' + e.message; }
      const p = JSON.stringify(v) === JSON.stringify(expect);
      ok(p, m + (p ? '' : ` (期望 ${JSON.stringify(expect)}，实得 ${JSON.stringify(v)})`));
    };

    // ── 1. 模块在真实环境里加载 ──
    await okv('return typeof window.DevProgress', 'object', '1.1 dev-progress 已加载');
    await okv('return typeof window.WorkflowTemplates', 'object', '1.2 workflow-templates 已加载');
    await okv('return typeof window.__devBoardShow', 'function', '1.3 看板入口可用');

    // ── 2. 通用预设：不含项目名和绝对路径 ──
    const M = `[{memberId:'m1',kind:'claude'},{memberId:'m2',kind:'codex'}]`;
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('dev-task',${M});
               return [c.steps.length, c.loop.enabled, c.loop.maxRounds]`,
      [2, true, 3], '2.1 dev-task 是两步循环，最多 3 轮');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('dev-task',${M});
               return [c.steps[0][0], c.steps[1][0]]`, ['m1', 'm2'],
      '2.2 两步落到不同成员（否则自审自合）');
    await okv(`var c=window.WorkflowTemplates.createTemplateConfig('dev-task',${M});
               var all=c.stepConfigs.map(function(s){return s.prompt}).join('\\n');
               return [/\\.agents\\/AUTHOR\\.md/.test(all), /\\.agents\\/MERGER\\.md/.test(all),
                       /[A-Za-z]:\\\\/.test(all), /SuperRAN/i.test(all)]`,
      [true, true, false, false], '2.3 用相对路径合同，无绝对路径、无项目名');

    // ── 3. 真实建一个开发群聊，验证默认工作流被写进去了（零配置的核心）──
    const mid = await ev(`return (async()=>{
      const { ipcRenderer } = require('electron');
      const m = await ipcRenderer.invoke('create-meeting', {
        mode:'dev', scene:'dev', groupChat:true, groupMode:'deliberation',
        title:'E2E 开发场景自检', participants:[0,1],
        workspace: ${JSON.stringify(HUB)},
        slots:[{index:0,kind:'claude'},{index:1,kind:'codex'}],
      });
      return m && m.id;
    })()`, true);
    ok(!!mid, '3.1 开发群聊建得出来');

    if (mid) {
      // 模拟建群弹窗那一步：把默认工作流写进去
      await ev(`
        var WT=window.WorkflowTemplates;
        var cfg=WT.createTemplateConfig('dev-task',[{memberId:'m1',kind:'claude'},{memberId:'m2',kind:'codex'}]);
        cfg.templateId='dev-task';
        require('electron').ipcRenderer.send('update-meeting',
          { meetingId:${JSON.stringify(mid)}, fields:{ serialWorkflow: cfg } });
        return true;`);
      await new Promise(r => setTimeout(r, 1500));

      await okv(`return (async()=>{
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = (ms||[]).find(x=>x.id===${JSON.stringify(mid)});
        const wf = m && m.serialWorkflow;
        return [!!wf, wf&&wf.loop&&wf.loop.enabled===true, wf&&wf.steps&&wf.steps.length];
      })()`, [true, true, 2], '3.2 默认工作流已落库且循环开启（点发送就会跑流程）', true);

      // ── 4. 看板认得出它 ──
      await okv(`return (async()=>{
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = (ms||[]).find(x=>x.id===${JSON.stringify(mid)});
        return window.DevProgress.isDevMeeting(m);
      })()`, true, '4.1 看板认得出这是开发任务', true);

      await okv(`return (async()=>{
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = (ms||[]).find(x=>x.id===${JSON.stringify(mid)});
        const row = window.DevProgress.boardRow(m, []);
        return [row.title, row.stage.key];
      })()`, ['E2E 开发场景自检', 'idle'], '4.2 看板一行能算出标题与阶段', true);
    }

    // ── 5. 看板面板真的渲染得出来 ──
    await okv(`window.__devBoardShow();
               var p=document.getElementById('ran-panel');
               return !!(p && p.querySelector('#devb-list'));`,
      true, '5.1 看板面板能打开并建出骨架');
    await new Promise(r => setTimeout(r, 1200));
    await okv(`var el=document.getElementById('devb-list');
               return !!(el && el.innerHTML.length > 0);`,
      true, '5.2 看板列表有内容（任务行或引导文案）');
    await okv(`return document.querySelector('#btn-ran .btn-label').textContent.trim()`,
      '开发', '5.3 导航按钮已改成通用说法');

    cdp.close();
  } catch (e) {
    ok(false, '异常：' + (e && e.message));
  } finally {
    killTree(child.pid);
  }

  console.log('\n开发场景 · 真实 Hub CDP E2E');
  results.forEach(r => console.log(r));
  console.log('\n──────────────');
  console.log(fails === 0 ? `全部通过（${results.length} 项）` : `失败 ${fails} / ${results.length}`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
