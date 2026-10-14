'use strict';
// 整理桌面·一键收纳（2026-10-14 用户：不要逐项打勾，自动按类型归纳、一键收纳；最多给一个选项）。
// 隔离 Hub + 模拟桌面（HUB_DESKTOP_ORGANIZER_TEST_ROOT），真实鼠标点击：
//   ① 打开即扫描：显示将收走几项、各类型多少、桌面保留几个快捷方式；没有勾选框；
//   ② 切到「全部收走」：数量包含快捷方式；切回「保留快捷方式」；
//   ③ 一键收纳：资料按类型进归档子文件夹（文档/表格/图片/文件夹/公共桌面…），快捷方式留在桌面，图标自动排齐；
//   ④ 撤销上次收纳：全部还原。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function wait(client, expression, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await client.eval(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('界面等待超时：' + expression);
}
async function click(client, selector) {
  const rect = await client.eval(`(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); if(nodes.length !== 1) throw new Error('按钮不唯一：'+${JSON.stringify(selector)}); const r=nodes[0].getBoundingClientRect(); if(!r.width||!r.height) throw new Error('按钮不可见'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}
const exists = file => fs.access(file).then(() => true, () => false);
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-desktop-e2e-'));
  const out = path.resolve(process.env.E2E_OUT || path.join(__dirname, '..', 'artifacts', '20261014-desktop-one-click-claude1'));
  await fs.mkdir(out, { recursive: true });
  const testRoot = path.join(temp, 'fixture'), desktop = path.join(testRoot, 'Desktop'), publicDesktop = path.join(testRoot, 'PublicDesktop');
  await fs.mkdir(desktop, { recursive: true }); await fs.mkdir(publicDesktop, { recursive: true });
  const files = { '季度汇报.pptx': 'ppt', '需求说明.docx': 'doc', '预算.xlsx': 'xls', '截图1.png': 'png', '截图2.jpg': 'jpg', '资料包.zip': 'zip', '笔记.txt': 'txt', '未知.dat': 'dat' };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(desktop, name), body);
  await fs.mkdir(path.join(desktop, '项目资料')); await fs.writeFile(path.join(desktop, '项目资料', 'a.md'), 'a');
  for (const name of ['Excel.lnk', 'WeLink.lnk', 'startup.bat']) await fs.writeFile(path.join(desktop, name), 'launcher');
  await fs.writeFile(path.join(publicDesktop, '公共通知.pdf'), 'pdf');
  await fs.writeFile(path.join(publicDesktop, 'Edge.lnk'), 'launcher');
  const hub = await launchIsolatedHub({ dataDir: path.join(temp, 'hub-data'), port: await freePort(), label: 'desktop-organizer', windowMode: 'hidden', extraEnv: { CLAUDE_HUB_E2E: '1', HUB_DESKTOP_ORGANIZER_TEST_ROOT: testRoot } });
  let client;
  const checks = [];
  const check = (ok, label) => { assert.ok(ok, label); checks.push(label); console.log('  ✓ ' + label); };
  const shot = async name => { const s = await client.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const panelText = `document.getElementById('desktop-organizer-panel').innerText`;
  try {
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(client, "Boolean(document.getElementById('desktop-organizer-panel'))", 60000);

    // ① 打开即扫描
    await click(client, '#btn-desktop-organizer');
    await wait(client, "!!document.querySelector('#desktop-organizer-panel .do-count b')");
    const first = await client.eval(`({count:document.querySelector('#desktop-organizer-panel .do-count b').textContent, chips:[...document.querySelectorAll('#desktop-organizer-panel .do-summary .do-chip')].map(c=>c.textContent), checkboxes:document.querySelectorAll('#desktop-organizer-panel input[type=checkbox]').length, text:${panelText}})`);
    check(first.checkboxes === 0, '面板里没有逐项勾选框');
    check(first.count === '10', `默认「保留快捷方式」：将收走 10 项资料（${first.chips.join('、')}）`);
    check(first.chips.includes('文档2') && first.chips.includes('图片2') && first.chips.includes('文件夹1') && first.chips.includes('PDF1') && !first.chips.some(c => c.startsWith('快捷方式')), '按类型归纳：文档 2、图片 2、文件夹 1、PDF 1…，快捷方式不在其中');
    check(first.text.includes('桌面保留 4 个快捷方式'), '写明桌面保留 4 个快捷方式');
    await shot('01-summary');

    // ② 切换收纳方式
    await click(client, '#desktop-organizer-panel [data-mode="all"]');
    await wait(client, "document.querySelector('#desktop-organizer-panel .do-count b').textContent==='14'");
    check(await client.eval(`[...document.querySelectorAll('#desktop-organizer-panel .do-chip')].some(c=>c.textContent==='快捷方式4')`), '切到「全部收走」：14 项，含快捷方式 4');
    await shot('02-mode-all');
    await click(client, '#desktop-organizer-panel [data-mode="keep-launchers"]');
    await wait(client, "document.querySelector('#desktop-organizer-panel .do-count b').textContent==='10'");

    // ③ 一键收纳
    await click(client, '#desktop-organizer-panel [data-do="execute"]');
    await wait(client, "!!document.querySelector('#desktop-organizer-panel .do-done')");
    const doneText = await client.eval(panelText);
    check(doneText.includes('已收纳 10 项') && doneText.includes('图标已排齐'), '一键收纳：已收纳 10 项，并自动排齐图标');
    const archiveRoot = path.join(testRoot, 'Desktop-Archive');
    const batch = (await fs.readdir(archiveRoot)).find(name => /^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{8}$/.test(name));
    check(!!batch, `归档批次文件夹名一眼看得懂：${batch}`);
    const at = (...parts) => path.join(archiveRoot, batch, ...parts);
    check(await exists(at('演示', '季度汇报.pptx')) && await exists(at('文档', '需求说明.docx')) && await exists(at('表格', '预算.xlsx'))
      && await exists(at('图片', '截图1.png')) && await exists(at('压缩包', '资料包.zip')) && await exists(at('其他', '未知.dat'))
      && await exists(at('文件夹', '项目资料', 'a.md')) && await exists(at('PDF', '公共桌面', '公共通知.pdf')), '资料进了按类型分的子文件夹（公共桌面的单独一层）');
    check(await exists(path.join(desktop, 'Excel.lnk')) && await exists(path.join(desktop, 'startup.bat')) && await exists(path.join(publicDesktop, 'Edge.lnk')) && !(await exists(path.join(desktop, '季度汇报.pptx'))), '快捷方式留在桌面，资料已离开桌面');
    await shot('03-done');

    // ④ 撤销
    await click(client, '#desktop-organizer-panel [data-do="undo"]');
    await wait(client, `${panelText}.includes('已撤销上次收纳，还原 10 项')`);
    check(await fs.readFile(path.join(desktop, '季度汇报.pptx'), 'utf8') === 'ppt' && await exists(path.join(publicDesktop, '公共通知.pdf')), '撤销上次收纳：10 项全部还原到原位置');
    await shot('04-undo');
    await click(client, '#desktop-organizer-panel .do-primary[data-do="close"]');
    check(await client.eval("document.getElementById('desktop-organizer-panel').hidden"), '点「完成」关闭面板');
    await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ ok: true, checks, layout: 'simulated fixture; native desktop arrangement verified separately' }, null, 2));
    console.log(`PASS e2e-desktop-organizer (${checks.length} checks)`);
  } finally {
    if (client) await client.close(); await gracefulQuit(hub);
    try { await fs.rm(temp, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
