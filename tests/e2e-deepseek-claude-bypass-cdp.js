'use strict';
// 真机验收（2026-10-13）：DeepSeek 会话（Claude Code 外壳）必须以 bypassPermissions 启动。
// 起因：~/.claude-deepseek 不继承主 Claude 的 permissions.defaultMode，旧版不带 --permission-mode，
// Claude Code 2.1.296 落进 auto 模式，群聊成员停在 auto mode 计费公告上。
// 这里故意让隔离配置目录和出事时的生产一样：只有无效的顶层 permissionMode、没有 permissions.defaultMode，
// 证明单靠 Hub 的启动参数就能进 bypass。
// 用户路径：新建面板选 DeepSeek（默认 Token Plan + V4.1 Flash）→ 建会话 → 发一句 → 回复卡片；再建一个只有 DeepSeek 成员的群。
// 核对：CLI 进程的启动参数、Claude Code 自己落盘的 permissionMode、屏幕上没有 auto mode 公告。只发 1 条极短消息。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), https = require('https');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const profile = require('../core/deepseek-claude-profile');

const j = JSON.stringify;
const OUT = process.env.E2E_OUT_DIR || path.join('D:/AI-Artifacts', '20261013-deepseek-bypass-e2e-claude1');
const PROD_CONFIG = path.join(os.homedir(), '.claude-session-hub', 'config.json');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function startProxy() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/(tokenplan|api)(\/.*)$/);
    if (!m) { res.writeHead(404); res.end('bad path'); return; }
    const upstream = new URL(profile.ROUTES[m[1]].baseUrl);
    const upstreamPath = upstream.pathname.replace(/\/$/, '') + m[2];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch {}
      const rec = { at: new Date().toISOString(), route: m[1], method: req.method, path: upstreamPath.replace(/\?.*$/, ''), model: body && body.model || null, status: null };
      const headers = { ...req.headers, host: upstream.host };
      delete headers['accept-encoding'];
      headers['content-length'] = raw.length;
      const up = https.request({ host: upstream.host, port: 443, method: req.method, path: upstreamPath, headers }, upRes => {
        rec.status = upRes.statusCode;
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => requests.push(rec));
      });
      up.on('error', error => { rec.status = 'error:' + error.message; requests.push(rec); try { res.writeHead(502); res.end(); } catch {} });
      up.end(raw);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

// 只读查询：找到这个会话对应的 claude.exe，取它的启动参数（按会话 id 精确匹配，不按子串终止任何进程）。
function claudeCommandLine(ccSessionId) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match '${ccSessionId}' } | ForEach-Object { $_.CommandLine }`],
  { encoding: 'utf8', windowsHide: true });
  return out.trim();
}

function transcriptModes(dsConfig, ccSessionId) {
  const found = [];
  const walk = dir => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === ccSessionId + '.jsonl') found.push(p); } };
  walk(path.join(dsConfig, 'projects'));
  const modes = new Set();
  for (const file of found) for (const m of fs.readFileSync(file, 'utf8').matchAll(/"permissionMode":"([^"]*)"/g)) modes.add(m[1]);
  return { files: found, modes: [...modes] };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const prod = JSON.parse(fs.readFileSync(PROD_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  const tpKey = prod.acp && prod.acp.apiKey;
  if (!tpKey) throw new Error('生产配置里缺 Token Plan Key，无法真机验收');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-bypass-'));
  const dataDir = path.join(root, 'data'), dsConfig = path.join(root, 'claude-deepseek'), work = path.join(root, 'work');
  for (const dir of [dataDir, dsConfig, work]) fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(configFile, j({ acp: { apiKey: tpKey } }));
  fs.writeFileSync(path.join(dsConfig, '.claude.json'), j({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    skipDangerousModePermissionPrompt: true, theme: 'dark', projects: {} }));
  ensureClaudeHookIntegration({ claudeDir: dsConfig, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });
  // 复现出事时的生产配置：顶层 permissionMode（Claude Code 不认），没有 permissions.defaultMode。
  const settingsFile = path.join(dsConfig, 'settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  settings.permissionMode = 'bypassPermissions';
  settings.skipDangerousModePermissionPrompt = true;
  if (settings.permissions) delete settings.permissions.defaultMode;
  fs.writeFileSync(settingsFile, j(settings, null, 2));

  const proxy = await startProxy();
  const report = { passed: false, root, out: OUT, checks: [], screenshots: [], sessions: {} };
  let hub, c;
  const until = async (expr, label, ms = 150000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(`Boolean(${expr})`)) return; await _waitMs(250); } throw new Error('timeout: ' + label); };
  const click = async selector => {
    const pos = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}})()`);
    if (!pos || !pos.w) throw new Error('not visible: ' + selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  };
  const choose = async (selector, value) => {
    await c.eval(`(()=>{const s=document.querySelector(${j(selector)});s.scrollIntoView({block:'nearest'});s.focus();s.value=${j(value)};s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));s.blur();})()`); };
  const snap = async name => { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); report.screenshots.push(file); };
  const check = text => { report.checks.push(text); console.log('  OK ' + text); };
  // PTY 原始输出（含 ANSI），去掉控制序列后按文字查
  const screenOf = async sid => {
    const raw = await c.eval(`ipcRenderer.invoke('get-ring-buffer',${j(sid)})`).catch(() => null);
    return String(raw || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
  };

  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'DeepSeek bypass E2E', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR: dsConfig, AI_HUB_E2E_DEEPSEEK_ROUTE_PROXY: proxy.url,
      CLAUDE_CODE_MAX_RETRIES: '0',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && document.querySelector("#btn-new-more")', 'renderer', 90000);
    await _waitMs(1500);
    const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(seeded.permissions && seeded.permissions.defaultMode, undefined, 'config dir mirrors the broken production state');
    check('隔离 DeepSeek 配置目录与出事时的生产一致：没有 permissions.defaultMode');

    // ① 单人会话：新建面板 → DeepSeek（默认 Token Plan + V4.1 Flash）
    await click('#btn-new-more');
    await until('document.querySelector("#new-session-menu")?.getBoundingClientRect().height>0', 'launch center');
    await _waitMs(400);
    await click('.new-session-option[data-kind="deepseek"]');
    await _waitMs(300);
    const panel = await c.eval(`({route:document.querySelector('#new-session-deepseek-route').value,model:document.querySelector('#new-session-model').value})`);
    assert.deepEqual(panel, { route: 'tokenplan', model: 'deepseek-v4.1-flash' });
    await click('#new-session-submit');
    await until('[...sessions.values()].some(s=>s.kind==="deepseek-claude")', 'session created');
    const sid = await c.eval('[...sessions.values()].find(s=>s.kind==="deepseek-claude").id');
    const cc = await c.eval(`sessions.get(${j(sid)}).ccSessionId`);
    await until('currentView==="card"', 'card view', 20000);
    let cmdline = '';
    for (let i = 0; i < 60 && !cmdline; i++) { await _waitMs(500); cmdline = claudeCommandLine(cc); }
    report.sessions.single = { sid, cc, cmdline };
    assert.match(cmdline, /--permission-mode bypassPermissions(?:\s|$)/, 'single session CLI launched in bypass');
    assert.match(cmdline, /--model deepseek-v4\.1-flash/);
    check('单人会话的 claude.exe 启动参数带 --permission-mode bypassPermissions');
    await _waitMs(8000);
    await snap('01-single-created');

    const sentAt = Date.now();
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: '只回复 OK 两个字母，不要调用任何工具。' });
    await _waitMs(300);
    await click('.floating-input-send');
    await until(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].some(e=>/\\bOK\\b/.test(e.innerText))`, 'reply card', 180000);
    await _waitMs(1500);
    await snap('02-single-reply');
    check('发一句「只回复 OK」→ 卡片里出现 OK');

    const modes = transcriptModes(dsConfig, cc);
    report.sessions.single.transcript = modes;
    assert.ok(modes.files.length === 1, 'transcript written by Claude Code');
    assert.deepEqual(modes.modes, ['bypassPermissions'], 'Claude Code itself recorded bypass, never auto');
    check('Claude Code 落盘的 permissionMode 只有 bypassPermissions（没有 auto）');

    const screenText = await screenOf(sid);
    report.sessions.single.screenChars = screenText.length;
    report.sessions.single.screenHasAutoNotice = /auto mode/i.test(screenText);
    report.sessions.single.screenHasBypass = /bypass permissions/i.test(screenText);
    if (screenText) {
      assert.equal(report.sessions.single.screenHasAutoNotice, false, 'no auto mode notice on the CLI screen');
      check(`CLI 屏幕没有 auto mode 公告${report.sessions.single.screenHasBypass ? '，状态栏显示 bypass permissions' : ''}`);
    }
    const reqs = proxy.requests.filter(r => r.method === 'POST' && /\/v1\/messages/.test(r.path) && Date.parse(r.at) >= sentAt - 2000);
    report.requests = { count: reqs.length, models: [...new Set(reqs.map(r => r.model))], statuses: [...new Set(reqs.map(r => r.status))] };
    check(`这一轮的对话请求 ${reqs.length} 条，模型 ${report.requests.models.join('/')}`);

    // ② 群聊成员：建群弹窗里只留一位 DeepSeek 成员（不发消息，零额度）
    await c.eval("openMeetingCreateModal('group')");
    await until('document.querySelectorAll(".mcm-slot").length>=1', 'group modal');
    await _waitMs(500);
    await click('.mcm-scene-choice[data-mcm-scene="general"]');
    await _waitMs(300);
    await click('[data-mcm-workspace-mode="default"]');
    await _waitMs(300);
    await choose('.mcm-slot[data-slot="0"] .mcm-ai-select', 'deepseek-claude');
    await _waitMs(300);
    while (await c.eval('document.querySelectorAll(".mcm-slot").length') > 1) {
      await click('.mcm-slot:last-child [data-remove-member]');
      await _waitMs(300);
    }
    await c.eval(`(()=>{const i=document.querySelector('#mcm-title-input');if(i){i.value='DeepSeek bypass 验收';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await click('.mcm-create');
    await until('[...sessions.values()].some(s=>s.kind==="deepseek-claude" && s.meetingId)', 'group member created', 60000);
    const member = await c.eval('(()=>{const s=[...sessions.values()].find(x=>x.kind==="deepseek-claude" && x.meetingId);return {id:s.id,cc:s.ccSessionId,meetingId:s.meetingId}})()');
    let memberCmd = '';
    for (let i = 0; i < 60 && !memberCmd; i++) { await _waitMs(500); memberCmd = claudeCommandLine(member.cc); }
    report.sessions.member = { ...member, cmdline: memberCmd };
    assert.match(memberCmd, /--permission-mode bypassPermissions(?:\s|$)/, 'group member CLI launched in bypass');
    await _waitMs(3000);
    await snap('03-group-created');
    check('群聊 DeepSeek 成员的 claude.exe 启动参数带 --permission-mode bypassPermissions');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
    if (c) { try { report.screen = await c.eval('document.body?.innerText.slice(-2500)'); await snap('failure'); } catch {} }
  } finally {
    try { if (c) await c.close(); if (hub) await gracefulQuit(hub); } catch (error) { report.teardownError = error.message; }
    proxy.server.close();
    try { fs.writeFileSync(configFile, j({ acp: { apiKey: '' } })); } catch {}
    const text = j(report, null, 2).split(tpKey).join('[REDACTED]');
    fs.writeFileSync(path.join(OUT, '20261013-deepseek-bypass-e2e-claude1.json'), text);
    console.log(text);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
