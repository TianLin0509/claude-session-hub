'use strict';
// 规则 Tab · 真实 AI 端到端（2026-10-12）：隔离 Hub + 真实 Claude PTY + Haiku。
//   1. 通用规则开着：新会话第一条消息带上规则（原生对话记录里能看到），卡片把规则折叠起来，
//      Haiku 的回复按规则以「📌」开头；规则页「送达情况」显示已送达。
//   2. 关掉通用规则后新开会话：消息不再带规则。
// 凭据复制进临时目录，测试结束删除；不读用户的全局 CLAUDE.md（CLAUDE_CONFIG_DIR 指向临时目录）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
const QUESTION = '不要调用工具。我们团队的内部周报，要不要从每周五改成每两周一次？请简短回答。';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-live-'));
  const home = path.join(root, 'claude'), cwd = path.join(root, 'work'), data = path.join(root, 'data');
  const out = path.resolve('output', 'rules-tab-live');
  for (const dir of [home, cwd, data, out]) fs.mkdirSync(dir, { recursive: true });
  const sourceAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const report = { passed: false, checks: [], boundary: '真实隔离 Hub、真实 Claude PTY、Haiku 真实回复；规则为 Hub 内置第一版' };
  let hub, client;
  const until = async (expression, label, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await client.eval(`Boolean(${expression})`)) return; await _waitMs(200); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const p = await client.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await _waitMs(250);
  };
  const capture = async name => {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const check = (ok, label) => { assert(ok, label); report.checks.push(label); console.log('  ✓ ' + label); };
  const newSession = async () => {
    const session = await client.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: {
      cwd, model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', permissionMode: 'default', autonomous: false } })})`);
    assert(session && session.id);
    await until(`activeSessionId===${j(session.id)}`, 'session active');
    const ready = `(()=>{const t=window.__hubE2E.terminalBufferText(${j(session.id)});return t.includes('❯') && /Haiku|shortcuts|manual mode on/.test(t) && !t.includes('Esc to keep browser tools off');})()`;
    const browserConsent = `window.__hubE2E.terminalBufferText(${j(session.id)}).includes('Esc to keep browser tools off')`;
    try {
      await until(`(${ready}) || (${browserConsent})`, 'Claude startup or optional browser onboarding', 120000);
      if (await client.eval(browserConsent)) {
        // 临时测试目录里的一次性询问：不开浏览器工具（同 e2e-claude-fresh-welcome-live-cdp）。
        await _waitMs(500);
        await client.eval(`ipcRenderer.send('terminal-input',${j({ sessionId: session.id, data: '\x1b' })})`);
        await until(ready, 'Claude ready after onboarding', 60000);
      }
    } catch (error) {
      report.readyBuffer = await client.eval(`window.__hubE2E.terminalBufferText(${j(session.id)}).slice(-1500)`);
      throw error;
    }
    await _waitMs(1500);
    return session.id;
  };
  const ask = async sid => {
    await click('.floating-input-box');
    await client.send('Input.insertText', { text: QUESTION });
    await click('.floating-input-send');
    await until(`(()=>{const c=[...document.querySelectorAll('#msg-overlay .turn-card.assistant')];return c.some(e=>e.innerText.trim().length>20);})()`, 'real reply', 150000);
    await _waitMs(4000); // 等回复写完
    const parsed = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)}})`);
    assert.equal(parsed.error, null);
    const user = parsed.turns.filter(t => t.role === 'user').map(t => j(t)).join('\n');
    const reply = parsed.turns.filter(t => t.role === 'assistant').map(t => (t.text || t.content || j(t))).join('\n');
    return { user, reply: String(reply) };
  };
  try {
    fs.copyFileSync(sourceAuth, path.join(home, '.credentials.json'));
    fs.writeFileSync(path.join(home, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'light', skipDangerousModePermissionPrompt: true,
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
    const hooks = require('../core/claude-hook-integration').ensureClaudeHookIntegration({
      claudeDir: home, sourceScriptsDir: path.resolve(__dirname, '../scripts'), logger: { log() {}, warn() {} } });
    assert.deepEqual(hooks.errors, [], 'isolated Claude lifecycle hooks installed');
    fs.writeFileSync(path.join(data, 'config.json'), j({ runtime: { agent: 'pty' } }));
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'rules real Claude', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_CONFIG_DIR: home,
      AI_HUB_WORKSPACE_ROOT: root, CODEX_HOME: path.join(root, 'codex'), AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/' } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__hubE2E', 'renderer ready');

    // 1. 通用规则开着：Claude 启动时写进系统提示，消息本身保持干净
    const sid = await newSession();
    const info = await client.eval(`sessions.get(${j(sid)})`);
    check(info.hubRulesSystem && /通用规则 v1/.test(info.hubRulesSystem.label), '新建 Claude 会话时记录了「启动时带上通用规则 v1」');
    const systemDir = path.join(data, 'hub-rules', 'system');
    check(fs.existsSync(systemDir) && fs.readdirSync(systemDir).some(f => fs.readFileSync(path.join(systemDir, f), 'utf8').includes('AI Hub 通用规则 v1')), '启动前写好了给 Claude 系统提示用的规则文件');
    const first = await ask(sid);
    report.firstReply = first.reply.slice(0, 800);
    check(!first.user.includes('ai-hub-rules') && !first.user.includes('pasted_content'), '用户消息里没有粘贴规则，不会被 CLI 标成「可能不是用户写的」');
    check(/^\s*📌/.test(first.reply), 'Haiku 的回复按规则以「📌」开头');
    // 问题要求「简短回答」，规则里简单问答不加结尾三件套，所以「白话解读」只记录不判定。
    report.firstHasPlainSummary = first.reply.includes('白话解读');
    check(!(await client.eval(`document.querySelector('.session-item.active, [data-session-id=${j(sid)}]')?.textContent||''`)).includes('pasted'), '会话标题取自问题本身');
    await capture('01-reply-with-rules');
    await click('#btn-rules');
    await until(`getComputedStyle(document.getElementById('rules-panel')).display==='flex'`, 'rules page');
    await click('.rl-tab[data-view="delivery"]');
    await until(`[...document.querySelectorAll('.rl-table tr')].some(r=>r.textContent.includes('启动时写进系统提示'))`, 'delivery system', 30000);
    check(true, '规则页「送达情况」显示该 Claude 会话「启动时写进系统提示」');
    await capture('02-delivery-system');

    // 2. 关掉通用规则，新会话不再带
    await click('.rl-tab[data-view="official"]');
    await until(`!!document.querySelector('.rl-switch')`, 'switch');
    await click('.rl-switch');
    await until(`document.querySelector('.rl-switch').getAttribute('aria-checked')==='false'`, 'switch off');
    const sid2 = await newSession();
    const second = await ask(sid2);
    report.secondReply = second.reply.slice(0, 600);
    check(!second.user.includes('ai-hub-rules'), '关掉通用规则后，新会话的消息不再带规则');
    report.secondStartsWithPin = /^\s*📌/.test(second.reply);
    await capture('03-reply-without-rules');
    report.passed = true;
    console.log(`规则 Tab 真实 AI e2e：${report.checks.length} 项通过；关掉规则后的回复是否以 📌 开头：${report.secondStartsWithPin}`);
  } catch (error) {
    report.error = error.stack; process.exitCode = 1; console.error(error);
    if (client) { try { report.screen = await client.eval('document.body.innerText.slice(-2500)'); await capture('failure'); } catch (_) {} }
  } finally {
    try { client?.close?.(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(e => { console.error(e); process.exitCode = 1; });
    try { fs.rmSync(path.join(home, '.credentials.json'), { force: true }); } catch (_) {}
    fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 2));
  }
}
main();
