'use strict';
// 2026-10-08 生产实测：侧栏每秒重画约 3.5 次，每次把全部会话（1,571 个）分类两遍、
// 排序两遍；其中 82% 的重画来自运行中 TUI 的状态心跳（只刷新观测时间，侧栏无可见变化）。
// 隔离 Hub 上验证两件事：
//   cost   同一份会话数据连续重画 N 次的耗时，并输出侧栏 HTML 指纹（新旧代码应完全一致）
//   pulse  运行中会话的重复心跳不再触发重画；证据文字变化、跑完、需要输入仍然触发
// 用法：node tests/e2e-sidebar-render-cost-cdp.js [label]
//   HUB_ENTRY=<Hub 目录>    对照旧代码；HUB_STATE_FILE=<state.json> 用真实会话副本（只读复制）
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const label = process.argv[2] || 'run';

function syntheticState() {
  const now = Date.now();
  return { version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {}, sessions: Array.from({ length: 1500 }, (_, i) => ({
    hubId: crypto.randomUUID(), title: `合成会话 ${i}`, kind: i % 3 ? 'claude' : 'codex', cwd: os.tmpdir(), ccSessionId: crypto.randomUUID(),
    lastMessageTime: now - i * 47 * 60000, createdAt: now - i * 50 * 60000, updatedAt: now, savedAt: now, pinned: i === 7, unreadCount: i % 89 === 0 ? 1 : 0,
    currentModel: { id: 'claude-haiku-4-5' }, schemaVersion: 1 })) };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-cost-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data, { recursive: true });
  const state = process.env.HUB_STATE_FILE ? JSON.parse(fs.readFileSync(process.env.HUB_STATE_FILE, 'utf8')) : syntheticState();
  state.cleanShutdown = true;
  fs.writeFileSync(path.join(data, 'state.json'), j(state));
  const entryPath = path.join(root, 'foreground-scheduling.cjs');
  fs.writeFileSync(entryPath, `const {app}=require('electron');app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));require(${j(path.join(process.env.HUB_ENTRY || path.resolve(__dirname, '..'), 'main-bootstrap.js'))});`);
  const report = { label, entry: process.env.HUB_ENTRY || 'worktree', sessions: state.sessions.length, checks: [] };
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'sidebar-cost-' + label, entryPath,
    // 空的 Claude/Codex 目录：后台历史索引不去扫真实记录，计时才干净。
    extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), DEEPSEEK_API_KEY: '' } });
  const c = await connectFirstPage(hub);
  try {
    const end = Date.now() + 90000;
    while (!await c.eval(`typeof sessions!=='undefined' && sessions.size>=${Math.min(100, state.sessions.length)} && typeof renderSessionList==='function'`)) {
      if (Date.now() > end) throw Error('sessions not loaded'); await sleep(200);
    }
    await sleep(3000);
    // cost：同步调用整次侧栏重画（含助理状态发布、分组、排序和 DOM 提交）。
    report.cost = await c.eval(`(()=>{const times=[];for(let i=0;i<60;i++){const t=performance.now();renderSessionList();times.push(performance.now()-t);}
      times.splice(0,10);times.sort((a,b)=>a-b);
      const html=document.getElementById('session-list').innerHTML.replace(/<span class="sl-time[^>]*>[^<]*<\\/span>/g,'');
      let h=0;for(let i=0;i<html.length;i++)h=(h*31+html.charCodeAt(i))|0;
      return {medianMs:+times[25].toFixed(2),p90Ms:+times[45].toFixed(2),rows:document.querySelectorAll('#session-list .session-item').length,htmlChars:html.length,htmlHash:h};})()`);
    // pulse：在真实界面代码里放一个运行中的 Claude PTY 会话，喂相同的状态心跳。
    report.pulse = await c.eval(`(async()=>{
      const id='pulse-'+Date.now();const now=Date.now();
      sessions.set(id,{id,title:'心跳测试',kind:'claude',agentRuntime:'pty',status:'running',cwd:'C:/tmp',createdAt:now,lastMessageTime:now,runStartedAt:now-5000,_agentWorking:'pty',_runSource:'pty-semantic'});
      const s=sessions.get(id);renderSessionList();
      const req=()=>sidebarRenderCoalescer.stats().requests;
      const step=async(label,runtime,times=1)=>{const before=req();for(let i=0;i<times;i++){applyPtyRuntimeObservation(s,runtime,Date.now());await new Promise(r=>setTimeout(r,5));}return [label,req()-before];};
      const run={state:'running',confidence:'strong',reason:'claude-active-status',evidence:'✽ Zesting… (1m 2s)'};
      const out=[];
      out.push(await step('first running frame',run));
      out.push(await step('same frame x10',run,10));
      out.push(await step('evidence changed',{...run,evidence:'✽ Zesting… (2m 0s)'}));
      out.push(await step('waiting for input',{state:'waiting',confidence:'strong',reason:'claude-permission',evidence:'Do you want to proceed?'}));
      const dot=document.querySelector('#session-list .session-item[data-session-id="'+id+'"]');
      sessions.delete(id);renderSessionList();
      return {steps:out,status:s.status,truth:s.runtimeTruth&&s.runtimeTruth.state,rowSeen:!!dot};})()`);
    report.passed = true;
  } finally {
    const out = path.resolve('artifacts/sidebar-render-cost'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 1));
    await c.close().catch(() => {});
    await gracefulQuit(hub, { timeoutMs: 60000 }).catch(e => console.warn('quit', String(e)));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
