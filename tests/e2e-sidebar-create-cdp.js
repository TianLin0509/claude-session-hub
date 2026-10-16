'use strict';
// Real isolated Electron, physical CDP clicks, synthetic history/native CLI.
// No production state or credentials; no model prompt is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const stamp = `${Date.now()}-${process.pid}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-create-'));
const data = path.join(root, 'data'), home = path.join(root, 'codex'), work = path.join(root, 'work');
const out = path.resolve(__dirname, '../artifacts/20261017-hub-sidebar-create-codex1', stamp);
for (const dir of [data, home, work, out]) fs.mkdirSync(dir, { recursive: true });
const evidence = { scope: 'Real Electron UI with synthetic history and native CLI fixture; no model prompts', checks: [], screenshots: [], root };
const accountFixture = process.env.HUB_CREATE_AUTH_FIXTURE_DELAY ? path.join(root, 'account-fixture.cjs') : null;
if (accountFixture) {
  fs.writeFileSync(accountFixture, `const action=process.argv[2];setTimeout(()=>console.log(JSON.stringify(action==='images'?{ok:true,accounts:[]}:{ok:true,state:'signed_in',message:'Controlled auth precheck',source:'fixture'})),action==='check'?2000:0);`);
  evidence.authBoundary = 'Account status fixture takes 2000ms; submit after the form precheck finishes, simulating time spent choosing launch settings.';
}
const check = (name, value) => { assert(value, name); evidence.checks.push(name); console.log('PASS', name); };
const now = Date.now(), day = 86400000;
const row = (hubId, title, extra = {}) => ({ hubId, title, cwd: work, kind: 'codex', status: 'dormant',
  createdAt: now - 3600000, lastMessageTime: now - 3600000, lastCompletedAt: now - 3600000, ...extra });
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, meetings: [], sessions: [
  row('ordinary', '普通会话'), row('wireless-discussion', '无线算法讨论'),
  row('wireless-job', '无线 · 功能实现', { purpose: 'wireless-proposal' }),
  row('wireless-review', '无线 · 审查 · 功能实现'),
  row('renamed-wireless', '已经改名的协作任务', { purpose: 'wireless-proposal' }),
  row('older-wireless', '无线 · 两天前的任务', { lastMessageTime: now - 2 * day, lastCompletedAt: now - 2 * day }),
  row('pinned-wireless', '无线 · 置顶任务', { pinned: true }), row('pinned-ordinary', '普通置顶', { pinned: true }),
] }));
fs.writeFileSync(path.join(data, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'Astra',
  supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }, { effort: 'ultra' }], additional_speed_tiers: ['fast'] }] }));
let hub, c;
const q = JSON.stringify;
async function until(expression, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await c.eval(expression)) return; await _waitMs(100); }
  throw Error('Timeout: ' + expression);
}
async function click(selector) {
  const p = await c.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e)throw Error('missing '+${q(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('hidden/obscured '+${q(selector)});return{x,y};})()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
}
async function shot(label) {
  await _waitMs(200);
  const image = await c.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, `20261017-${label}-codex1.png`);
  fs.writeFileSync(file, Buffer.from(image.data, 'base64')); evidence.screenshots.push(file);
}
const visible = id => `!!document.querySelector('#session-list [data-session-id="${id}"]')`;
async function menuClick(selector) { await click('#btn-toolbar-more'); await click(selector); }
async function main() {
  try {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'sidebar-create', windowMode: 'background',
      ...(process.env.HUB_CREATE_DIAG_ENTRY ? { entryPath: process.env.HUB_CREATE_DIAG_ENTRY } : {}), extraEnv: {
      CLAUDE_HUB_E2E: '1', AI_HUB_WORKSPACE_ROOT: work, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      ...(accountFixture ? { CLAUDE_HUB_ACCOUNT_FIXTURE: accountFixture } : {}),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.WorkspaceController && !!document.querySelector("#session-list [data-session-id=ordinary]")');
    check('默认隐藏无线协作，普通会话及一般无线讨论保留', await c.eval(`${visible('ordinary')} && ${visible('wireless-discussion')} && !${visible('wireless-job')} && !${visible('wireless-review')} && !${visible('renamed-wireless')}`));
    check('电脑和手机默认收在更多菜单内', await c.eval('document.querySelector("#toolbar-more-menu").hidden && !document.querySelector("button[data-display-mode=desktop]").getBoundingClientRect().width'));
    await shot('无线隐藏');
    await click('#btn-sidebar-wireless');
    check('无线开关显示新旧任务与改名任务，并保留普通会话', await c.eval(`${visible('ordinary')} && ${visible('wireless-job')} && ${visible('wireless-review')} && ${visible('renamed-wireless')}`));
    check('筛选不会唤醒休眠任务', await c.eval("sessions.get('wireless-job').status === 'dormant'"));
    await shot('无线显示');
    await click('[data-session-days="3"]');
    check('无线开关与三天范围叠加', await c.eval(visible('older-wireless')));
    await click('[data-session-days="pinned"]');
    check('置顶页也显示已开启的无线任务', await c.eval(`${visible('pinned-wireless')} && ${visible('pinned-ordinary')}`));
    await click('#btn-sidebar-wireless');
    check('关闭无线不会删除普通置顶', await c.eval(`!${visible('pinned-wireless')} && ${visible('pinned-ordinary')}`));
    await click('[data-session-days="1"]');
    await c.send('Page.reload'); await _waitMs(500);
    await until('!!window.WorkspaceController && !!document.querySelector("#session-list [data-session-id=ordinary]")');
    check('刷新后保持无线隐藏偏好', await c.eval('document.querySelector("#btn-sidebar-wireless").getAttribute("aria-pressed")==="false"'));
    // Measure actual IPC calls, while preserving each real handler/response.
    await c.eval(`window.__creationTimings=[];window.__invokeOriginal=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=async(channel,...args)=>{const t=performance.now();try{return await window.__invokeOriginal(channel,...args);}finally{window.__creationTimings.push({channel,kind:args[0]?.kind,ms:performance.now()-t});}}`);
    await click('#btn-new-more');
    await click('.new-session-option[data-kind="codex"]');
    await until('!document.querySelector("#new-session-submit").disabled');
    if (accountFixture) {
      await until('window.__creationTimings.some(t=>t.channel==="session:prepare-launch-auth"&&t.kind==="codex")');
      check('点击创建之前账号检查已经完成', await c.eval('!window.__creationTimings.some(t=>t.channel==="create-session")'));
    }
    const before = await c.eval('[...sessions.keys()]');
    const start = Date.now();
    await click('#new-session-submit');
    await until(`[...sessions.keys()].some(id=>!${q(before)}.includes(id)) && !!document.querySelector('.floating-input-box')`);
    evidence.createMs = Date.now() - start;
    evidence.creationTimings = await c.eval('window.__creationTimings');
    check('真实点击创建会话成功且表单关闭', await c.eval('document.querySelector("#new-session-menu").style.display==="none"'));
    const sessionId = await c.eval(`[...sessions.keys()].find(id=>!${q(before)}.includes(id))`);
    const originalModel = await c.eval(`sessions.get(${q(sessionId)}).currentModel`);
    await click('.floating-input-box'); await c.send('Input.insertText', { text: '保留草稿：显示与无线筛选验证' });
    const draft = await c.eval('document.querySelector(".floating-input-box").textContent');
    await menuClick('button[data-display-mode="phone"]');
    evidence.displayState = await c.eval(`({mode:document.documentElement.dataset.displayMode,activeSessionId,expected:${q(sessionId)},draft:document.querySelector('.floating-input-box').textContent,expectedDraft:${q(draft)},menuHidden:document.querySelector('#toolbar-more-menu').hidden})`);
    console.log('DISPLAY_STATE', JSON.stringify(evidence.displayState));
    check('更多菜单切换手机且保留会话和草稿', await c.eval(`document.documentElement.dataset.displayMode==='phone' && activeSessionId===${q(sessionId)} && document.querySelector('.floating-input-box').textContent===${q(draft)}`));
    check('显示切换不改变所选模型', JSON.stringify(await c.eval(`sessions.get(${q(sessionId)}).currentModel`)) === JSON.stringify(originalModel));
    await menuClick('#btn-display-settings');
    check('显示参数从菜单可打开', await c.eval('!document.querySelector("#display-preset-settings").hidden'));
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await click('#btn-sidebar-wireless');
    check('在会话中切换无线仍保留草稿', await c.eval(`activeSessionId===${q(sessionId)} && document.querySelector('.floating-input-box').textContent===${q(draft)}`));
    check('200像素手机预设中四个筛选按钮均在栏内', await c.eval("(()=>{const r=document.querySelector('.session-range-tabs').getBoundingClientRect();return [...document.querySelectorAll('.session-range-tabs button')].every(b=>{const x=b.getBoundingClientRect();return x.x>=r.x&&x.right<=r.right;})})()"));
    await menuClick('button[data-display-mode="desktop"]');
    check('电脑预设可切回且保留草稿', await c.eval(`document.documentElement.dataset.displayMode==='desktop' && document.querySelector('.floating-input-box').textContent===${q(draft)}`));
    await click('#btn-toolbar-more'); await shot('更多菜单');
    check('原有缩放与完成通知仍在同一个更多菜单', await c.eval("document.querySelector('#toolbar-more-actions').textContent.includes('放大界面') && !!document.querySelector('#toolbar-more-actions .ho-notify')"));
    const zoom = await c.eval('currentZoom');
    await click('#toolbar-more-actions button:nth-child(1)');
    check('更多菜单放大操作仍有效', await c.eval(`currentZoom===${zoom + 1}`));
    await menuClick('#toolbar-more-actions button:nth-child(3)');
    check('更多菜单重置缩放仍有效', await c.eval('currentZoom===0'));
    await click('#btn-home');
    await click('#btn-toolbar-more');
    check('主页也能访问显示预设', await c.eval('!document.querySelector("#toolbar-more-menu").hidden && document.querySelector("button[data-display-mode=phone]").getBoundingClientRect().width>0'));
    await click('button[data-display-mode="phone"]');
    await c.send('Page.reload'); await _waitMs(500);
    await until('!!window.WorkspaceController && !!document.querySelector("#btn-sidebar-wireless")');
    check('刷新后保持无线开启和手机显示偏好', await c.eval('document.documentElement.dataset.displayMode==="phone" && document.querySelector("#btn-sidebar-wireless").getAttribute("aria-pressed")==="true"'));
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; console.error(error.stack); process.exitCode = 1; if (c) await shot('失败').catch(() => {}); }
  finally {
    if (c) await c.close();
    if (hub) { fs.writeFileSync(path.join(out, '20261017-hub-log-codex1.txt'), hub.log().join('\n'), 'utf8');
      try { await gracefulQuit(hub); } catch (error) { evidence.teardownError = error.message; evidence.passed = false; process.exitCode = 1; } }
    fs.writeFileSync(path.join(out, '20261017-evidence-codex1.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log('EVIDENCE', out, evidence.passed ? 'PASS' : evidence.error);
  }
}
main();
