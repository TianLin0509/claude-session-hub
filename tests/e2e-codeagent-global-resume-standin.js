'use strict';
// 真实验收（替身）：恢复 CodeAgent 历史会话不再只看当前目录（2026-10-13 公司真机反馈）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code（GLM 换成 haiku），参数原样透传。
//   ① 在两个不同目录里各跑一次 CodeAgent，各记一个暗号（落盘到隔离配置目录的 projects/ 下两个项目桶）；
//   ② 启动中心 →「恢复会话」→ CodeAgent：弹窗按时间列出两个目录的记录，标出各自目录；
//   ③ 点第二个目录的那条：新会话的工作目录是那个目录，绑定原会话号；
//   ④ 问暗号，回答里是第二个目录那次的暗号（对话接上了）。
// E2E_ENTRY 指向公司版导出目录时，同时验证公司版的「恢复会话」页带着 CodeAgent 选项。凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN_JS = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent-standin.js');
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const SECRETS = { alpha: '青松-1186', beta: '白鹭-5309' };

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-resume-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261013-codeagent-global-resume-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data');
  const dirs = { alpha: path.join(root, 'proj-alpha'), beta: path.join(root, 'proj-beta') };
  for (const d of [cac, dataDir, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
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
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    // ① 两个目录各一段历史（和真机一样由 CLI 自己落盘；子会话标记会让 CLI 不保存记录，先剥掉）
    const env = { ...process.env, CODEAGENT3_CONFIG_DIR: cac };
    for (const key of Object.keys(env)) if (/^CLAUDECODE$|^CLAUDE_CODE_/.test(key)) delete env[key];
    const nativeIds = {};
    for (const name of ['alpha', 'beta']) {
      const run = spawnSync(process.execPath, [STANDIN_JS, '--disable-update', '--model', 'GLM-5.2-WX-Auto', '--permission-mode', 'bypassPermissions',
        '--output-format', 'json', '-p', `不要调用工具。请记住这个暗号：${SECRETS[name]}。只回答“记住了”。`], { cwd: dirs[name], env, encoding: 'utf8', timeout: 180000, windowsHide: true });
      const line = String(run.stdout || '').split(/\r?\n/).find(l => l.trim().startsWith('{'));
      nativeIds[name] = line ? JSON.parse(line).session_id : '';
      if (!nativeIds[name]) throw Error(`seed ${name} failed: ${String(run.stderr || run.stdout).slice(0, 400)}`);
      await sleep(1200);
    }
    const buckets = fs.readdirSync(path.join(cac, 'projects'));
    check(buckets.length === 2, `两个目录各跑一次 CodeAgent，记录落在 2 个项目桶（${buckets.join('、')}）`);

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent global resume',
      ...(process.env.E2E_ENTRY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]),
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');
    result.version = await c.eval(`document.getElementById('hub-version')?.textContent || ''`);

    // ② 启动中心 → 恢复会话 → CodeAgent
    await click('#btn-new-more');
    await until(`!!document.querySelector('[data-launch-intent="resume"]')`, 'resume intent', 15000);
    await click('[data-launch-intent="resume"]');
    await until(`!!document.querySelector('[data-resume-kind="codeagent-resume"]')?.offsetParent`, 'codeagent resume option', 10000);
    await shot('01-resume-page');
    await click('[data-resume-kind="codeagent-resume"]');
    await until(`document.getElementById('resume-modal').style.display === 'flex' && document.querySelectorAll('#resume-list .modal-row').length >= 2`, 'modal rows', 30000);
    const rows = JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('#resume-list .modal-row')].map(r=>({cwd:r.querySelector('.modal-meta-cwd')?.title||'',text:r.innerText})))`));
    const title = await c.eval(`document.getElementById('resume-modal-title').textContent`);
    const has = d => rows.some(r => path.resolve(r.cwd).toLowerCase() === path.resolve(d).toLowerCase());
    check(/CodeAgent/.test(title) && has(dirs.alpha) && has(dirs.beta), `弹窗「${title}」列出两个不同目录的记录（共 ${rows.length} 条）`);
    await shot('02-modal');

    // ③ 点 beta 那条
    const before = await c.eval('sessions.size');
    await c.eval(`[...document.querySelectorAll('#resume-list .modal-row')].find(r=>(r.querySelector('.modal-meta-cwd')?.title||'').toLowerCase()===${j(path.resolve(dirs.beta).toLowerCase())}).setAttribute('data-e2e-row','1')`);
    await click('[data-e2e-row="1"]');
    await until(`sessions.size > ${before}`, 'session created', 30000);
    const sid = await c.eval(`[...sessions.values()].pop().id`), q = j(sid);
    const info = JSON.parse(await c.eval(`JSON.stringify((({kind,cwd,ccSessionId})=>({kind,cwd,ccSessionId}))(sessions.get(${q})))`));
    result.created = info;
    check(info.kind === 'codeagent' && path.resolve(info.cwd).toLowerCase() === path.resolve(dirs.beta).toLowerCase(),
      `新会话是 CodeAgent，工作目录是原来的 proj-beta`);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card')`);
    await until(`sessions.get(${q}).ccSessionId === ${j(nativeIds.beta)}`, 'bound to beta', 120000);
    check(true, `绑定原会话号 ${nativeIds.beta.slice(0, 8)}…`);

    // ④ 对话接上了
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state !== 'starting'`, 'ready', 120000);
    const countBefore = await c.eval(`document.querySelectorAll('#msg-overlay .turn-card.assistant').length`);
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: '不要调用工具。我刚才让你记住的暗号是什么？只回答暗号本身。' });
    await click('.floating-input-send');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed' && document.querySelectorAll('#msg-overlay .turn-card.assistant').length > ${countBefore} && [...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().innerText.trim().length > 1`, 'answer', 240000);
    await sleep(1500);
    const answer = await c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().querySelector('.turn-body').innerText`);
    result.answer = answer;
    check(answer.includes('5309') && !answer.includes('1186'), `问暗号，回答「${answer.trim().slice(0, 30)}」——接上的是 proj-beta 那段对话`);
    await shot('03-recall');
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
