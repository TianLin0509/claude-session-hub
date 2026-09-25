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
  const result = { out, sessions: [] };
  let hub, c;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms;
    while (Date.now() < end) { if (await c.eval(expr)) return true; await sleep(150); } throw Error('timeout: ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', label: 'first send',
      extraEnv: { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
        CLAUDE_PROXY: 'http://127.0.0.1:9' } });
    c = await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"', 'renderer');
    await c.eval(`window.__hooks=[];ipcRenderer.on('hook-event',(_e,p)=>window.__hooks.push({at:Date.now(),sid:p.sessionId,event:p.event,msg:p.latestUserMessage||null}));true`);
    for (const [label, permissionMode] of [['A', 'bypassPermissions'], ['B', 'default'], ['C', 'default']]) {
      const s = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd, model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', fastMode: false, permissionMode } })})`);
      const sid = s.id;
      await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row');
      await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await until(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')`, 'bar');
      await c.eval(`applyViewMode('pty')`);
      await until(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return false;const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++){s+=b.getLine(i)?.translateToString(true)+'\\n';}return /❯/.test(s);})()`, 'tui', 90000);
      await sleep(1500);
      const text = `FIRST_SEND_${label}`;
      const sentAt = await c.eval(`(()=>{const box=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');box.textContent=${j(text)};box.dispatchEvent(new Event("input",{bubbles:true}));box.closest(".floating-input-bar").querySelector(".floating-input-send").click();return Date.now();})()`);
      let prompted = false;
      try { await until(`window.__hooks.some(h=>h.sid===${j(sid)}&&h.event==='prompt')`, 'prompt hook', 40000); prompted = true; } catch {}
      const buffer = await c.eval(`ipcRenderer.invoke('debug:get-session-buffer',${j(sid)})`);
      const screen = await c.eval(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;const b=t.buffer.active;const l=[];for(let i=0;i<b.length;i++)l.push(b.getLine(i).translateToString(true));return l.filter(x=>x.trim()).slice(-14).join('\\n');})()`);
      const stuck = await c.eval(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .fi-stuck:not([hidden])')`);
      const row = { label, permissionMode, sid, prompted, promptLatencyMs: prompted ? (await c.eval(`window.__hooks.find(h=>h.sid===${j(sid)}&&h.event==='prompt').at`)) - sentAt : null, stuck, screen };
      fs.writeFileSync(path.join(out, `buffer-${label}.txt`), typeof buffer === 'string' ? buffer : JSON.stringify(buffer));
      result.sessions.push(row);
      console.log(`[first-send] ${label} ${permissionMode} prompted=${prompted} latency=${row.promptLatencyMs} stuck=${stuck}`);
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
