'use strict';
/**
 * 开发场景 · 真实多 AI 实测（2026-09-05）
 *
 * 这一支是用户指定的验收测试，也是对本轮工作的自检：
 *   隔离 Hub → 建一个「开发」场景群聊 → codex 当工作位、claude 当合并位
 *   → 任务：审查这套开发场景本身合不合理 → 看循环转不转得起来、人话卡出不出得来。
 *
 * 安全边界：独立 data dir + 独立 CDP 端口，跑完按 PID 清理，**不碰生产 Hub**。
 * 工作目录指向本 worktree（它自己就是被审查的对象），不碰主仓库。
 *
 * 用法：node tests/dev-scene-live-e2e.js
 */
const WebSocket = require('ws');
const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HUB = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9359;
const CDP = `http://127.0.0.1:${PORT}`;
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-devscene-live';
const OUT = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\devscene-live-result.json';

const BUDGET_MS = 45 * 60 * 1000;
const t0 = Date.now();
const el = () => `${String(Math.floor((Date.now() - t0) / 1000)).padStart(4)}s`;
const log = (m) => console.log(`[${el()}] ${m}`);

const TASK = [
  '检查你们现在所在这个仓库里、我刚做好的「AI 群聊开发场景」这套东西是否合理。',
  '',
  '具体是这些：.agents/AUTHOR.md 和 MERGER.md 两份合同、.agents/project.json、',
  '.githooks/ 两个钩子、scripts/merge_task.py 合并脚本、renderer/dev-progress.js 看板数据层、',
  '以及 renderer/workflow-templates.js 里那个 dev-task 预设。',
  '',
  '我要的是判断，不是罗列：这套流程有没有明显漏洞、会不会在真实并行开发里失效、',
  '有没有哪里对使用者（一个不看代码的维护者）来说是多余或欠缺的。',
  '发现真问题就直接改，改完按合同交接。没有真问题就明说，不要为了凑数挑毛病。',
].join('\n');

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
      close() { try { ws.close(); } catch (e) {} },
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
  const result = { ok: false, why: '未开始', transcript: [], stage: null };

  try {
    log('等隔离 Hub 起来…');
    let targets;
    for (let i = 0; i < 45; i++) {
      try {
        targets = JSON.parse(await get(`${CDP}/json/list`));
        if (targets.find(x => x.type === 'page' && /index\.html/.test(x.url))) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    const tgt = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url));
    if (!tgt) throw new Error('CDP 无 page target');

    const cdp = await newCdp(tgt.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const ev = async (expr, awaitPromise = true) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) {
        throw new Error('EVAL: ' + ((r.exceptionDetails.exception || {}).description || 'unknown'));
      }
      return r.result.value;
    };
    for (let i = 0; i < 30; i++) {
      if (await ev('typeof window.DevProgress').catch(() => '') === 'object') break;
      await new Promise(r => setTimeout(r, 800));
    }
    log('renderer 就绪');

    // ── 建开发群聊：m1=codex(工作位)，m2=claude(合并位) ──
    const mid = await ev(`(async()=>{
      const { ipcRenderer } = require('electron');
      const m = await ipcRenderer.invoke('create-meeting', {
        mode:'dev', scene:'dev', groupChat:true, groupMode:'deliberation',
        title:'审查开发场景设计', participants:[0,1], groupRecentRawN:5,
        workspace: ${JSON.stringify(HUB)},
        slots:[{index:0,kind:'codex'},{index:1,kind:'claude'}],
      });
      return m && m.id;
    })()`);
    if (!mid) throw new Error('建群聊失败');
    log(`群聊已建：${mid}（codex=工作位 / claude=合并位）`);

    // ── 建群那一刻写入默认工作流（复刻 _applyDefaultDevWorkflow）──
    await ev(`(()=>{
      const WT = window.WorkflowTemplates;
      const cfg = WT.createTemplateConfig('dev-task',
        [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}]);
      cfg.templateId='dev-task';
      require('electron').ipcRenderer.send('update-meeting',
        { meetingId:${JSON.stringify(mid)}, fields:{ serialWorkflow: cfg } });
      return true;
    })()`, false);
    await new Promise(r => setTimeout(r, 1500));
    log('默认工作流已写入');

    // ── 等两个 CLI 会话就绪 ──
    let subs = [];
    for (let i = 0; i < 100; i++) {
      subs = await ev(`(async()=>{
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = (ms||[]).find(x=>x.id===${JSON.stringify(mid)});
        return (m && m.subSessions) || [];
      })()`).catch(() => []);
      if (subs.length >= 2) break;
      if (i % 10 === 9) log(`  …已等 ${(i + 1) * 2}s，subSessions=${subs.length}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (subs.length < 2) throw new Error('会话没起来，subSessions=' + subs.length);
    log(`两个会话就绪，给 CLI 首屏 30 秒`);
    await new Promise(r => setTimeout(r, 30000));

    // ── 发任务（走 loop:start，等同于用户在输入框打字后点发送）──
    const started = await ev(`(async()=>{
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('meeting-append-user-turn',
        { meetingId:${JSON.stringify(mid)}, text:${JSON.stringify(TASK)} }).catch(()=>{});
      return await ipcRenderer.invoke('loop:start',
        { meetingId:${JSON.stringify(mid)}, userInput:${JSON.stringify(TASK)} });
    })()`);
    log('loop:start → ' + JSON.stringify(started));
    if (!started || !started.ok) throw new Error('启动失败：' + JSON.stringify(started));

    // ── 盯状态 ──
    let last = '';
    while (Date.now() - t0 < BUDGET_MS) {
      await new Promise(r => setTimeout(r, 20000));
      const st = await ev(`(async()=>{
        const { ipcRenderer } = require('electron');
        const s = await ipcRenderer.invoke('loop:status', { meetingId:${JSON.stringify(mid)} });
        const ms = await ipcRenderer.invoke('get-meetings');
        const m = (ms||[]).find(x=>x.id===${JSON.stringify(mid)});
        return { loop: s, stage: m ? window.DevProgress.deriveStage(m) : null };
      })()`).catch(() => null);
      if (!st) continue;
      const ls = (st.loop && st.loop.loopState) || {};
      const brief = JSON.stringify({ s: ls.status, r: ls.round, run: st.loop && st.loop.running,
        stage: st.stage && st.stage.label });
      if (brief !== last) { log('状态 ' + brief); last = brief; }
      result.stage = st.stage;
      const status = ls.status || '';
      if (status === 'done') {
        result.ok = true;
        result.why = `循环正常结束，${ls.round || 0} 轮`;
        break;
      }
      if (status && !(st.loop && st.loop.running)) {
        result.ok = false;
        result.why = '非达标结束：' + status + `（${ls.round || 0} 轮）`;
        break;
      }
    }
    if (!result.why || result.why === '未开始') result.why = '超出预算仍未结束';

    // ── 把两位的最终发言抓下来（这才是用户要看的东西）──
    const msgs = await ev(`(async()=>{
      const { ipcRenderer } = require('electron');
      const r = await ipcRenderer.invoke('groupchat:get-state', { meetingId:${JSON.stringify(mid)} })
        .catch(()=>null);
      const turns = (r && (r.turns || r.messages || r.timeline)) || [];
      return turns.slice(-12).map(function(t){
        return { from: t.from || t.role || t.slotLabel || '', text: String(t.text||t.content||'').slice(0,4000) };
      });
    })()`).catch(() => []);
    result.transcript = msgs || [];

    cdp.close();
  } catch (e) {
    result.ok = false;
    result.why = '异常：' + (e && e.message);
  } finally {
    killTree(child.pid);
  }

  result.elapsedSec = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf-8');

  console.log('\n────────── 结果 ──────────');
  console.log('循环判定 :', result.ok ? '正常结束' : '未正常结束 —— ' + result.why);
  console.log('看板阶段 :', result.stage ? result.stage.label : '(无)');
  console.log('耗时     :', result.elapsedSec + 's');
  console.log('发言存档 :', OUT);
  console.log('\n最后几轮发言：');
  for (const m of result.transcript.slice(-4)) {
    console.log('\n─── ' + (m.from || '?') + ' ───');
    console.log(m.text.slice(0, 1500));
  }
  process.exit(result.ok ? 0 : 1);
}

main();
