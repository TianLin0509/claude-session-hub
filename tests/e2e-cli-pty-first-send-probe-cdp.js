'use strict';
// 诊断：新建 PTY Claude 会话的第一条消息能否进入 CLI。不调用真实模型 ——
// ANTHROPIC_BASE_URL 指向本机不存在的端口，UserPromptSubmit hook 仍会触发（它在请求之前），
// 请求本身立即失败，不消耗额度。用法：node tests/e2e-cli-pty-first-send-probe-cdp.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-first-send-'));
  const out = path.resolve('artifacts/cli-pty-core/first-send-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const claudeHome = path.join(root, 'claude'), cwd = path.join(root, 'workspace');
  for (const d of [claudeHome, cwd]) fs.mkdirSync(d, { recursive: true });
  const claudeAuth = path.join(os.homedir(), '.claude', '.credentials.json');
  fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
    bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, projects: {} }));
  ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
  const result = { out, dropFirstEnter: process.env.PROBE_DROP_FIRST_ENTER === '1', baseline: process.env.PROBE_RECOVERY_BASELINE === '1', sessions: [] };
  // Controlled transport fault: drop only the first submit Enter and expose a
  // stale previous-turn status to the ring probe. The real CLI still renders
  // the pending short text; acceptance is its real UserPromptSubmit hook.
  let entryPath = path.resolve(__dirname, '..');
  if (process.env.PROBE_DROP_FIRST_ENTER === '1') {
    entryPath = path.join(out, 'fault-entry.cjs');
    fs.writeFileSync(entryPath, `
      const fs = require('node:fs');
      const {SessionManager} = require(${j(path.resolve(__dirname, '../core/session-manager.js'))});
      const counts = new Map();
      if (${j(process.env.PROBE_RECOVERY_BASELINE === '1')}) {
        const submit = require(${j(path.resolve(__dirname, '../core/pty-prompt-submit.js'))});
        const detect = submit.pasteStillInInputBox;
        submit.pasteStillInInputBox = probe => detect(probe);
      }
      const write = SessionManager.prototype.writeToSession;
      const buffer = SessionManager.prototype.getSessionBuffer;
      SessionManager.prototype.writeToSession = function(sid, data) {
        if(data === '\\r') {
          const n = (counts.get(sid) || 0) + 1; counts.set(sid, n);
          fs.appendFileSync(${j(path.join(out, 'enter-trace.jsonl'))}, JSON.stringify({sid,n,at:Date.now(),dropped:n===1})+'\\n');
          if(n===1) return;
        }
        return write.apply(this, arguments);
      };
      SessionManager.prototype.getSessionBuffer = function(sid) {
        const text = buffer.apply(this, arguments);
        return counts.get(sid) === 1 ? text+'\\r\\n· Thinking… (3s)\\r\\n' : text;
      };
      require(${j(path.resolve(__dirname, '../main-bootstrap.js'))});
    `, 'utf8');
  }
  let hub, c;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms;
    while (Date.now() < end) { if (await c.eval(expr)) return true; await sleep(150); } throw Error('timeout: ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'background', label: 'first send', entryPath,
      extraEnv: { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
        ...(process.env.PROBE_LIVE_NETWORK === '1' ? {} : { CLAUDE_PROXY: 'http://127.0.0.1:9' }) } });
    c = await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"', 'renderer');
    await c.eval(`window.__hooks=[];ipcRenderer.on('hook-event',(_e,p)=>window.__hooks.push({at:Date.now(),sid:p.sessionId,event:p.event,msg:p.latestUserMessage||null}));true`);
    for (const [label, permissionMode] of (process.env.PROBE_ONLY_B === '1' ? [['B', 'default']] : process.env.PROBE_LIVE_NETWORK === '1' ? [['A', 'bypassPermissions'], ['B', 'default']] : [['A', 'bypassPermissions'], ['B', 'default'], ['C', 'default']])) {
      const s = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd, model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', fastMode: false, permissionMode } })})`);
      const sid = s.id;
      await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row');
      await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await until(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')`, 'bar');
      await c.eval(`applyViewMode('pty')`);
      await until(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return false;const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++){s+=b.getLine(i)?.translateToString(true)+'\\n';}return /❯/.test(s);})()`, 'tui', 90000);
      await sleep(1500);
      await c.eval(`window.__stuckLog=[];if(!window.__origMark){window.__origMark=markFloatingInputStuck;markFloatingInputStuck=function(bar,sid){window.__stuckLog.push({t:Date.now(),stack:new Error().stack.split(String.fromCharCode(10)).slice(2,5).join(' | '),del:JSON.stringify(floatingPromptDeliveries.get(sid))});return window.__origMark.apply(this,arguments);};}true`);
      const text = `FIRST_SEND_${label}`;
      const sentAt = await c.eval(`(()=>{const box=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');box.textContent=${j(text)};box.dispatchEvent(new Event("input",{bubbles:true}));box.closest(".floating-input-bar").querySelector(".floating-input-send").click();return Date.now();})()`);
      let prompted = false;
      try { await until(`window.__hooks.some(h=>h.sid===${j(sid)}&&h.event==='prompt')`, 'prompt hook', 40000); prompted = true; } catch {}
      const buffer = await c.eval(`ipcRenderer.invoke('debug:get-session-buffer',${j(sid)})`);
      const screen = await c.eval(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;const b=t.buffer.active;const l=[];for(let i=0;i<b.length;i++)l.push(b.getLine(i).translateToString(true));return l.filter(x=>x.trim()).slice(-14).join('\\n');})()`);
      const stuck = await c.eval(`document.querySelector('.floating-input-bar[data-session-id="${sid}"] .fi-stuck')?.innerText||false`);
      const draft = await c.eval(`document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')?.textContent||''`);
      const probeState = await c.eval(`({agentRuntime: sessions.get(${JSON.stringify(sid)})?.agentRuntime, toasts: [...document.querySelectorAll('.toast, .hub-toast, [class*=toast]')].map(e=>e.innerText).filter(Boolean).slice(-3)})`);
      const stuckLog = await c.eval('window.__stuckLog');
      const delivery = await c.eval(`floatingPromptDeliveries.get(${j(sid)})`);
      const row = { label, permissionMode, sid, draft, probeState, stuckLog, delivery, prompted, promptLatencyMs: prompted ? (await c.eval(`window.__hooks.find(h=>h.sid===${j(sid)}&&h.event==='prompt').at`)) - sentAt : null, stuck, screen };
      fs.writeFileSync(path.join(out, `buffer-${label}.txt`), typeof buffer === 'string' ? buffer : JSON.stringify(buffer));
      result.sessions.push(row);
      if (process.env.PROBE_DROP_FIRST_ENTER === '1' && prompted === (process.env.PROBE_RECOVERY_BASELINE === '1')) process.exitCode = 1;
      console.log(`[first-send] ${label} ${permissionMode} prompted=${prompted} latency=${row.promptLatencyMs} stuck=${stuck} draft=${JSON.stringify(draft)} state=${JSON.stringify(probeState)}`);
    }
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    try { if (hub) result.hubLog = hub.log().filter(l => /group-chat|prompt-submit|claude hook/.test(l)).slice(-80); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.unlinkSync(path.join(claudeHome, '.credentials.json')); } catch {}
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ out, error: result.error, sessions: result.sessions.map(s => ({ label: s.label, prompted: s.prompted, stuck: s.stuck })), hubLog: result.hubLog }, null, 2));
  }
}
main();
