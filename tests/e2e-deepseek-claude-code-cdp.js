'use strict';
// 真机验收（2026-10-11）：DeepSeek 跑在 Claude Code 上。隔离 Hub + 真实 Claude Code CLI + 真实 DeepSeek 端点，只用 Flash。
// 按用户的点选路径：
//   ① 打开新建会话面板 → 没有 ChatGPT；② 点 DeepSeek → 默认 Token Plan + V4.1 Flash → 建会话 → 发「回复 OK」→ 卡片出回复、状态回到空闲；
//   ③ 建群弹窗里选 DeepSeek 成员 → 同样默认 Token Plan + V4.1 Flash → 建出群；
//   ④ 换「DeepSeek 官方 API」再建一次会话并发消息。
// 请求经本地记账代理（只在隔离 Hub 生效，见 core/deepseek-claude-profile.js），核对每条请求打到的上游主机、Key 尾号与模型名。
// Key 从生产 Hub 配置只读复制到隔离数据目录，结束后从隔离副本里抹掉；日志里只记 Key 尾 4 位。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), https = require('https');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const profile = require('../core/deepseek-claude-profile');

const j = JSON.stringify;
const OUT = process.env.E2E_OUT_DIR || path.join('D:/AI-Artifacts', '20261011-deepseek-claudecode-claude2');
const PROD_CONFIG = path.join(os.homedir(), '.claude-session-hub', 'config.json');
const CLAUDE_NAME_RE = /claude|opus|sonnet|haiku|fable/i;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function startProxy(logFile) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/(tokenplan|api)(\/.*)$/);
    if (!m) { res.writeHead(404); res.end('bad path'); return; }
    const route = m[1];
    const upstream = new URL(profile.ROUTES[route].baseUrl);
    const upstreamPath = upstream.pathname.replace(/\/$/, '') + m[2];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch {}
      const auth = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const rec = { at: new Date().toISOString(), route, host: upstream.host, method: req.method, path: upstreamPath.replace(/\?.*$/, ''),
        model: body && body.model || null, keyTail: auth ? auth.slice(-4) : null, status: null,
        thinking: body && body.thinking !== undefined ? body.thinking : undefined,
        outputConfig: body && body.output_config !== undefined ? body.output_config : undefined };
      const headers = { ...req.headers, host: upstream.host };
      delete headers['accept-encoding'];
      headers['content-length'] = raw.length;
      const up = https.request({ host: upstream.host, port: 443, method: req.method, path: upstreamPath, headers }, upRes => {
        rec.status = upRes.statusCode;
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => { requests.push(rec); fs.appendFileSync(logFile, j(rec) + '\n'); });
      });
      up.on('error', error => { rec.status = 'error:' + error.message; requests.push(rec); fs.appendFileSync(logFile, j(rec) + '\n');
        try { res.writeHead(502); res.end(); } catch {} });
      up.end(raw);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const prod = JSON.parse(fs.readFileSync(PROD_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  const tpKey = prod.acp && prod.acp.apiKey, dsKey = prod.providers && prod.providers.deepseek && prod.providers.deepseek.api_key;
  if (!tpKey || !dsKey) throw new Error('生产配置里缺 Token Plan 或 DeepSeek Key，无法真机验收');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ds-claudecode-'));
  const dataDir = path.join(root, 'data'), dsConfig = path.join(root, 'claude-deepseek'), work = path.join(root, 'work');
  for (const dir of [dataDir, dsConfig, work]) fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(configFile, j({ acp: { apiKey: tpKey }, providers: { deepseek: { api_key: dsKey } } }));
  // 与生产 ~/.claude-deepseek 同样的状态：没有任何 Claude 登录，只有 onboarding / bypass 已确认的标记。
  fs.writeFileSync(path.join(dsConfig, '.claude.json'), j({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    skipDangerousModePermissionPrompt: true, theme: 'dark', projects: {} }));
  ensureClaudeHookIntegration({ claudeDir: dsConfig, sourceScriptsDir: path.join(__dirname, '..', 'scripts'), logger: {} });

  const proxyLog = path.join(OUT, 'proxy-requests.jsonl');
  try { fs.unlinkSync(proxyLog); } catch {}
  const proxy = await startProxy(proxyLog);
  const report = { passed: false, root, out: OUT, checks: [], screenshots: [], sessions: {} };
  let hub, c;
  const until = async (expr, label, ms = 150000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(`Boolean(${expr})`)) return; await _waitMs(250); } throw new Error('timeout: ' + label); };
  const click = async selector => {
    const pos = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}})()`);
    if (!pos || !pos.w) throw new Error('not visible: ' + selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  };
  // 原生下拉：后台窗口里点开系统弹出层不可控，这里聚焦后按用户选中某项时浏览器发出的 change 事件设置。
  const choose = async (selector, value) => {
    await c.eval(`(()=>{const s=document.querySelector(${j(selector)});s.scrollIntoView({block:'nearest'});s.focus();s.value=${j(value)};s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));s.blur();})()`); };
  const snap = async name => { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); report.screenshots.push(file); };
  const check = text => { report.checks.push(text); console.log('  OK ' + text); };

  async function openPanel() {
    await click('#btn-new-more');
    await until('document.querySelector("#new-session-menu")?.getBoundingClientRect().height>0', 'launch center');
    await _waitMs(400);
  }

  async function createAndAsk(route, label) {
    await openPanel();
    await click('.new-session-option[data-kind="deepseek"]');
    await _waitMs(300);
    if (route !== await c.eval(`document.querySelector('#new-session-deepseek-route').value`)) {
      await choose('#new-session-deepseek-route', route);
      await _waitMs(300);
    }
    const panel = await c.eval(`({route:document.querySelector('#new-session-deepseek-route').value,
      routeVisible:!document.querySelector('#new-session-deepseek-route-field').hidden,
      model:document.querySelector('#new-session-model').value,
      modelLabel:document.querySelector('#new-session-model').selectedOptions[0]?.textContent,
      effort:document.querySelector('#new-session-effort').value,
      summary:document.querySelector('#new-session-summary').innerText,
      routes:[...document.querySelectorAll('#new-session-deepseek-route option')].map(o=>({value:o.value,text:o.textContent,disabled:o.disabled})),
      submitDisabled:document.querySelector('#new-session-submit').disabled})`);
    report[label + 'Panel'] = panel;
    assert.equal(panel.routeVisible, true);
    assert.equal(panel.route, route);
    assert.equal(panel.model, 'deepseek-v4.1-flash');
    assert.equal(panel.effort, 'high');
    assert.deepEqual(panel.routes.map(r => r.value), ['tokenplan', 'api']);
    assert.equal(panel.submitDisabled, false);
    await snap(`${label}-01-panel`);
    const before = await c.eval('[...sessions.values()].filter(s=>s.kind==="deepseek-claude").map(s=>s.id)');
    await click('#new-session-submit');
    await until(`[...sessions.values()].some(s=>s.kind==="deepseek-claude" && !${j(before)}.includes(s.id))`, 'session created');
    const sid = await c.eval(`[...sessions.values()].find(s=>s.kind==="deepseek-claude" && !${j(before)}.includes(s.id)).id`);
    const info = await c.eval(`(()=>{const s=sessions.get(${j(sid)});return {kind:s.kind,route:s.deepseekRoute,model:s.currentModel,agentRuntime:s.agentRuntime,runtimeBackend:s.runtimeBackend||null,ccSessionId:s.ccSessionId,effort:s.effort}})()`);
    assert.equal(info.route, route);
    assert.equal(info.model.id, 'deepseek-v4.1-flash');
    assert.equal(info.agentRuntime, 'pty');
    assert.equal(info.runtimeBackend, null);
    await until('currentView==="card"', 'card view', 20000);
    // 等 Claude Code 起来（SessionStart hook 或屏幕出现输入框），再像用户一样在输入框打字发送。
    await _waitMs(9000);
    await snap(`${label}-02-created`);
    const sentAt = Date.now();
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: '只回复 OK 两个字母，不要调用任何工具。' });
    await _waitMs(300);
    await click('.floating-input-send');
    await until(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].some(e=>/\\bOK\\b/.test(e.innerText))`, `${label} reply card`, 180000);
    await until(`(()=>{const s=sessions.get(${j(sid)});return s && s.status!=='running' && !s._agentWorking})()`, `${label} idle status`, 60000).catch(() => {});
    const status = await c.eval(`(()=>{const s=sessions.get(${j(sid)});return {status:s.status,transcriptPath:s.transcriptPath||null,ccSessionId:s.ccSessionId,model:s.currentModel}})()`);
    const rowText = await c.eval(`document.querySelector('.session-item[data-session-id=${j(sid)}]')?.innerText || ''`);
    await snap(`${label}-03-reply`);
    const mine = proxy.requests.filter(r => r.route === route && Date.parse(r.at) >= sentAt - 2000);
    report.sessions[label] = { sid, info, status, rowText, requests: mine.length };
    return { sid, info, status, sentAt };
  }

  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'DeepSeek on Claude Code real E2E', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR: dsConfig, AI_HUB_E2E_DEEPSEEK_ROUTE_PROXY: proxy.url,
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && document.querySelector("#btn-new-more")', 'renderer', 90000);
    await _waitMs(1500);

    // ① 面板里没有 ChatGPT
    await openPanel();
    const kinds = await c.eval('[...document.querySelectorAll(".new-session-option")].filter(b=>b.getBoundingClientRect().width>0).map(b=>({kind:b.dataset.kind,text:b.innerText.trim()}))');
    report.panelKinds = kinds;
    assert.equal(kinds.some(k => k.kind === 'chatgpt' || /chatgpt/i.test(k.text)), false);
    assert.ok(kinds.some(k => k.kind === 'deepseek'));
    await snap('00-panel-no-chatgpt');
    check('新建会话面板没有 ChatGPT 入口：' + kinds.map(k => k.text).join(' / '));
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await _waitMs(400);

    // ② 默认 Token Plan + V4.1 Flash
    const tp = await createAndAsk('tokenplan', 'tokenplan');
    check(`Token Plan 会话建成并回复 OK（${tp.sid.slice(0, 8)}）`);

    // ③ 建群弹窗：DeepSeek 成员默认 Token Plan + V4.1 Flash；只留这一位成员，避免拉起真实 Claude / Codex 账号。
    await c.eval("openMeetingCreateModal('group')");
    await until('document.querySelectorAll(".mcm-slot").length>=1', 'group modal');
    await _waitMs(500);
    // 通用场景（开发场景至少两位成员）
    await click('.mcm-scene-choice[data-mcm-scene="general"]');
    await _waitMs(300);
    await choose('.mcm-slot[data-slot="0"] .mcm-ai-select', 'deepseek-claude');
    await _waitMs(300);
    while (await c.eval('document.querySelectorAll(".mcm-slot").length') > 1) {
      await click('.mcm-slot:last-child [data-remove-member]');
      await _waitMs(300);
    }
    const slot = await c.eval(`(()=>{const s=document.querySelector('.mcm-slot');return {kind:s.dataset.kind,
      route:s.querySelector('.mcm-deepseek-route')?.value,model:s.querySelector('.mcm-model-select').value,
      routes:[...s.querySelectorAll('.mcm-deepseek-route option')].map(o=>o.value),
      aiOptions:[...s.querySelectorAll('.mcm-ai-select option')].map(o=>o.value),effort:s.querySelector('.mcm-effort-select')?.value}})()`);
    report.groupSlot = slot;
    assert.deepEqual({ kind: slot.kind, route: slot.route, model: slot.model, effort: slot.effort },
      { kind: 'deepseek-claude', route: 'tokenplan', model: 'deepseek-v4.1-flash', effort: 'high' });
    assert.deepEqual(slot.routes, ['tokenplan', 'api']);
    assert.equal(slot.aiOptions.some(k => k === 'chatgpt' || k === 'deepseek' || k === 'deepseek-acp'), false);
    await c.eval(`(()=>{const i=document.querySelector('#mcm-title-input');if(i){i.value='DeepSeek Claude Code 验收';i.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await snap('group-01-modal');
    const meetingsBefore = await c.eval('Object.keys(typeof meetings!=="undefined"?meetings:{})');
    await click('.mcm-create');
    await until(`[...sessions.values()].some(s=>s.kind==="deepseek-claude" && s.meetingId)`, 'group member created', 60000);
    const member = await c.eval(`(()=>{const s=[...sessions.values()].find(x=>x.kind==="deepseek-claude" && x.meetingId);return {id:s.id,meetingId:s.meetingId,route:s.deepseekRoute,model:s.currentModel,agentRuntime:s.agentRuntime}})()`);
    report.groupMember = member;
    assert.equal(member.route, 'tokenplan');
    assert.equal(member.model.id, 'deepseek-v4.1-flash');
    assert.equal(member.agentRuntime, 'pty');
    const otherMembers = await c.eval(`[...sessions.values()].filter(s=>s.meetingId===${j(member.meetingId)} && s.kind!=='deepseek-claude').map(s=>s.kind)`);
    assert.deepEqual(otherMembers, []);
    await _waitMs(2500);
    await snap('group-02-created');
    check('建群弹窗 DeepSeek 成员默认 Token Plan + V4.1 Flash，群建成');
    report.meetingsBefore = meetingsBefore;

    // ④ 换 DeepSeek 官方 API
    const api = await createAndAsk('api', 'api');
    check(`DeepSeek 官方 API 会话建成并回复 OK（${api.sid.slice(0, 8)}）`);
    const savedRoute = JSON.parse(fs.readFileSync(configFile, 'utf8')).providers.deepseek.route;
    assert.equal(savedRoute, 'api');
    check('接入方式选择记在 Hub 配置：providers.deepseek.route = api');

    // 请求核对：每条请求的上游、Key 尾号与模型名
    const byRoute = route => proxy.requests.filter(r => r.route === route && r.method === 'POST' && /\/v1\/messages/.test(r.path));
    const tpReqs = byRoute('tokenplan'), apiReqs = byRoute('api');
    report.requestSummary = {
      tokenplan: { count: tpReqs.length, hosts: [...new Set(tpReqs.map(r => r.host))], models: [...new Set(tpReqs.map(r => r.model))],
        keyTailOk: tpReqs.every(r => r.keyTail === tpKey.slice(-4)), statuses: [...new Set(tpReqs.map(r => r.status))] },
      api: { count: apiReqs.length, hosts: [...new Set(apiReqs.map(r => r.host))], models: [...new Set(apiReqs.map(r => r.model))],
        keyTailOk: apiReqs.every(r => r.keyTail === dsKey.slice(-4)), statuses: [...new Set(apiReqs.map(r => r.status))] },
    };
    assert.ok(tpReqs.length > 0 && apiReqs.length > 0);
    assert.deepEqual(report.requestSummary.tokenplan.hosts, ['token-plan.cn-beijing.maas.aliyuncs.com']);
    assert.deepEqual(report.requestSummary.api.hosts, ['api.deepseek.com']);
    assert.deepEqual(report.requestSummary.tokenplan.models, ['deepseek-v4.1-flash']);
    assert.deepEqual(report.requestSummary.api.models, ['deepseek-flash']);
    assert.equal(report.requestSummary.tokenplan.keyTailOk && report.requestSummary.api.keyTailOk, true);
    assert.equal(proxy.requests.some(r => r.model && CLAUDE_NAME_RE.test(r.model)), false, 'no Claude model name ever left the machine');
    check(`请求核对：Token Plan ${tpReqs.length} 条 → token-plan.cn-beijing / deepseek-v4.1-flash；官方 API ${apiReqs.length} 条 → api.deepseek.com / deepseek-flash；无 Claude 模型名`);

    // transcript 里的 model 字段（Claude Code 自己落盘）
    const transcripts = [];
    const walk = dir => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) transcripts.push(p); } };
    walk(path.join(dsConfig, 'projects'));
    const transcriptModels = {};
    for (const file of transcripts) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) { let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.type === 'assistant' && r.message && r.message.model) transcriptModels[path.basename(file)] = r.message.model; }
    }
    report.transcriptModels = transcriptModels;
    assert.equal(fs.existsSync(path.join(dsConfig, '.credentials.json')), false);
    assert.deepEqual(profile.claudeLoginEvidence(dsConfig), []);
    check('隔离 DeepSeek 配置目录里没有 Claude 登录信息');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
    if (c) { try { report.screen = await c.eval('document.body?.innerText.slice(-2500)'); await snap('failure'); } catch {} }
  } finally {
    try { if (c) await c.close(); if (hub) await gracefulQuit(hub); } catch (error) { report.teardownError = error.message; }
    proxy.server.close();
    try { fs.writeFileSync(configFile, j({ acp: { apiKey: '' }, providers: { deepseek: { route: 'api' } } })); } catch {}
    const text = j(report, null, 2).split(tpKey).join('[REDACTED]').split(dsKey).join('[REDACTED]');
    fs.writeFileSync(path.join(OUT, '20261011-deepseek-claudecode-e2e-claude2.json'), text);
    console.log(text);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
