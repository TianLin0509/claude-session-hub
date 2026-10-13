'use strict';
// 真实验收（替身）：CodeAgent 会话内换模型（2026-10-13 公司探测：`--resume <会话> --model <新模型>` 能接着原会话换模型）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code（GLM / MiniMax 都换成 haiku），参数原样透传。
//   ① 第一轮让它记住一个暗号；
//   ② 点输入框下方的模型 → 菜单写明「用新模型接着这个会话重开」→ 选 MiniMax-M2.7；
//   ③ Hub 重开 CodeAgent，敲出的命令带 --resume <原会话号> 和 --model MiniMax-M2.7；输入框和侧栏换成 MiniMax；
//   ④ 再问暗号，回答里有它（对话接上了，不是新会话）。
// 凭据复制进临时目录，finally 删除。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const SECRET = '蓝鲸-4271';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-switch-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261013-codeagent-model-switch-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), cwd = path.join(root, 'workspace');
  for (const d of [cac, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
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
  const chip = `[...document.querySelectorAll('.composer-model')].find(e=>!e.hidden&&e.offsetParent)`;
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent model switch', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');

    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card')`);
    const ask = async (text, label) => {
      const before = await c.eval(`document.querySelectorAll('#msg-overlay .turn-card.assistant').length`);
      await click('.floating-input-box');
      await c.send('Input.insertText', { text });
      await click('.floating-input-send');
      await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed' && document.querySelectorAll('#msg-overlay .turn-card.assistant').length > ${before} && [...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().innerText.trim().length > 1`, label, 240000);
      await sleep(1500);
      return c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().querySelector('.turn-body').innerText`);
    };

    // ① 记住暗号
    const first = await ask(`不要调用工具。请记住这个暗号：${SECRET}。只回答“记住了”。`, 'first answer');
    result.first = first;
    const nativeId = await c.eval(`sessions.get(${q}).ccSessionId || ''`);
    check(/^[0-9a-f-]{36}$/.test(nativeId), `第一轮回答完成，CodeAgent 会话号 ${nativeId.slice(0, 8)}…`);
    await shot('01-first');

    // ② 菜单换模型
    await c.eval(`${chip}.setAttribute('data-e2e-chip','1')`);
    await click('[data-e2e-chip="1"]');
    await until(`!!document.querySelector('.model-picker-menu .model-picker-item[data-model-id="MiniMax-M2.7"]')`, 'menu', 10000);
    const note = await c.eval(`document.querySelector('.model-picker-menu .model-picker-note')?.textContent || ''`);
    check(/用新模型接着这个会话重开/.test(note) && !(await c.eval(`document.querySelector('.model-picker-menu .model-picker-item[data-model-id="MiniMax-M2.7"]').classList.contains('disabled')`)),
      '模型菜单可以点，写明「用新模型接着这个会话重开 CodeAgent，对话记录保留」');
    await shot('02-menu');
    await click('.model-picker-menu .model-picker-item[data-model-id="MiniMax-M2.7"]');
    await until(`/已换成 MiniMax M2\\.7/.test(document.querySelector('.model-picker-menu .model-picker-note')?.textContent || '') || ${chip}?.querySelector('.composer-chip-label')?.textContent === 'MiniMax M2.7'`, 'switched', 120000);
    await shot('03-switched');

    // ③ 重开命令与界面
    const screen = `(() => { const t = terminalCache.get(${q})?.terminal; if (!t) return ''; const b = t.buffer.normal; let x = ''; for (let i = 0; i < b.length; i++) x += (b.getLine(i)?.translateToString(true) || '') + '\\n'; return x; })()`;
    await until(`(${screen}).replace(/\\s+/g,'').includes('--resume${nativeId}')`, 'resume command', 60000);
    const typed = (await c.eval(screen)).replace(/\s+/g, '');
    check(typed.includes(`--resume${nativeId}`) && typed.includes('--modelMiniMax-M2.7'), '重开命令带 --resume <原会话号> 和 --model MiniMax-M2.7');
    await until(`${chip}?.querySelector('.composer-chip-label')?.textContent === 'MiniMax M2.7'`, 'composer label', 30000);
    const row = await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"] .sl-kind')?.className || ''`);
    check(row.includes('logo-minimax'), '输入框下方显示 MiniMax M2.7，侧栏图标换成 MiniMax');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state !== 'starting' && sessions.get(${q}).ccSessionId === ${j(nativeId)}`, 'rebound', 120000);
    check(true, '重开后仍绑定原来的会话号');

    // ④ 对话接上了
    const second = await ask('不要调用工具。我刚才让你记住的暗号是什么？只回答暗号本身。', 'second answer');
    result.second = second;
    check(second.includes('4271'), `换模型后再问暗号，回答「${second.trim().slice(0, 30)}」——对话接上了`);
    await shot('04-recall');
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
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
