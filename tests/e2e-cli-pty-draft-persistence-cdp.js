'use strict';
// 草稿在「原生 → PTY 迁移、PTY 关闭重开、两个 Hub 接续」三条路径上都不能丢，逐字核对。
// Claude 不调用模型（CLAUDE_PROXY 指向不可达端口，身份在启动时就已确定）。Codex 要绑定原生 ID
// 才能关闭交接，所以临时拷登录凭据跑一轮最短回答；结束后删除副本并核对原凭据 hash 未变。
// 用法：node tests/e2e-cli-pty-draft-persistence-cdp.js [--only=claude|codex]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { NativeDraftStore } = require('../core/native-draft-store');
const crypto = require('crypto');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// Codex 只有绑定了原生会话 ID 才允许关闭交接（08-08 起的休眠闸门）；为此要真实登录并跑一轮最短回答。
const CODEX_MODEL = process.env.REAL_CODEX_MODEL || 'gpt-5.6-sol';
const codexAuth = path.join(os.homedir(), '.codex', 'auth.json');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const ONLY = process.argv.slice(2).find(a => a.startsWith('--only='))?.slice(7) || null;
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-drafts-'));
  const out = path.resolve('artifacts/cli-pty-core/draft-persistence-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { out, root, providers: {}, passed: false };
  const hubs = new Set();
  const copiedCredentials = [];
  const authBefore = fs.existsSync(codexAuth) ? hash(codexAuth) : null;
  try {
    for (const provider of ['claude', 'codex']) {
      if (ONLY && ONLY !== provider) continue;
      const r = report.providers[provider] = { checks: [] };
      const dataDir = path.join(root, provider, 'data'), workspace = path.join(root, provider, 'workspace');
      const claudeDir = path.join(root, provider, 'claude'), codexHome = path.join(root, provider, 'codex');
      for (const d of [workspace, claudeDir, codexHome]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, '.claude.json'), j({ hasCompletedOnboarding: true, projects: {} }));
      if (provider === 'codex') {
        fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json')); copiedCredentials.push(path.join(codexHome, 'auth.json'));
        const cache = path.join(os.homedir(), '.codex', 'models_cache.json');
        if (fs.existsSync(cache)) fs.copyFileSync(cache, path.join(codexHome, 'models_cache.json'));
        fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = ${j(CODEX_MODEL)}
model_reasoning_effort = "low"
`);
      }
      const env = mode => ({ CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, CLAUDE_HUB_HOME_DIR: path.join(root, provider, 'home'),
        DEEPSEEK_API_KEY: '', CLAUDE_HUB_AGENT_RUNTIME: mode, ...(provider === 'claude' ? { CLAUDE_PROXY: 'http://127.0.0.1:9' } : {}) });
      const launch = async (mode, label) => {
        const hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: `drafts ${provider} ${label}`, extraEnv: env(mode) });
        hubs.add(hub);
        const c = await connectFirstPage(hub);
        const h = { hub, c, until: async (expr, what, ms = 60000) => { const end = Date.now() + ms;
          while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(200); } throw Error(`timeout: ${what} (${label})`); } };
        await h.until('typeof sessions!=="undefined"', 'renderer');
        return h;
      };
      const quit = async h => { const t0 = Date.now(); try { await gracefulQuit(h.hub, { timeoutMs: 60000 }); (report.quitMs ||= []).push(Date.now() - t0); } catch (error) { report.quitLog = error.logTail || null; throw error; } hubs.delete(h.hub); };
      let sid;
      const open = async h => {
        await h.until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row');
        await h.c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
        await h.until(`activeSessionId===${j(sid)} && sessions.get(${j(sid)})?.status!=='dormant' && !!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')`, 'composer');
      };
      const composer = h => h.c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id=${j(sid)}] .floating-input-box');return b?{text:b.innerText,state:b.dataset.draftState||null}:null;})()`);
      const settle = async (h, want) => h.until(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id=${j(sid)}] .floating-input-box');return b && b.innerText===${j(want)} && b.dataset.draftState==='saved';})()`, 'draft restored+saved: ' + want, 20000);
      const type = async (h, text) => {
        await h.c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id=${j(sid)}] .floating-input-box');b.focus();getSelection().selectAllChildren(b);})()`);
        await h.c.send('Input.insertText', { text });
        await settle(h, text);
      };
      const onDisk = () => { const db = new NativeDraftStore(dataDir); try { return db.read(sid); } finally { db.close(); } };
      const shot = async (h, name) => { const s = await h.c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${provider}-${name}.png`), Buffer.from(s.data, 'base64')); };

      // 1. 原生时代留下的草稿，改走 PTY 后原样回到输入框。
      const D1 = `DRAFT_NATIVE_${provider}_原生时代未发送\n第二行 🙂 end`;
      let h = await launch('native', 'native');
      const created = await h.c.eval(`ipcRenderer.invoke('create-session',${j({ kind: provider, opts: { cwd: workspace, mcpProfile: 'none',
        ...(provider === 'claude' ? { model: 'claude-haiku-4-5-20251001', effort: 'low', fastMode: false } : { model: CODEX_MODEL, effort: 'low', codexSpeedTier: 'inherit' }) } })})`);
      sid = created.id; r.sessionId = sid; r.createdBackend = created.runtimeBackend || null;
      await open(h);
      await type(h, D1);
      if (onDisk().text !== D1) throw Error('fixture: native draft not persisted');
      await quit(h);

      h = await launch('pty', 'pty-1');
      await open(h);
      await h.until(`sessions.get(${j(sid)})?.agentRuntime==='pty'`, 'reopened as PTY');
      await settle(h, D1);
      if (onDisk().text !== D1) throw Error('migrated draft overwritten on disk');
      await shot(h, 'migrated');
      r.checks.push('native draft is restored verbatim when the session reopens under PTY; DB unchanged');

      // 2. PTY 里改写草稿，关闭 Hub 再开，逐字回来。
      const D2 = `DRAFT_PTY_${provider}_关闭重开也在\t制表符`;
      await type(h, D2);
      await quit(h);
      if (onDisk().text !== D2) throw Error('PTY draft not persisted before quit');
      h = await launch('pty', 'pty-2');
      await open(h);
      await settle(h, D2);
      await shot(h, 'reopened');
      r.checks.push('PTY draft survives a Hub restart verbatim');

      // 3. 两个 Hub：A 关闭会话释放归属，B 打开后拿到 A 最后写下的草稿。
      if (provider === 'codex' && !(await h.c.eval(`!!sessions.get(${j(sid)})?.codexSid`))) {
        await h.until(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;let x='';if(t){const b=t.buffer.active;for(let i=0;i<b.length;i++)x+=(b.getLine(i)?.translateToString(true)||'')+String.fromCharCode(10);}return /›/.test(x);})()`, 'codex TUI ready', 120000)
          .catch(async error => {
            r.tuiDebug = await h.c.eval(`(()=>{const s=sessions.get(${j(sid)});const t=terminalCache.get(${j(sid)})?.terminal;let x='';if(t){const b=t.buffer.active;for(let i=0;i<b.length;i++)x+=(b.getLine(i)?.translateToString(true)||'')+String.fromCharCode(10);}return {cached:!!t,status:s?.status,text:x.trim().slice(-1500)};})()`);
            await shot(h, 'tui-not-ready');
            throw error;
          });
        await h.c.eval(`(()=>{const bar=document.querySelector('.floating-input-bar[data-session-id=${j(sid)}]');const b=bar.querySelector('.floating-input-box');b.textContent='只回复 OK';b.dispatchEvent(new Event('input',{bubbles:true}));bar.querySelector('.floating-input-send').click();})()`);
        await h.until(`!!sessions.get(${j(sid)})?.codexSid && getSessionRuntimeTruth(sessions.get(${j(sid)})).state==='completed'`, 'codex bound + turn completed', 180000)
          .catch(async error => { r.turnDebug = await h.c.eval(`(()=>{const s=sessions.get(${j(sid)});const t=terminalCache.get(${j(sid)})?.terminal;let x='';if(t){const b=t.buffer.active;for(let i=0;i<b.length;i++)x+=(b.getLine(i)?.translateToString(true)||'')+String.fromCharCode(10);}return {sid:s?.codexSid||null,truth:getSessionRuntimeTruth(s),text:x.trim().slice(-1500)};})()`); await shot(h, 'turn-failed'); throw error; });
        await settle(h, '');
        r.checks.push('sending a prompt clears the persisted draft (composer and DB empty)');
        if (onDisk().text !== '') throw Error('sent draft still on disk: ' + j(onDisk()));
      }
      const D3 = `DRAFT_HANDOVER_${provider}_交给另一个 Hub`;
      await type(h, D3);
      const idField = provider === 'claude' ? 'ccSessionId' : 'codexSid';
      const identityA = await h.c.eval(`sessions.get(${j(sid)})?.${idField}||null`);
      if (!identityA) throw Error('A has no native identity before handover');
      const b = await launch('pty', 'pty-b');
      await b.until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row in B');
      await h.c.eval(`document.querySelector('.btn-close-session')?.click()`);
      try { await h.until(`sessions.get(${j(sid)})?.status==='dormant'`, 'released in A', 30000); }
      catch (error) {
        r.closeDebug = await h.c.eval(`({btn:!!document.querySelector('.btn-close-session'),dialog:document.querySelector('dialog[open]')?.innerText||null,status:sessions.get(${j(sid)})?.status,active:activeSessionId})`);
        await shot(h, 'close-failed');
        throw error;
      }
      await b.c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await b.until(`sessions.get(${j(sid)})?.status!=='dormant' && sessions.get(${j(sid)})?.agentRuntime==='pty'`, 'B opens it', 60000);
      await b.until(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')`, 'composer in B');
      await settle(b, D3);
      await shot(b, 'handover');
      r.final = await composer(b);
      const identityB = await b.c.eval(`sessions.get(${j(sid)})?.${idField}||null`);
      if (identityB !== identityA) throw Error(`B opened a different native identity: ${identityA} -> ${identityB}`);
      r.identity = identityA;
      r.checks.push('after Hub A closes the session, Hub B opens it with A\'s latest draft verbatim');
      await quit(b); await quit(h);
      r.passed = true;
    }
    report.passed = Object.values(report.providers).every(p => p.passed);
  } catch (error) {
    report.error = String(error.stack || error).slice(0, 2000);
    process.exitCode = 1;
  } finally {
    for (const hub of hubs) { try { await gracefulQuit(hub, { timeoutMs: 60000 }); } catch {} }
    for (const file of copiedCredentials) { try { fs.unlinkSync(file); } catch {} }
    report.codexCredentialsUntouched = authBefore === (fs.existsSync(codexAuth) ? hash(codexAuth) : null);
    report.copiedCredentialsRemoved = copiedCredentials.every(file => !fs.existsSync(file));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, passed: report.passed, providers: Object.fromEntries(Object.entries(report.providers).map(([k, v]) => [k, v.checks])), error: report.error }, null, 2));
  }
}
main();
