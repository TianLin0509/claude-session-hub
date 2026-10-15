'use strict';
// 真实验收（替身）：草稿目录「归档并重连」保留 CodeAgent 的上下文（2026-10-16）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code（模型换成 haiku），记录落在隔离配置目录的 projects/ 下。
//   ① 在草稿目录新建 CodeAgent 会话，从输入框让它记住一个暗号；
//   ② 归档到正式目录并重连（和其他 CLI 的归档 e2e 一样走 workspace:archive-and-restart）；
//   ③ 新目录的项目桶里有原会话的记录，会话带原身份回来、工作目录是新目录；
//   ④ 从输入框问暗号，答对 —— 对话接上了。
// 以前 CodeAgent 直接报「不支持保留上下文迁移」。凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const SECRET = '蓝鲸-4471';
const slug = cwd => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-archive-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261016-codeagent-archive-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), workRoot = path.join(root, 'Work');
  for (const d of [cac, dataDir, path.join(workRoot, 'AI')]) fs.mkdirSync(d, { recursive: true });
  const result = { checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch (_) {} await sleep(300); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  const ask = async (q, text) => {
    const countBefore = await c.eval(`document.querySelectorAll('#msg-overlay .turn-card.assistant').length`);
    await click('.floating-input-box');
    await c.send('Input.insertText', { text });
    await click('.floating-input-send');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed' && document.querySelectorAll('#msg-overlay .turn-card.assistant').length > ${countBefore} && [...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().innerText.trim().length > 1`, 'answer', 240000);
    await sleep(1500);
    return c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().querySelector('.turn-body').innerText`);
  };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent archive',
      ...(process.env.E2E_ENTRY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_WORKSPACE_ROOT: workRoot, CODEAGENT_STANDIN_MODEL: 'haiku', ANTHROPIC_MODEL: 'haiku',
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]),
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!(window.WorkspaceController && window.WorkspaceController.createScratch)', 'renderer');
    result.version = await c.eval(`document.getElementById('hub-version')?.textContent || ''`);

    // ① 草稿目录里的 CodeAgent 会话，记一个暗号
    const created = JSON.parse(await c.eval(`(async () => {
      const ws = await window.WorkspaceController.createScratch('codeagent');
      const s = await window.WorkspaceController.createSession('codeagent', { workspace: ws, opts: { model: 'GLM-5.2-WX-Auto' } });
      return JSON.stringify({ id: s.id, cwd: s.cwd });
    })()`));
    const q = j(created.id);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card')`);
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state !== 'starting'`, 'ready', 120000);
    const first = await ask(q, `不要调用工具。请记住这个暗号：${SECRET}。只回答“记住了”。`);
    await until(`!!sessions.get(${q}).ccSessionId`, 'identity bound', 60000);
    const ccSessionId = await c.eval(`sessions.get(${q}).ccSessionId`);
    check(/记住/.test(first) && !!ccSessionId, `草稿目录里的 CodeAgent 记住暗号，已绑定原会话号 ${ccSessionId.slice(0, 8)}…`);
    const context = JSON.parse(await c.eval(`ipcRenderer.invoke('workspace:archive-context', { scope: 'session', id: ${q} }).then(JSON.stringify)`));
    check(context.resumeReady === true, '归档建议显示可以安全重连（以前是「不支持保留上下文迁移」）');
    await shot('01-before-archive');

    // ② 归档并重连
    const parent = path.join(workRoot, 'AI');
    const archived = await c.eval(`ipcRenderer.invoke('workspace:archive-and-restart', { scope: 'session', id: ${q}, parent: ${j(parent)}, folderName: 'codeagent-archived' })`);
    const target = path.join(parent, 'codeagent-archived');
    check(archived && archived.ok === true && fs.existsSync(target) && !fs.existsSync(created.cwd), '归档成功：草稿目录搬到正式目录');
    check(fs.existsSync(path.join(cac, 'projects', slug(target), ccSessionId + '.jsonl')), '新目录的项目桶里有原会话的记录');
    result.warnings = archived.warnings;

    // ③ 带原身份回来
    await until(`!!sessions.get(${q}) && sessions.get(${q}).cwd && sessions.get(${q}).cwd.toLowerCase() === ${j(target.toLowerCase())}`, 'resumed in target', 60000);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card')`);
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state !== 'starting'`, 'ready after archive', 120000);

    // ④ 对话接上了
    const answer = await ask(q, '不要调用工具。我刚才让你记住的暗号是什么？只回答暗号本身。');
    result.answer = answer;
    check(answer.includes('4471'), `归档后问暗号，回答「${answer.trim().slice(0, 30)}」——上下文接上了`);
    const after = await c.eval(`sessions.get(${q}).ccSessionId`);
    result.ccAfter = after;
    await shot('02-recall-after-archive');
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
    console.log(JSON.stringify({ passed: result.passed, version: result.version, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
