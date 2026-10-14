'use strict';
// 真实验收（替身）：CodeAgent 会话的「发送内容」面板列出它找到的规则文件和自动记忆（2026-10-14 用户要求）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code（模型换成 haiku），参数原样透传。
//   ① 隔离的 CodeAgent 配置目录里放用户级 AGENTS.md、项目目录放 AGENTS.md、记忆目录放 MEMORY.md；
//   ② 新建 CodeAgent 会话，从卡片输入框发一句话，等真实回答；
//   ③ 点用户卡片上的「发送内容」：「会话开头自动带上的规则与记忆」里有这三份，展开能看到原文；
//      工作目录里的 AGENTS.md 不标推断，其余标「推断，尚未在公司电脑上实测」。
// E2E_ENTRY 指向公司版导出目录（目录里要有指向生产依赖的 node_modules 链接）。凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { projectSlug } = require('../core/prompt-inspect');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const QUESTION = '不要调用工具。用一句话说说周报该怎么写。';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-compose-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261014-codeagent-composition-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), work = path.join(root, 'work'), proj = path.join(work, 'weekly');
  for (const d of [cac, dataDir, work, proj]) fs.mkdirSync(d, { recursive: true });
  const result = { company: !!process.env.E2E_ENTRY, checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await c.eval(expr); if (v) return v; } catch (_) {} await sleep(400); } throw Error('timeout: ' + label); };
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
    // ① 三份上下文文件
    fs.writeFileSync(path.join(cac, 'AGENTS.md'), '# 我的通用习惯\n回答用中文，先给结论。\n');
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# 周报项目\n周报模板放在 templates/ 目录。\n');
    const memDir = path.join(cac, 'projects', projectSlug(fs.realpathSync.native(proj)), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [周报节奏](cadence.md) — 周报每周五下午发\n');
    fs.writeFileSync(path.join(memDir, 'cadence.md'), '周报每周五下午发。\n');

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent composition',
      ...(process.env.E2E_ENTRY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        CLAUDE_HUB_E2E: '1', AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_WORKSPACE_ROOT: work,
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]),
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && typeof getSessionRuntimeTruth === "function"', 'renderer', 60000);
    result.product = await c.eval(`document.querySelector('#hub-identity strong')?.textContent || ''`);

    // ② 新建会话，从卡片输入框发消息
    const s = await c.eval(`require('electron').ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { title: '周报', cwd: proj, model: 'GLM-5.2-WX-Auto', effort: 'low' } })})`);
    await until(`activeSessionId===${j(s.id)}`, 'session active', 30000);
    await until(`getSessionRuntimeTruth(sessions.get(${j(s.id)})).state !== 'starting'`, 'codeagent ready', 120000);
    await sleep(1500);
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: QUESTION });
    await click('.floating-input-send');
    await until(`(()=>{const c=[...document.querySelectorAll('#msg-overlay .turn-card.assistant')];return c.some(e=>e.innerText.trim().length>8);})()`, 'real reply', 240000);
    await until(`!!document.querySelector('#msg-overlay .turn-card.user .turn-compose-btn')`, 'user card with button', 30000);
    await sleep(3000);
    check(true, 'CodeAgent 会话收到真实回答，用户卡片上有「发送内容」按钮');

    // ③ 打开面板
    await c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.user')].pop().querySelector('.turn-compose-btn').setAttribute('data-e2e-target','1')`);
    await click('[data-e2e-target="1"]');
    await until(`document.querySelector('.prompt-composition-dialog .pc-group[data-group="startup"] .pc-part')`, 'composition panel', 15000);
    const startup = await c.eval(`[...document.querySelectorAll('.prompt-composition-dialog .pc-group[data-group="startup"] .pc-part')].map(p=>({id:p.dataset.partId,title:p.querySelector('.pc-title').innerText,path:p.querySelector('.pc-path')?.textContent||'',note:p.querySelector('.pc-note')?.textContent||''}))`);
    result.startup = startup;
    const userRule = startup.find(p => p.path === path.join(cac, 'AGENTS.md'));
    const projRule = startup.find(p => p.path === path.join(proj, 'AGENTS.md'));
    const memory = startup.find(p => /MEMORY\.md/.test(p.title));
    check(userRule && projRule && memory, `「会话开头自动带上的规则与记忆」列出用户级 AGENTS.md、项目 AGENTS.md、自动记忆 MEMORY.md（共 ${startup.length} 项）`);
    check(!startup.some(p => /CLAUDE\.md/.test(p.title + p.path)), '不再把 Claude 的 CLAUDE.md 当成 CodeAgent 会读的文件');
    check(/用户级/.test(userRule.title) && /工作目录/.test(projRule.title), `同名文件标题标出来源（${userRule.title} / ${projRule.title}）`);
    check(!/推断/.test(projRule.note) && /推断/.test(userRule.note) && /推断/.test(memory.note), '工作目录里的 AGENTS.md 不标推断；用户级规则和自动记忆标「推断，尚未实测」');
    await click(`.prompt-composition-dialog .pc-part[data-part-id=${j(await c.eval(`[...document.querySelectorAll('.prompt-composition-dialog .pc-part')].find(p=>/MEMORY/.test(p.querySelector('.pc-title').innerText)).dataset.partId`))}] > summary`);
    const memText = await c.eval(`[...document.querySelectorAll('.prompt-composition-dialog .pc-part')].find(p=>/MEMORY/.test(p.querySelector('.pc-title').innerText)).querySelector('pre')?.innerText||''`);
    check(memText.includes('周报每周五下午发'), '展开自动记忆能看到 MEMORY.md 原文');
    await shot('01-codeagent-composition');
    result.passed = true;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { if (c) c.close(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(() => console.log('PASS e2e-codeagent-composition-standin'), error => { console.error(error); process.exit(1); });
