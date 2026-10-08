'use strict';
// 2026-10-09 用户反馈：在 Hub 输入框点发送，文字要隔一会儿才出现在 CLI 输入框、再隔一会儿才提交。
// 隔离 Hub + 真实 Claude CLI（CLAUDE_PROXY 指向不可达端口：UserPromptSubmit hook 照常触发，
// 模型请求立即失败，不消耗额度）。界面上真实输入并点发送，记录每条消息的时间线：
//   click → 第一次写入 PTY → CLI 输入框出现文字 → 写回车 → CLI 确认收到（UserPromptSubmit）
// 用法：node tests/e2e-prompt-submit-timeline-cdp.js [label]
//   HUB_ENTRY=<Hub 目录> 对照旧代码。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const label = process.argv[2] || 'run';
const HUB = process.env.HUB_ENTRY || path.resolve(__dirname, '..');

const PROMPTS = [
  ['short', '你好，帮我看一下这个函数为什么慢 T1'],
  ['lines5', ['第一行：背景说明 T2', '第二行：现象是点击后卡顿', '第三行：期望即点即开', '第四行：不要牺牲功能', '第五行：测试完成后合入'].join('\n')],
  ['para600', ('这是一段较长的说明文字，用来模拟一次正常长度的提问，里面有中文标点和 English words。'.repeat(14)).slice(0, 600) + ' T3'],
  // 拆成 60 段小粘贴逐段写入：回显判定不能在中途提前按回车。
  ['lines60', Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：要求与验收标准逐条列出，保持原样 L${i + 1}`).join('\n') + '\n结尾 T4'],
  // 超过 3200 字整段粘贴，CLI 折叠成标记：走折叠标记路径。
  ['long4000', ('长消息正文，用来验证折叠粘贴仍能完整送达。'.repeat(200)).slice(0, 4000) + ' T5'],
];
// Claude 自己落盘的用户消息（排除工具结果与注入提醒）。
function userTexts(claudeHome) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'user' || r.isMeta || !r.message) continue; let c = r.message.content;
      if (Array.isArray(c)) { if (c.some(x => x.type === 'tool_result')) continue; c = c.filter(x => x.type === 'text').map(x => x.text).join('\n'); }
      if (typeof c === 'string' && c.trim() && !/^<(command|local-command|system-reminder)/.test(c.trim())) out.push(c); } } } };
  const projects = path.join(claudeHome, 'projects'); if (fs.existsSync(projects)) walk(projects);
  return out;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-submit-timeline-'));
  const out = path.resolve('artifacts/prompt-submit-timeline'); fs.mkdirSync(out, { recursive: true });
  const claudeHome = path.join(root, 'claude'), cwd = path.join(root, 'workspace'), trace = path.join(root, 'writes.jsonl');
  for (const d of [claudeHome, cwd]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), path.join(claudeHome, '.credentials.json'));
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, projects: {} }));
  ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
  // 只记录写入时刻，不改变写入行为。后台窗口不节流，计时才可信。
  const entryPath = path.join(root, 'timeline-entry.cjs');
  fs.writeFileSync(entryPath, `
    const fs=require('node:fs');const {app}=require('electron');
    app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));
    const {SessionManager}=require(${j(path.join(HUB, 'core/session-manager.js'))});
    const write=SessionManager.prototype.writeToSession;
    SessionManager.prototype.writeToSession=function(sid,data){
      fs.appendFileSync(${j(trace)},JSON.stringify({sid,at:Date.now(),len:String(data).length,enter:data==='\\r',head:String(data).slice(0,12)})+'\\n');
      return write.apply(this,arguments);
    };
    require(${j(path.join(HUB, 'main-bootstrap.js'))});`, 'utf8');
  const result = { label, entry: HUB, runs: [] };
  let hub, c;
  const until = async (expr, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return true; await sleep(100); } throw Error('timeout: ' + what); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'background', label: 'submit-timeline-' + label, entryPath,
      extraEnv: { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_PROXY: 'http://127.0.0.1:9' } });
    c = await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"', 'renderer');
    await c.eval(`window.__hooks=[];ipcRenderer.on('hook-event',(_e,p)=>window.__hooks.push({at:Date.now(),sid:p.sessionId,event:p.event,msg:p.latestUserMessage||p.prompt||null}));true`);
    const s = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd, model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', fastMode: false, permissionMode: 'bypassPermissions' } })})`);
    const sid = s.id;
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row');
    await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')`, 'composer');
    const screenText = `(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return '';const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++)s+=(b.getLine(i)?.translateToString(true)||'')+'\\n';return s;})()`;
    await until(`/❯/.test(${screenText})`, 'claude tui', 90000);
    await sleep(4000);
    for (const [name, text] of PROMPTS) {
      const marker = text.slice(-2);
      const hooksBefore = await c.eval(`window.__hooks.filter(h=>h.sid===${j(sid)}&&h.event==='prompt').length`);
      fs.writeFileSync(trace, '');
      // 在渲染进程里轮询终端缓冲：文字第一次出现在 CLI 里的时刻。
      await c.eval(`window.__seenAt=0;clearInterval(window.__seenTimer);window.__seenTimer=setInterval(()=>{if(!window.__seenAt&&${screenText}.includes(${j(marker)}))window.__seenAt=Date.now();},5);true`);
      const point = await c.eval(`(()=>{const bar=document.querySelector('.floating-input-bar[data-session-id="${sid}"]');const box=bar.querySelector('.floating-input-box');box.focus();
        replaceContenteditableText(box,${j(text)});box.dispatchEvent(new Event('input',{bubbles:true}));
        const r=bar.querySelector('.floating-input-send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      const clickAt = Date.now();
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      let prompted = true;
      try { await until(`window.__hooks.filter(h=>h.sid===${j(sid)}&&h.event==='prompt').length>${hooksBefore}`, 'prompt hook ' + name, 30000); } catch { prompted = false; }
      await sleep(300);
      const promptAt = prompted ? await c.eval(`window.__hooks.filter(h=>h.sid===${j(sid)}&&h.event==='prompt').at(-1).at`) : null;
      const seenAt = await c.eval('window.__seenAt');
      await c.eval('clearInterval(window.__seenTimer);true');
      const writes = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(w => w.sid === sid && w.at >= clickAt - 50);
      const firstWrite = writes.find(w => !w.enter), lastText = [...writes].reverse().find(w => !w.enter && w.at < (writes.find(x => x.enter)?.at || Infinity)), enter = writes.find(w => w.enter);
      const rel = t => (t ? t - clickAt : null);
      const row = { name, chars: text.length, prompted, firstWriteMs: rel(firstWrite?.at), lastTextWriteMs: rel(lastText?.at), textVisibleMs: rel(seenAt), enterMs: rel(enter?.at), acceptedMs: rel(promptAt),
        textWrites: writes.filter(w => !w.enter).length, enters: writes.filter(w => w.enter).length };
      result.runs.push(row);
      console.log(j(row));
      if (process.env.TIMELINE_DUMP === '1') {
        const buffer = await c.eval(`ipcRenderer.invoke('debug:get-session-buffer',${j(sid)})`);
        fs.writeFileSync(path.join(out, `${label}-${name}-buffer.txt`), typeof buffer === 'string' ? buffer.slice(-6000) : j(buffer));
      }
      await sleep(3000);
    }
    // 逐字核对：每条消息都被 Claude 完整收下（允许 CLI 把粘贴包进 pasted_content 外壳）。
    await sleep(2000);
    const received = userTexts(claudeHome);
    result.received = received.map(r => ({ chars: r.length, head: r.slice(0, 60), tail: r.slice(-60) }));
    for (const [name, text] of PROMPTS) {
      const row = result.runs.find(r => r.name === name);
      const norm = s => String(s).replace(/\r\n?/g, '\n').trim();
      // CLI 收到的原文：UserPromptSubmit hook 带的消息（离线时后续消息不落盘，故两路取其一）。
      const hooked = await c.eval(`window.__hooks.filter(h=>h.sid===${j(sid)}&&h.event==='prompt').map(h=>h.msg||'')`);
      row.intact = [...received, ...hooked].some(r => norm(r) === norm(text) || norm(r).includes(norm(text)));
      row.hookChars = Math.max(0, ...hooked.filter(h => norm(h).includes(norm(text).slice(-8))).map(h => h.length));
    }
    result.passed = result.runs.every(r => r.prompted && r.intact);
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    try { if (hub) await gracefulQuit(hub, { timeoutMs: 60000 }); } catch {}
    try { fs.unlinkSync(path.join(claudeHome, '.credentials.json')); } catch {}
    fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(result, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    console.log(JSON.stringify({ label, passed: result.passed, error: result.error }, null, 1));
  }
})();
