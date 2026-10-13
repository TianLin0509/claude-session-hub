'use strict';
// 卡片「发送内容」面板 · 真实 AI 端到端（2026-10-13）：隔离 Hub + 真实 PTY，Claude 用 Haiku、Codex 用最便宜的 mini。
//   1. Claude：通用规则在启动时写进系统提示；卡片只显示问题；点用户卡片上的「发送内容」，
//      面板「系统提示」组里能展开看到规则原文，「这条消息」组里是问题本身。
//   2. Codex：通用规则随第一条消息送，原生记录里规则块在问题**前面**；卡片仍只显示问题，
//      按钮标「+1」，面板「这条消息」组里能展开看到规则块。
// 凭据复制进临时目录，测试结束删除；用户真实的 ~/.claude、~/.codex、Hub 数据目录都不碰。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
const QUESTION = '不要调用工具。我们团队的内部周报，要不要从每周五改成每两周一次？请简短回答。';
const CODEX_MODEL = process.env.REAL_CODEX_MODEL || 'gpt-6-luna';

function findFiles(dir, test, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, test, out); else if (test(p)) out.push(p);
  }
  return out;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-compose-live-'));
  const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), cwd = path.join(root, 'work'), data = path.join(root, 'data');
  const out = path.resolve(process.env.E2E_OUT || path.join('output', 'prompt-composition-live'));
  for (const dir of [claudeHome, codexHome, cwd, data, out]) fs.mkdirSync(dir, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const codexSource = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const report = { passed: false, checks: [], boundary: '真实隔离 Hub、真实 Claude/Codex PTY、真实模型回复；规则为 Hub 内置第一版' };
  let hub, client;
  const until = async (expression, label, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await client.eval(`Boolean(${expression})`)) return; await _waitMs(250); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const p = await client.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await _waitMs(300);
  };
  const capture = async name => {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const check = (ok, label) => { assert(ok, label); report.checks.push(label); console.log('  ✓ ' + label); };
  const ask = async () => {
    await click('.floating-input-box');
    await client.send('Input.insertText', { text: QUESTION });
    await click('.floating-input-send');
    await until(`(()=>{const c=[...document.querySelectorAll('#msg-overlay .turn-card.assistant')];return c.some(e=>e.innerText.trim().length>20);})()`, 'real reply', 180000);
    await until(`!!document.querySelector('#msg-overlay .turn-card.user .turn-compose-btn')`, 'user card with button', 30000);
    await _waitMs(5000); // 等回复写完、卡片和原生记录对上
  };
  const userCard = () => client.eval(`(()=>{const c=[...document.querySelectorAll('#msg-overlay .turn-card.user')].pop();return c&&{text:c.querySelector('.turn-body').innerText.trim(),button:c.querySelector('.turn-compose-btn')?.innerText.trim(),long:!!c.querySelector('.conversation-long-message'),fold:!!c.querySelector('.conversation-memory-context')};})()`);
  const openPanel = async () => {
    await client.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.user')].pop().querySelector('.turn-compose-btn').setAttribute('data-e2e-target','1')`);
    await click('[data-e2e-target="1"]');
    await until(`document.querySelector('.prompt-composition-dialog .pc-group')`, 'composition panel', 15000);
    return client.eval(`[...document.querySelectorAll('.prompt-composition-dialog .pc-group')].map(g=>({group:g.dataset.group,parts:[...g.querySelectorAll('.pc-part')].map(p=>({id:p.dataset.partId,title:p.querySelector('.pc-title').innerText,size:p.querySelector('.pc-size').innerText}))}))`);
  };
  const expand = async partSelector => {
    await click(`.prompt-composition-dialog .pc-part[data-part-id^=${j(partSelector)}] > summary`);
    return client.eval(`document.querySelector('.prompt-composition-dialog .pc-part[data-part-id^=${j(partSelector)}]')?.querySelector('pre')?.innerText||''`);
  };
  const closePanel = async () => { await click('.prompt-composition-dialog .card-detail-dialog-head button'); await until(`!document.querySelector('.prompt-composition-dialog')`, 'panel closed', 5000); };
  try {
    fs.copyFileSync(claudeAuth, path.join(claudeHome, '.credentials.json'));
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'light', skipDangerousModePermissionPrompt: true,
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
    const hooks = require('../core/claude-hook-integration').ensureClaudeHookIntegration({
      claudeDir: claudeHome, sourceScriptsDir: path.resolve(__dirname, '../scripts'), logger: { log() {}, warn() {} } });
    assert.deepEqual(hooks.errors, [], 'isolated Claude lifecycle hooks installed');
    fs.copyFileSync(path.join(codexSource, 'auth.json'), path.join(codexHome, 'auth.json'));
    if (fs.existsSync(path.join(codexSource, 'models_cache.json'))) fs.copyFileSync(path.join(codexSource, 'models_cache.json'), path.join(codexHome, 'models_cache.json'));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = ${j(CODEX_MODEL)}\nmodel_reasoning_effort = "low"\n\n[projects.${j(cwd)}]\ntrust_level = "trusted"\n`);
    fs.writeFileSync(path.join(data, 'config.json'), j({ runtime: { agent: 'pty' } }));
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'prompt composition live', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome,
      AI_HUB_WORKSPACE_ROOT: root, AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/' } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__hubE2E', 'renderer ready');

    // 1. Claude：规则在系统提示里（E2E_ONLY=codex 时跳过，省一次真实调用）
    if (process.env.E2E_ONLY !== 'codex') {
    const cs =await client.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: {
      cwd, model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', permissionMode: 'default', autonomous: false } })})`);
    const csid = cs.id;
    await until(`activeSessionId===${j(csid)}`, 'claude active');
    const claudeReady = `(()=>{const t=window.__hubE2E.terminalBufferText(${j(csid)});return t.includes('❯') && /Haiku|shortcuts|manual mode on/.test(t) && !t.includes('Esc to keep browser tools off');})()`;
    const consent = `window.__hubE2E.terminalBufferText(${j(csid)}).includes('Esc to keep browser tools off')`;
    await until(`(${claudeReady}) || (${consent})`, 'Claude startup', 120000);
    if (await client.eval(consent)) { await _waitMs(500); await client.eval(`ipcRenderer.send('terminal-input',${j({ sessionId: csid, data: '\x1b' })})`); await until(claudeReady, 'Claude ready', 60000); }
    await _waitMs(1500);
    await ask();
    const cCard = await userCard();
    report.claudeCard = cCard;
    check(cCard.text === QUESTION && !cCard.long && !cCard.fold, 'Claude 用户卡片只显示问题本身，没有规则、没有长消息折叠');
    const cGroups = await openPanel();
    report.claudePanel = cGroups;
    check(cGroups.map(g => g.group).join() === 'system,startup,message', '面板按 系统提示 → 规则与记忆 → 这条消息 三组展示');
    check(cGroups[0].parts.some(p => p.id === 'hub-rules-system' && /通用规则 v1/.test(p.title)), '系统提示组里列出「Hub 规则（通用规则 v1）」');
    const sysText = await expand('hub-rules-system');
    check(/AI Hub 默认带上的规则/.test(sysText) && sysText.length > 200, '展开后能看到写进系统提示的规则原文');
    check(cGroups[2].parts.length === 1 && cGroups[2].parts[0].id === 'user', 'Claude 这条消息里只有用户正文，规则没有再随消息送');
    const userText = await expand('user');
    check(userText.trim() === QUESTION, '「你输入的内容」展开后就是问题原文');
    await capture('01-claude-panel');
    await closePanel();
    }

    // 2. Codex：规则随第一条消息、放在问题前面
    const xs = await client.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'codex', opts: { cwd, model: CODEX_MODEL, effort: 'low', mcpProfile: 'none' } })})`);
    const xsid = xs.id;
    await until(`activeSessionId===${j(xsid)}`, 'codex active');
    // Codex 可能走真实 PTY，也可能走原生后端（无终端输出），两种就绪信号都认。
    await until(`(()=>{const s=sessions.get(${j(xsid)});const t=window.__hubE2E.terminalBufferText(${j(xsid)})||'';return ['idle','completed'].includes(s?.nativeRuntime?.state) || (t.includes('›') && /OpenAI Codex|gpt-|Context|left/.test(t));})()`, 'Codex ready', 120000);
    report.codexBackend = await client.eval(`sessions.get(${j(xsid)})?.runtimeBackend || 'pty'`);
    await _waitMs(1500);
    await ask();
    const rollouts = findFiles(path.join(codexHome, 'sessions'), p => p.endsWith('.jsonl'));
    const raw = rollouts.map(p => fs.readFileSync(p, 'utf8')).join('\n');
    const at = { rules: raw.indexOf('<ai-hub-rules'), question: raw.indexOf(QUESTION.slice(0, 12)) };
    report.codexRawPositions = at;
    check(at.rules >= 0 && at.question > at.rules, 'Codex 原生记录里规则块在问题前面');
    const xCard = await userCard();
    report.codexCard = xCard;
    check(xCard.text === QUESTION && !xCard.long && !xCard.fold, 'Codex 用户卡片只显示问题本身');
    check(/发送内容\s*\+1/.test(xCard.button), '按钮标出这条消息附带了 1 块 Hub 资料');
    const userCards = await client.eval(`document.querySelectorAll('#msg-overlay .turn-card.user').length`);
    check(userCards === 1, `Codex 只有一张用户卡片（实际 ${userCards} 张）`);
    await until(`!/^Codex \\d+$/.test(sessions.get(${j(xsid)})?.title||'')`, 'codex auto title', 30000);
    const title = await client.eval(`sessions.get(${j(xsid)}).title`);
    report.codexTitle = title;
    check(!/ai-hub|规则/.test(title) && title.includes('周报'), `会话标题取自问题本身：${title}`);
    const xGroups = await openPanel();
    report.codexPanel = xGroups;
    check(!xGroups[0].parts.some(p => p.id === 'hub-rules-system'), 'Codex 的系统提示组里没有 Hub 规则');
    check(xGroups[2].parts.map(p => p.id.split(':')[0]).join() === 'attached,user', 'Codex 这条消息 = 附带的 Hub 规则 + 用户正文，规则在前');
    const attachedText = await expand('attached:rules');
    check(/AI Hub 默认带上的规则/.test(attachedText) && /通用规则 v1/.test(xGroups[2].parts[0].title), '展开附带块能看到随消息送出的规则原文');
    await capture('02-codex-panel');
    await closePanel();
    await capture('03-codex-card');
    report.passed = true;
    console.log(`发送内容面板真实 AI e2e：${report.checks.length} 项通过`);
  } catch (error) {
    report.error = error.stack; process.exitCode = 1; console.error(error);
    if (client) { try {
      report.screen = await client.eval('document.body.innerText.slice(-2500)');
      report.sessions = await client.eval(`[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.status,backend:s.runtimeBackend,native:s.nativeRuntime&&{state:s.nativeRuntime.state,connection:s.nativeRuntime.connection},tail:(window.__hubE2E.terminalBufferText(s.id)||'').slice(-600)}))`);
      await capture('failure');
    } catch (_) {} }
  } finally {
    try { client?.close?.(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(e => { console.error(e); process.exitCode = 1; });
    for (const f of [path.join(claudeHome, '.credentials.json'), path.join(codexHome, 'auth.json')]) { try { fs.rmSync(f, { force: true }); } catch (_) {} }
    fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 2));
  }
}
main();
