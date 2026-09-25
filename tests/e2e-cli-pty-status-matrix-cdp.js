'use strict';
// 真实 Hub + 真实 CLI（PTY 模式）状态矩阵。
//
// 隔离：独立 Hub 数据目录、独立 Claude 配置目录与 Codex home（只拷入登录凭据，
// 结束即删并核对生产凭据未变），不碰生产 Hub。
//
// 每个场景记录 Hub 显示的状态时间线，与场景的真值比对：
//   · 提交后 ≤2s 显示运行（或开始）；
//   · CLI 真正结束后 ≤3s 显示完成（真值取 transcript / rollout 里最后一条记录的时间）；
//   · 最终状态必须正确；失焦完成的会话未读恰好 +1。
// 用法：node tests/e2e-cli-pty-status-matrix-cdp.js [--only=claude|codex] [--skip-long]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const ONLY = [...args].find(a => a.startsWith('--only='))?.slice(7) || null;
const want = group => !ONLY || ONLY.split(',').includes(group);
const SKIP_LONG = args.has('--skip-long');
const CLAUDE_MODEL = process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
// gpt-5.5 已进入退役期，启动会弹迁移选择框；用当前模型，与用户日常一致。
const CODEX_MODEL = process.env.REAL_CODEX_MODEL || 'gpt-5.6-sol';
const LONG_SECONDS = Number(process.env.PTY_LONG_SECONDS || 130);
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-matrix-'));
  const out = path.resolve('artifacts/cli-pty-core/status-matrix-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const claudeSource = path.join(os.homedir(), '.claude'), claudeAuth = path.join(claudeSource, '.credentials.json');
  const codexSource = path.join(os.homedir(), '.codex'), codexAuth = path.join(codexSource, 'auth.json');
  const before = { claude: hash(claudeAuth), codex: hash(codexAuth) };
  const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), cwd = path.join(root, 'workspace');
  for (const d of [claudeHome, codexHome, cwd]) fs.mkdirSync(d, { recursive: true });
  // Claude：只拷凭据；onboarding / bypass 警告 / 信任预置好，hook 按生产同一套部署到隔离配置目录。
  fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
    bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, projects: {} }, null, 2));
  const hookDeploy = ensureClaudeHookIntegration({ claudeDir: claudeHome, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
  // Codex：只拷凭据和模型目录；Hub 启动 PTY Codex 时自己部署 hook 并写信任。
  fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
  if (fs.existsSync(path.join(codexSource, 'models_cache.json'))) fs.copyFileSync(path.join(codexSource, 'models_cache.json'), path.join(codexHome, 'models_cache.json'));
  // 与生产一致：用户早已看过模型退役提示（~/.codex/config.toml 里有同样的计数），
  // 否则启动选择框会拦住首条消息（Hub 此时会拒发并提示，见 unit-pty-first-prompt-ready）。
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = ' + j(CODEX_MODEL) + '\nmodel_reasoning_effort = "low"\n\n[tui.model_availability_nux]\n' + j(CODEX_MODEL) + ' = 4\n');

  const result = { root, out, claudeModel: CLAUDE_MODEL, codexModel: CODEX_MODEL, hookDeployErrors: hookDeploy.errors,
    scenarios: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 120000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await c.eval(expr)) return Date.now(); await sleep(150); }
    throw Error('timeout: ' + label + ' :: ' + expr.slice(0, 200));
  };
  const snap = async name => { const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  const open = async sid => {
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'sidebar row ' + sid, 20000);
    await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until('!!document.querySelector(".floating-input-box")', 'composer'); await sleep(300); };
  const send = async text => c.eval(`(()=>{const box=document.querySelector('.floating-input-bar[data-session-id="'+activeSessionId+'"] .floating-input-box');box.textContent=${j(text)};box.dispatchEvent(new Event("input",{bubbles:true}));box.closest(".floating-input-bar").querySelector(".floating-input-send").click();return Date.now();})()`);
  const key = (sid, data) => c.eval(`ipcRenderer.send('terminal-input',{sessionId:${j(sid)},data:${j(data)}})`);
  const view = mode => c.eval(`applyViewMode(${j(mode)})`);
  const screenText = sid => c.eval(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return '';const b=t.buffer.active;const l=[];for(let i=0;i<b.length;i++)l.push(b.getLine(i).translateToString(true));return l.join('\\n');})()`);
  // 隔离配置是全新的：联网时 default 权限模式的 Claude 会先问要不要用 Chrome 扩展。
  // 真实用户早已答过；这里像人一样按 Esc（「不用浏览器工具」），不替用户选「用」。
  const dismissClaudeStartupPrompt = async sid => {
    if (!/Esc to keep browser tools off/.test(await screenText(sid))) return false;
    await key(sid, String.fromCharCode(27));
    await until(`!/Esc to keep browser tools off/.test((()=>{const t=terminalCache.get(${j(sid)})?.terminal;const b=t.buffer.active;const l=[];for(let i=Math.max(0,b.length-15);i<b.length;i++)l.push(b.getLine(i).translateToString(true));return l.join(' ');})())`, 'chrome prompt dismissed', 15000);
    await sleep(1500);
    return true;
  };
  const status = sid => c.eval(`(()=>{const s=sessions.get(${j(sid)});if(!s)return null;
    const t=getSessionRuntimeTruth(s);const d=deriveSessionRuntimeStatus(s,{isRunning:isSessionCardWorking(s)});
    return {truth:t.state,shown:d.state,detail:d.detail||'',unread:s.unreadCount||0,attention:s.attentionState||null,
      codexSid:s.codexSid||null,cc:s.ccSessionId||null,transcript:s.transcriptPath||null,backend:s.runtimeBackend||null,agentRuntime:s.agentRuntime||null};})()`);
  const cards = sid => c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)},opts:{limit:6,fromTail:true}}).then(r=>({error:r.error,turns:(r.turns||[]).map(t=>({role:t.role,text:String(t.text||'').slice(0,160),outcome:t.nativeOutcome||t.stopReason||null,phases:(t.displayMessages||[]).map(m=>m.phase),tools:(t.toolCalls||[]).map(x=>({name:x.name,status:x.status||null,ms:x.durationMs||null}))}))}))`);
  const timeline = sid => c.eval(`(window.__ptyLog&&window.__ptyLog[${j(sid)}])||[]`);
  const resetTimeline = sid => c.eval(`(window.__ptyLog||(window.__ptyLog={}))[${j(sid)}]=[]`);
  const isRunningState = s => ['running', 'starting'].includes(s);

  // 一个场景：提交 → 记录时间线 → 等真值结束 → 判定。
  async function scenario(name, sid, fn) {
    // PTY_SCENARIOS=claude-permission,group-chat：只跑点名的场景，省额度。
    if (process.env.PTY_SCENARIOS && !process.env.PTY_SCENARIOS.split(',').includes(name)) return;
    const record = { name, sid, ok: false, checks: [] };
    result.scenarios.push(record);
    const t0 = Date.now();
    try {
      await resetTimeline(sid);
      await fn(record);
      record.ok = true;
    } catch (error) {
      record.error = String(error && error.stack || error).slice(0, 2000);
      try { await snap('fail-' + name); } catch {}
      try { record.ui = await c.eval('document.querySelector("#msg-overlay")?.innerText.slice(-1500)||""'); } catch {}
    } finally {
      record.elapsedMs = Date.now() - t0;
      try { record.timeline = await timeline(sid); } catch {}
      try { record.final = await status(sid); } catch {}
      console.log(`[matrix] ${record.ok ? 'PASS' : 'FAIL'} ${name} (${Math.round(record.elapsedMs / 1000)}s)` + (record.error ? ' :: ' + record.error.split('\n')[0] : ''));
    }
  }
  // 从提交时刻起多久显示运行；结束后多久显示完成。
  async function expectRunsThenSettles(record, sid, submittedAt, { settle = 'completed', ms = 240000, runWithinMs = 2000 } = {}) {
    const runAt = await until(`(()=>{const s=sessions.get(${j(sid)});const t=getSessionRuntimeTruth(s).state;return ['running','starting','waiting'].includes(t);})()`, 'running', 15000);
    record.runLatencyMs = runAt - submittedAt;
    assert.ok(record.runLatencyMs <= runWithinMs + 400, `running shown ${record.runLatencyMs}ms after submit (budget ${runWithinMs}ms)`);
    const doneAt = await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state===${j(settle)}`, settle, ms);
    record.settledAt = doneAt;
    // 终态必须站得住：屏幕上残留的旧状态行（含 Stop hook 执行中的状态行）不能把它拽回运行。
    // 8 秒内每 250ms 采样一次，任何一次离开终态都算失败（R4：不只看最后一眼）。
    const stayUntil = Date.now() + 8000;
    while (Date.now() < stayUntil) {
      const after = await status(sid);
      assert.equal(after.truth, settle, `state stayed ${settle} for 8s after settling (got ${after.truth} after ${Date.now() - doneAt}ms, source ${JSON.stringify(after.detail)})`);
      await sleep(250);
    }
  }

  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), windowMode: 'hidden', label: 'pty matrix',
      extraEnv: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await c.send('Page.bringToFront');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions!=="undefined" && typeof getSessionRuntimeTruth==="function"', 'renderer');
    // 时间线探针：每 150ms 记录一次，只在变化时落一行。
    await c.eval(`(()=>{window.__ptyLog={};window.__hookEvents=[];
      ipcRenderer.on('hook-event',(_e,p)=>window.__hookEvents.push({at:Date.now(),sid:p.sessionId,event:p.event,provider:p.provider||'claude',tool:p.toolName||null}));
      setInterval(()=>{for(const [id,s] of sessions){if(!window.__ptyLog[id])continue;const t=getSessionRuntimeTruth(s);
        const d=deriveSessionRuntimeStatus(s,{isRunning:isSessionCardWorking(s)});const row=[t.state,d.state,s.unreadCount||0,s.attentionState||''];
        const log=window.__ptyLog[id];const last=log[log.length-1];if(!last||last.s.join()!==row.join())log.push({at:Date.now(),s:row,src:t.source||''});}},150);})()`);
    const shell = await c.eval(`ipcRenderer.invoke('create-session',{kind:'powershell',opts:{cwd:${j(cwd)}}})`);

    if (want('claude')) {
      const cs = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd, model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'none', fastMode: false, permissionMode: 'bypassPermissions' } })})`);
      const sid = cs.id; result.claudeSession = sid;
      await until(`!!sessions.get(${j(sid)})`, 'claude session');
      await open(sid);
      await view('pty');
      // Claude TUI 起来 = 输入框就绪（❯ 提示符）。
      await until(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return false;const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++){s+=b.getLine(i)?.translateToString(true)+'\\n';}return /❯|>\\s*$/m.test(s) && /claude|Claude/i.test(s);})()`, 'claude tui ready', 90000);
      await sleep(1500);
      result.claudeStartupPrompt = await dismissClaudeStartupPrompt(sid);
      await snap('claude-tui');
      const initial = await status(sid);
      assert.equal(initial.agentRuntime, 'pty'); assert.equal(initial.backend, null);
      assert.match(String(initial.cc || ''), /^[0-9a-f-]{36}$/, 'Claude identity fixed before the first prompt');
      result.checks = ['Claude PTY session identity fixed at launch: ' + initial.cc];

      await scenario('claude-reply', sid, async r => {
        const at = await send('只回复 PTY_OK_1，不要调用任何工具。');
        await expectRunsThenSettles(r, sid, at);
        const st = await status(sid);
        assert.ok(st.transcript && st.transcript.includes(st.cc), 'transcript bound by the launch identity');
        await view('card');
        await until(`document.querySelector('#msg-overlay').innerText.includes('PTY_OK_1')`, 'card shows answer', 20000);
        const turns = (await cards(sid)).turns; r.cards = turns;
        const last = turns.filter(t => t.role === 'assistant').at(-1);
        assert.equal(last.outcome, 'completed'); assert.ok(last.phases.includes('final_answer'));
        await snap('claude-reply-card');
        await view('pty');
      });

      await scenario('claude-unread', sid, async r => {
        const at = await send('只回复 PTY_OK_2，不要调用任何工具。');
        await open(shell.id);
        await expectRunsThenSettles(r, sid, at);
        await sleep(3000);
        const st = await status(sid); r.unread = st.unread;
        assert.equal(st.unread, 1, 'exactly one unread for one background completion');
        await open(sid);
        assert.equal((await status(sid)).unread, 0, 'opening clears unread');
        await view('pty');
      });

      await scenario('claude-multi-tool', sid, async r => {
        const at = await send('用 Bash 工具分两次调用，依次运行 `echo ALPHA` 和 `echo BETA`，然后只回复 TOOLS_DONE。');
        await expectRunsThenSettles(r, sid, at);
        const turns = (await cards(sid)).turns; r.cards = turns;
        const last = turns.filter(t => t.role === 'assistant').at(-1);
        assert.ok(last.tools.length >= 2, 'tool rows present'); assert.ok(last.tools.every(t => t.status === 'completed'), 'tool rows completed');
        assert.ok(/TOOLS_DONE/.test(last.text));
        await view('card'); await sleep(800); await snap('claude-tools-card'); await view('pty');
      });

      await scenario('claude-question', sid, async r => {
        const at = await send('请调用 AskUserQuestion 工具问我一个单选问题：“选哪个颜色？”，选项只有“红”和“蓝”。拿到我的回答后，只回复 COLOR=<我的选择>。');
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='waiting'`, 'waiting', 90000);
        r.waitLatencyMs = Date.now() - at;
        await view('card'); await sleep(600);
        assert.equal(await c.eval(`!!document.querySelector('.pty-attention-controls:not([hidden])')`), true, 'attention strip visible in cards');
        r.attentionText = await c.eval(`document.querySelector('.pty-attention-controls .pty-attention-detail')?.textContent||''`);
        await snap('claude-question-card');
        await c.eval(`document.querySelector('.pty-attention-controls button').click()`);
        await sleep(800); await snap('claude-question-terminal');
        await key(sid, '\r');
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed'`, 'completed after answer', 90000);
        const last = (await cards(sid)).turns.filter(t => t.role === 'assistant').at(-1); r.answer = last.text;
        assert.match(last.text, /COLOR=/);
      });

      await scenario('claude-interrupt', sid, async r => {
        const at = await send('用 Bash 工具在前台运行 `powershell -NoProfile -Command Start-Sleep 60`（不要后台运行），结束后回复 SLEPT。');
        await until(`(window.__hookEvents||[]).some(e=>e.sid===${j(sid)}&&e.event==='tool-start'&&e.at>${at})`, 'tool started', 60000);
        await sleep(2500);
        // Claude 可能先要授权这条命令：这就是「权限确认」场景，必须显示等待而不是运行或完成。
        const first = await status(sid);
        if (first.truth === 'waiting') {
          r.permission = { detail: first.detail };
          assert.match(first.detail, /Bash/, 'waiting names the tool being approved');
          await key(sid, '\r');
          await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='running'`, 'running after approval', 20000);
          await sleep(2500);
        }
        assert.ok(isRunningState((await status(sid)).truth), 'running while the tool runs');
        const escAt = Date.now(); await key(sid, '\x1b');
        const leftAt = await until(`!['running','starting'].includes(getSessionRuntimeTruth(sessions.get(${j(sid)})).state)`, 'left running after Esc', 20000);
        r.interruptLatencyMs = leftAt - escAt;
        await sleep(5000);
        const st = await status(sid); r.after = st;
        assert.ok(!isRunningState(st.truth), 'not stuck running after interrupt');
      });

      await scenario('claude-background', sid, async r => {
        const at = await send('用 Bash 工具以 run_in_background=true 启动命令 `powershell -NoProfile -Command "Start-Sleep 15; echo BG_READY"`，启动后立刻只回复 BG_STARTED；等后台任务完成的通知到达后，再只回复 BG_FINAL。');
        await until(`document.querySelector('#msg-overlay')&&true`, 'x', 1000).catch(() => {});
        await until(`(window.__hookEvents||[]).some(e=>e.sid===${j(sid)}&&e.event==='stop'&&e.at>${at})`, 'first stop', 120000).catch(() => {});
        const mid = await status(sid); r.afterFirstStop = mid;
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed' && document.querySelector('#msg-overlay').innerText.includes('BG_FINAL')`, 'bg final', 180000)
          .catch(async error => { await view('card'); await until(`document.querySelector('#msg-overlay').innerText.includes('BG_FINAL')`, 'bg final card', 60000); });
        const last = (await cards(sid)).turns.filter(t => t.role === 'assistant').at(-1); r.last = last;
        assert.match(last.text, /BG_FINAL/);
        await view('pty');
      });

      if (!SKIP_LONG) await scenario('claude-long', sid, async r => {
        const at = await send(`用 Bash 工具在前台运行 \`powershell -NoProfile -Command Start-Sleep ${LONG_SECONDS}\`，完成后只回复 LONG_DONE。`);
        await until(`(window.__hookEvents||[]).some(e=>e.sid===${j(sid)}&&e.event==='tool-start'&&e.at>${at})`, 'long tool start', 60000);
        const falseDone = [];
        const end = Date.now() + (LONG_SECONDS - 10) * 1000;
        while (Date.now() < end) { const st = await status(sid); if (!isRunningState(st.truth)) falseDone.push({ at: Date.now(), st }); await sleep(2000); }
        r.falseDone = falseDone.slice(0, 5);
        assert.equal(falseDone.length, 0, 'never left running during the long tool');
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed'`, 'long done', 120000);
      });

      await scenario('claude-compact', sid, async r => {
        const sentAt = await send('/compact');
        await sleep(3000);
        await until(`!['running','starting'].includes(getSessionRuntimeTruth(sessions.get(${j(sid)})).state)`, 'compact settles', 180000);
        await sleep(3000);
        r.after = await status(sid);
        assert.ok(!isRunningState(r.after.truth), 'not stuck running after /compact');
        // 提交闭环最长要等 9s + 6s 才会判「未确认」；看满这个窗口，别在它出结果之前就下结论。
        await sleep(Math.max(0, sentAt + 20000 - Date.now()));
        assert.equal(await c.eval('document.querySelectorAll(".fi-stuck").length'), 0, 'no stuck submit indicator after the full acknowledgement window');
      });

      // /clear 换原生身份：Hub 必须跟随（SessionEnd(旧, clear) → SessionStart(新, clear)），
      // 新问答进卡片；关闭再打开仍停在新身份上。返工 R2。
      await scenario('claude-clear', sid, async r => {
        r.before = await status(sid);
        await send('/clear');
        await until(`(sessions.get(${j(sid)})?.ccSessionId||'')!==${j(r.before.cc)}`, 'Hub follows the new identity after /clear', 30000);
        r.afterClear = await status(sid);
        assert.match(String(r.afterClear.cc || ''), /^[0-9a-f-]{36}$/);
        await sleep(2000);
        assert.equal(await c.eval('document.querySelectorAll(".fi-stuck").length'), 0, '/clear is acknowledged by the identity switch, no resend offered');
        assert.ok(!isRunningState((await status(sid)).truth), '/clear does not leave the session running');
        assert.ok(String(r.afterClear.transcript || '').includes(r.afterClear.cc), 'transcript path follows the new identity');
        await sleep(1500);
        const at = await send('不要调用任何工具，只回复 AFTER_CLEAR_OK。');
        await expectRunsThenSettles(r, sid, at);
        // 真值来自 CLI 自己写的新 JSONL，而不是 Hub 的状态。
        const onDisk = fs.readFileSync(r.afterClear.transcript, 'utf8');
        assert.ok(onDisk.includes('AFTER_CLEAR_OK'), 'the new transcript holds the answer');
        assert.ok(!fs.readFileSync(r.before.transcript, 'utf8').includes('AFTER_CLEAR_OK'), 'old transcript untouched by the new turn');
        await view('card');
        await until(`document.querySelector('#msg-overlay').innerText.includes('AFTER_CLEAR_OK')`, 'card shows the post-clear answer', 20000);
        const turns = (await cards(sid)).turns; r.cards = turns;
        const last = turns.filter(t => t.role === 'assistant').at(-1);
        assert.match(last.text, /AFTER_CLEAR_OK/); assert.equal(last.outcome, 'completed');
        await snap('claude-clear-card');
        await view('pty');
        await snap('claude-clear-terminal');
        // 关闭再打开：从持久化记录恢复，必须 --resume 新身份。
        await c.eval(`document.querySelector('.btn-close-session')?.click()`);
        await until(`sessions.get(${j(sid)})?.status==='dormant'`, 'closed', 30000);
        await open(sid);
        await until(`sessions.get(${j(sid)})?.status!=='dormant'`, 'reopened', 60000);
        await until(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return false;const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++){s+=b.getLine(i)?.translateToString(true)+'\\n';}return /❯/.test(s);})()`, 'claude tui back', 90000);
        await dismissClaudeStartupPrompt(sid);
        r.reopened = await status(sid);
        assert.equal(r.reopened.cc, r.afterClear.cc, 'reopen resumes the post-clear identity');
        await view('card');
        await until(`document.querySelector('#msg-overlay').innerText.includes('AFTER_CLEAR_OK')`, 'card after reopen', 30000);
        await snap('claude-clear-reopened-card');
        await view('pty');
      });
      // 权限确认：默认权限模式的新会话，命令要授权 → 显示等待并点名工具 → 在终端批准 → 回到运行 → 完成。
      await scenario('claude-permission', 'perm', async r => {
        const ps = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd, model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'none', fastMode: false, permissionMode: 'default' } })})`);
        const psid = ps.id; r.sid = psid;
        await (async () => { await c.eval(`(window.__ptyLog||(window.__ptyLog={}))[${j(psid)}]=[]`); })();
        await open(psid); await view('pty');
        await until(`(()=>{const t=terminalCache.get(${j(psid)})?.terminal;if(!t)return false;const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++){s+=b.getLine(i)?.translateToString(true)+'\\n';}return /❯/.test(s);})()`, 'perm tui ready', 90000);
        await sleep(1500);
        r.startupPrompt = await dismissClaudeStartupPrompt(psid);
        const at = await send('用 Bash 工具运行 `powershell -NoProfile -Command "Start-Sleep 5; echo PERM_OK"`，然后只回复 PERM_DONE。');
        await until(`getSessionRuntimeTruth(sessions.get(${j(psid)})).state==='waiting'`, 'waiting for permission', 90000);
        r.waitLatencyMs = Date.now() - at;
        const st = await status(psid); r.waiting = st;
        assert.match(st.detail, /Bash/, 'waiting names the tool');
        await view('card'); await sleep(600); await snap('claude-permission-card');
        r.attentionText = await c.eval(`document.querySelector('.pty-attention-controls .pty-attention-detail')?.textContent||''`);
        await view('pty'); await sleep(400);
        const approvedAt = Date.now(); await key(psid, String.fromCharCode(13));
        const runAt = await until(`getSessionRuntimeTruth(sessions.get(${j(psid)})).state==='running'`, 'running after approval', 20000);
        r.resumeLatencyMs = runAt - approvedAt;
        // R4：授权后立刻切走，不靠用户点回来收尾；默认权限模式的底栏是 manual mode。
        await open(shell.id);
        const doneAt = await until(`getSessionRuntimeTruth(sessions.get(${j(psid)})).state==='completed'`, 'completed after approval', 120000);
        r.completedAfterApprovalMs = doneAt - approvedAt;
        const stableUntil = Date.now() + 60000;
        while (Date.now() < stableUntil) {
          const st = await status(psid);
          assert.equal(st.truth, 'completed', `stays completed 60s after finishing while unfocused (got ${st.truth} after ${Date.now() - doneAt}ms: ${st.detail})`);
          await sleep(1000);
        }
        const settled = await status(psid);
        assert.equal(settled.unread, 1, 'exactly one unread for the unfocused completion');
        r.settled = settled;
        r.timeline = await timeline(psid);
      });
      await snap('claude-final');
    }

    if (want('codex')) {
      const xs = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'codex', opts: { cwd, model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' } })})`);
      const sid = xs.id; result.codexSession = sid;
      await until(`!!sessions.get(${j(sid)})`, 'codex session');
      await open(sid); await view('pty');
      await until(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return false;const b=t.buffer.active;let s='';for(let i=0;i<b.length;i++){s+=b.getLine(i)?.translateToString(true)+'\\n';}return /›|context left|Context/i.test(s);})()`, 'codex tui ready', 90000);
      await sleep(1500); await snap('codex-tui');
      const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).hooks;
      const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
      result.codexHooks = Object.keys(hooks);
      assert.ok(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'].every(k => hooks[k]?.length), 'Hub hooks deployed');
      assert.ok((config.match(/trusted_hash/g) || []).length >= 6, 'Hub hooks trusted');

      await scenario('codex-reply', sid, async r => {
        const at = await send('不要调用任何工具，只回复 CODEX_OK_1。');
        await expectRunsThenSettles(r, sid, at);
        const st = await status(sid); r.status = st;
        assert.match(String(st.codexSid || ''), /^[0-9a-f-]{36}$/, 'codexSid bound');
        assert.ok(st.transcript && st.transcript.includes(st.codexSid), 'rollout bound to the hook-reported thread');
        r.codexHookEvents = await c.eval(`(window.__hookEvents||[]).filter(e=>e.sid===${j(sid)}).map(e=>e.event)`);
        assert.ok(r.codexHookEvents.includes('prompt'), 'Codex UserPromptSubmit hook reached the Hub');
        await view('card');
        await until(`document.querySelector('#msg-overlay').innerText.includes('CODEX_OK_1')`, 'codex card', 30000);
        await snap('codex-reply-card'); await view('pty');
      });

      await scenario('codex-unread', sid, async r => {
        const at = await send('不要调用任何工具，只回复 CODEX_OK_2。');
        await open(shell.id);
        await expectRunsThenSettles(r, sid, at);
        await sleep(3000);
        const st = await status(sid); r.unread = st.unread;
        assert.equal(st.unread, 1, 'exactly one unread');
        await open(sid); await view('pty');
      });

      await scenario('codex-multi-tool', sid, async r => {
        const at = await send('分两次执行 shell 命令：先 `echo ALPHA`，再 `echo BETA`，然后只回复 TOOLS_DONE。');
        await expectRunsThenSettles(r, sid, at);
        const turns = (await cards(sid)).turns; r.cards = turns;
        const last = turns.filter(t => t.role === 'assistant').at(-1);
        assert.ok(last.tools.length >= 1, 'tool rows present'); assert.ok(/TOOLS_DONE/.test(last.text));
        r.toolEvents = await c.eval(`(window.__hookEvents||[]).filter(e=>e.sid===${j(sid)}&&e.at>${at}).map(e=>e.event+':'+(e.tool||''))`);
        await view('card'); await sleep(800); await snap('codex-tools-card'); await view('pty');
      });

      await scenario('codex-interrupt', sid, async r => {
        const at = await send('执行 shell 命令 `powershell -NoProfile -Command Start-Sleep 60`（前台等待它结束），然后回复 SLEPT。');
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='running'`, 'running', 30000);
        await sleep(8000);
        const escAt = Date.now(); await key(sid, '\x1b');
        const leftAt = await until(`!['running','starting'].includes(getSessionRuntimeTruth(sessions.get(${j(sid)})).state)`, 'left running after Esc', 20000);
        r.interruptLatencyMs = leftAt - escAt;
        await sleep(5000); r.after = await status(sid);
        assert.ok(!isRunningState(r.after.truth), 'not stuck running');
      });

      if (!SKIP_LONG) await scenario('codex-long', sid, async r => {
        const at = await send(`执行 shell 命令 \`powershell -NoProfile -Command Start-Sleep ${LONG_SECONDS}\`（前台等待它结束），完成后只回复 LONG_DONE。`);
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='running'`, 'running', 30000);
        await sleep(15000);
        const falseDone = [];
        const end = Date.now() + (LONG_SECONDS - 25) * 1000;
        while (Date.now() < end) { const st = await status(sid); if (!isRunningState(st.truth)) falseDone.push({ at: Date.now(), st }); await sleep(2000); }
        r.falseDone = falseDone.slice(0, 5);
        assert.equal(falseDone.length, 0, 'never left running during the long command');
        await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed'`, 'long done', 180000);
      });

      await scenario('codex-compact', sid, async r => {
        await send('/compact');
        await sleep(3000);
        await until(`!['running','starting'].includes(getSessionRuntimeTruth(sessions.get(${j(sid)})).state)`, 'compact settles', 180000);
        await sleep(3000); r.after = await status(sid);
        assert.ok(!isRunningState(r.after.truth));
      });

      // 串线：同 cwd 同时起两个 Codex，各自的卡片只能是自己的回答。
      await scenario('codex-no-crosswire', sid, async r => {
        const make = () => c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'codex', opts: { cwd, model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' } })})`);
        const [a, b] = [await make(), await make()];
        for (const s of [a, b]) {
          await open(s.id); await view('pty');
          await until(`(()=>{const t=terminalCache.get(${j(s.id)})?.terminal;if(!t)return false;const b=t.buffer.active;let x='';for(let i=0;i<b.length;i++){x+=b.getLine(i)?.translateToString(true)+'\\n';}return /›|context left|Context/i.test(x);})()`, 'codex ready', 90000);
        }
        await open(a.id); await send('不要调用工具，只回复 TWIN_A。');
        await open(b.id); await send('不要调用工具，只回复 TWIN_B。');
        for (const [s, word] of [[a, 'TWIN_A'], [b, 'TWIN_B']]) {
          await until(`getSessionRuntimeTruth(sessions.get(${j(s.id)})).state==='completed'`, word + ' done', 120000);
          const turns = (await cards(s.id)).turns;
          const text = turns.map(t => t.text).join(' ');
          r[word] = { codexSid: (await status(s.id)).codexSid, text: text.slice(0, 200) };
          assert.ok(text.includes(word), word + ' in its own card');
          assert.ok(!text.includes(word === 'TWIN_A' ? 'TWIN_B' : 'TWIN_A'), 'no crosswire');
        }
        assert.notEqual(r.TWIN_A.codexSid, r.TWIN_B.codexSid);
      });
      await snap('codex-final');
    }
    // 群聊：Claude + Codex 两个 PTY 成员，经 PTY 提交闭环派发、各自回答，状态回到空闲。
    if (want('group')) await scenario('group-chat', 'group', async r => {
      await c.eval(`window.__mt=null;ipcRenderer.invoke('create-meeting',${j({ title: 'PTY 群聊', scene: 'general', workspace: cwd,
        // PTY_GROUP_CODEX_ONLY=1：Claude 额度紧张时用两个 Codex 成员验证同一条派发链路。
        slots: [process.env.PTY_GROUP_CODEX_ONLY === '1'
          ? { kind: 'codex', model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' }
          : { kind: 'claude', model: CLAUDE_MODEL, effort: 'low', mcpProfile: 'none' },
          { kind: 'codex', model: CODEX_MODEL, effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' }] })}).then(m=>{window.__mt=m;},e=>{window.__mt={error:String(e)};});true`);
      await until('!!window.__mt', 'meeting created', 120000);
      const group = await c.eval('window.__mt');
      assert.ok(!group.error, group.error);
      r.meetingId = group.id; r.members = group.subSessions;
      for (const id of group.subSessions) await until(`sessions.get(${j(id)})?.agentRuntime==='pty'`, 'member pty ' + id, 30000);
      // groupchat:turn 要等整轮派发结束才返回，超过 CDP 单次求值上限：先发起、再轮询。
      await c.eval(`window.__gt=null;ipcRenderer.invoke('groupchat:turn',${j({ meetingId: group.id, userInput: '请每位成员只回复自己的名字加 GROUP_OK，不要调用任何工具。' })}).then(t=>{window.__gt=t;},e=>{window.__gt={error:String(e)};});true`);
      await until(`ipcRenderer.invoke('groupchat:get-state',{meetingId:${j(group.id)}}).then(s=>s&&s.currentMode==='idle'&&(s.messages||[]).filter(m=>m.role==='assistant'&&/GROUP_OK/.test(m.content||'')).length>=2)`,
        'both members answered', 300000).catch(async error => {
        r.debug = await c.eval(`ipcRenderer.invoke('groupchat:get-state',{meetingId:${j(group.id)}}).then(s=>({mode:s&&s.currentMode,messages:(s&&s.messages||[]).map(m=>({role:m.role,speaker:m.speaker||m.memberId||null,status:m.status||null,text:String(m.content||'').slice(0,120)}))}))`);
        r.debug.turn = await c.eval('window.__gt');
        r.debug.members = [];
        for (const id of group.subSessions) r.debug.members.push({ id, ...(await status(id)), screen: (await screenText(id)).trim().slice(-600) });
        throw error;
      });
      r.turn = await c.eval('window.__gt');
      const state = await c.eval(`ipcRenderer.invoke('groupchat:get-state',{meetingId:${j(group.id)}})`);
      r.answers = (state.messages || []).filter(m => m.role === 'assistant').map(m => ({ speaker: m.speaker || m.memberId, text: String(m.content || '').slice(0, 80), status: m.status }));
      // 只看群聊成员自己的输入框：别的会话遗留的提示不算。
      for (const id of group.subSessions) {
        assert.equal(await c.eval(`!!document.querySelector('.floating-input-bar[data-session-id="${id}"] .fi-stuck:not([hidden])')`), false, 'no stuck submit indicator on member');
        assert.ok(!isRunningState((await status(id)).truth), 'member settled');
      }
      await c.eval(`document.querySelector('[data-meeting-id=${j(group.id)}]')?.click()`);
      await sleep(1500); await snap('group-chat');
    });

    result.passed = result.scenarios.every(s => s.ok);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try { result.ui = await c.eval('document.body.innerText.slice(-3000)'); await snap('fatal'); } catch (e) { result.captureError = e.message; }
  } finally {
    try { if (c) result.hookEvents = await c.eval('(window.__hookEvents||[]).slice(-400)'); } catch {}
    try { if (hub) result.hubLog = hub.log().filter(line => /group-chat|prompt-submit|hook|codex-tap|claude-tap|cli-ready|transcript/i.test(line)).slice(-200); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch (e) { result.quitError = e.message; }
    for (const [file, key] of [[path.join(claudeHome, '.credentials.json'), 'claude'], [path.join(codexHome, 'auth.json'), 'codex']]) {
      try { fs.unlinkSync(file); } catch {}
      result[key + 'CredentialsUntouched'] = hash(key === 'claude' ? claudeAuth : codexAuth) === before[key];
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, out, error: result.error,
      scenarios: result.scenarios.map(s => ({ name: s.name, ok: s.ok, run: s.runLatencyMs, error: s.error && s.error.split('\n')[0] })) }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
