'use strict';
// 真实验收（替身）：CodeAgent 会话启动时把「规则」页的通用规则写进系统提示（2026-10-13，
// 公司真机 1.2615.02.01 已证实 --append-system-prompt-file 生效）。替身 tests/fixtures/codeagent-standin
// 启动真 Claude Code（haiku），参数原样透传。
//   ① 敲出的启动命令带 --append-system-prompt-file，会话记录「启动时写进系统提示」；
//   ② 第一条消息的原生记录里没有 <ai-hub-rules>，卡片只有问题；
//   ③ 规则页「送达情况」显示「启动时写进系统提示」；
//   ④ 用户卡片「发送内容」面板的系统提示组能展开看到规则原文，这条消息组只有正文。
// 凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const QUESTION = '不要调用工具。周报要不要改成双周一次？请简短回答。';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-rules-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261013-codeagent-rules-system-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), cwd = path.join(root, 'workspace');
  for (const d of [cac, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const result = { checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent rules system', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');

    // ① 启动
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`selectSession(${q})`);
    check(/通用规则 v\d+/.test(await c.eval(`sessions.get(${q})?.hubRulesSystem?.label || ''`)), '新建 CodeAgent 会话记录了「启动时带上通用规则」');
    const normalScreen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.normal; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    const screen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.active; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await c.eval(`applyViewMode('pty')`);
    const READY = String.raw`bypass permissions on \(|Anything I can assist you with`;
    await until(`new RegExp(${j(READY)}).test(${screen})`, 'tui ready', 120000); await sleep(1500);
    const typed = (await c.eval(normalScreen)).replace(/\s+/g, '');
    check(typed.includes('--append-system-prompt-file') && /hub-rules[\\/]+system[\\/]+rules-[0-9a-f]{16}\.md/.test(typed), '敲出的启动命令带 --append-system-prompt-file，指向 Hub 的规则文件');
    await shot('01-tui');
    await c.eval(`applyViewMode('card')`);

    // ② 第一条消息走真实输入框
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: QUESTION });
    await click('.floating-input-send');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed' && [...document.querySelectorAll('#msg-overlay .turn-card.assistant')].some(e=>e.innerText.trim().length>10)`, 'first answer', 240000);
    await sleep(3000);
    const transcript = await c.eval(`sessions.get(${q})?.transcriptPath || ''`);
    const raw = fs.readFileSync(transcript, 'utf8');
    result.replyHead = (await c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop()?.innerText.slice(0, 200) || ''`));
    check(raw.includes(QUESTION.slice(0, 10)) && !raw.includes('<ai-hub-rules'), '原生记录里的第一条消息没有 <ai-hub-rules>');
    const userCard = await c.eval(`(()=>{const e=[...document.querySelectorAll('#msg-overlay .turn-card.user')].pop();return e&&{text:e.querySelector('.turn-body').innerText.trim(),btn:e.querySelector('.turn-compose-btn')?.innerText.trim()};})()`);
    check(userCard && userCard.text === QUESTION && userCard.btn === '发送内容', '卡片只显示问题本身，按钮没有「+1」');
    result.replyStartsWithPin = /^\s*📌/.test(String(result.replyHead).replace(/^.*?\n/, ''));
    await shot('02-card');

    // ④ 发送内容面板
    await c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.user')].pop().querySelector('.turn-compose-btn').setAttribute('data-e2e-target','1')`);
    await click('[data-e2e-target="1"]');
    await until(`document.querySelector('.prompt-composition-dialog .pc-group')`, 'panel', 15000);
    const groups = await c.eval(`[...document.querySelectorAll('.prompt-composition-dialog .pc-group')].map(g=>({group:g.dataset.group,parts:[...g.querySelectorAll('.pc-part')].map(p=>p.dataset.partId)}))`);
    result.panel = groups;
    check(groups[0].parts.includes('hub-rules-system'), '面板系统提示组里列出 Hub 规则');
    await click('.prompt-composition-dialog .pc-part[data-part-id="hub-rules-system"] > summary');
    const sysText = await c.eval(`document.querySelector('.prompt-composition-dialog .pc-part[data-part-id="hub-rules-system"] pre')?.innerText || ''`);
    check(/AI Hub 默认带上的规则/.test(sysText), '展开后能看到写进系统提示的规则原文');
    check(groups[2].parts.join() === 'user', '这条消息组只有用户正文');
    await shot('03-panel');
    await click('.prompt-composition-dialog .card-detail-dialog-head button');

    // ③ 规则页送达情况
    await click('#btn-rules');
    await until(`getComputedStyle(document.getElementById('rules-panel')).display==='flex'`, 'rules page');
    // 规则页载入数据后会整页重画一次，点到「送达情况」真正激活为止。
    for (let i = 0; i < 8 && !(await c.eval(`document.querySelector('.rl-tab[data-view="delivery"]')?.classList.contains('active')`)); i++) {
      await click('.rl-tab[data-view="delivery"]'); await sleep(500);
    }
    await until(`[...document.querySelectorAll('.rl-table tr')].some(r=>r.textContent.includes('启动时写进系统提示'))`, 'delivery system', 30000);
    check(true, '规则页「送达情况」显示该 CodeAgent 会话「启动时写进系统提示」');
    await shot('04-delivery');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1500)'); } catch {} }
    if (hub) { try { result.hubLogTail = hub.log().slice(-40); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, replyStartsWithPin: result.replyStartsWithPin, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
