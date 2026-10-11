'use strict';
// 规则 Tab · 本机已有个人基础规则（~/.agents/USER_CONTEXT.md）的用户（2026-10-12）：
//   通用规则默认关并说明原因；「我的规则」显示并可编辑个人基础规则，保存时保留 CRLF、先备份。
// 隔离 Hub，个人规则写在测试目录的隔离 home 里；不启动真实 AI。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.join(path.resolve(__dirname, '..'), 'output', 'rules-tab');
fs.mkdirSync(out, { recursive: true });
const reservePort = () => new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
let hub, cdp; const checks = [];
const until = async (expression, label = expression, tries = 150) => {
  for (let i = 0; i < tries; i++) { if (await cdp.eval(`Boolean(${expression})`)) return; await _waitMs(100); }
  throw Error('timeout ' + label);
};
const click = async selector => {
  const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await _waitMs(160);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await _waitMs(250);
};
const check = (ok, label) => { assert(ok, label); checks.push(label); console.log('  ✓ ' + label); };

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-personal-'));
  const home = path.join(temp, 'home'), workspace = path.join(temp, 'work');
  const personal = path.join(home, '.agents', 'USER_CONTEXT.md');
  fs.mkdirSync(path.dirname(personal), { recursive: true }); fs.mkdirSync(workspace);
  fs.writeFileSync(personal, '# 个人基础规则\r\n\r\n- 回复用中文。\r\n', 'utf8');
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await reservePort(), label: 'rules-personal', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: workspace, CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: home, CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
      AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/' } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('document.querySelector("#empty-state")?.dataset.homeReady === "true"', 'home', 300);
    await click('#btn-rules');
    await until(`!!document.querySelector('.rl-switch')`, 'rules page');
    check(await cdp.eval(`document.querySelector('.rl-switch').getAttribute('aria-checked')==='false'`), '已有个人基础规则：通用规则默认关');
    check(await cdp.eval(`[...document.querySelectorAll('.rl-note')].some(e=>e.textContent.includes('本机已有你的个人基础规则'))`), '并说明默认关的原因');
    check(await cdp.eval(`document.getElementById('rl-summary').textContent.includes('个人基础规则，已写入各 CLI')`), '顶部显示个人基础规则生效');
    // 检查更新连不上服务器：继续用当前版本，并说清原因
    await click('#rl-check-update');
    await until(`(document.querySelector('#rl-check-result')?.textContent||'').includes('检查失败')`, 'check failed', 200);
    check((await cdp.eval(`document.querySelector('#rl-check-result').textContent`)).includes('继续使用 v1'), '连不上服务器时提示失败原因，继续用 v1');
    await cdp.eval(`document.querySelector('.rl-tab[data-view="mine"]').click()`);
    await until(`!!document.getElementById('rl-mine-editor')`, 'mine');
    check((await cdp.eval(`document.getElementById('rl-mine-editor').value`)).includes('回复用中文'), '「我的规则」显示个人基础规则原文');
    check((await cdp.eval(`document.querySelector('.rl-path').textContent`)).endsWith('USER_CONTEXT.md'), '显示文件路径');
    await click('#rl-mine-editor');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
    await cdp.send('Input.insertText', { text: '- 先给结论。\n' });
    await click('#rl-mine-save');
    await until(`(document.querySelector('#rl-mine-status')?.textContent||'').includes('已保存')`, 'saved');
    const saved = fs.readFileSync(personal, 'utf8');
    check(saved === '# 个人基础规则\r\n\r\n- 回复用中文。\r\n- 先给结论。\r\n', '保存后写回个人基础规则，换行保持 CRLF');
    const backups = path.join(home, '.agents', 'context-backups', 'hub');
    check(fs.existsSync(backups) && fs.readdirSync(backups).length === 1, '保存前先备份原文件');
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync(path.join(out, '07-personal-mine.png'), Buffer.from(s.data, 'base64')));
    console.log(`规则 Tab（个人基础规则）e2e：${checks.length} 项全部通过`);
  } catch (error) {
    console.error(error); process.exitCode = 1;
    try { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '98-personal-failure.png'), Buffer.from(s.data, 'base64')); } catch (_) {}
  } finally {
    try { cdp?.close?.(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(e => { console.error(e); process.exitCode = 1; });
  }
})();
