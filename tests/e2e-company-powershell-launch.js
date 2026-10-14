'use strict';
// 真实验收：公司版启动中心有 PowerShell（2026-10-14 用户：PowerShell 公司也能用）。
//   ① 启动中心 →「新建会话」：只列 CodeAgent 与 PowerShell，CodeAgent 排第一并默认选中；
//   ② 点 PowerShell → 创建：侧栏出现 PowerShell 会话，终端里出现提示符；
//   ③ 在终端里真实打字执行一条命令，输出回到终端。
// E2E_ENTRY 指向公司版导出目录（目录里要有指向生产依赖的 node_modules 链接）；不设时跑主仓库，只验证 ②③。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const COMPANY = !!process.env.E2E_ENTRY;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-ps-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261014-company-powershell-claude1'); fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data'), work = path.join(root, 'work');
  for (const d of [dataDir, work]) fs.mkdirSync(d, { recursive: true });
  const result = { company: COMPANY, checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await c.eval(expr); if (v) return v; } catch (_) {} await sleep(300); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'company powershell',
      ...(COMPANY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'cac'), CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
        AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]) } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!window.LaunchCenter', 'renderer');
    result.version = await c.eval(`document.getElementById('hub-version')?.textContent || ''`);
    result.product = await c.eval(`document.querySelector('#hub-identity strong')?.textContent || ''`);

    // ① 启动中心 → 新建会话
    await click('#btn-new');
    await until(`document.getElementById('new-session-menu').style.display === 'flex'`, 'launch center', 15000);
    await click('[data-launch-intent="session"]');
    await until(`!!document.querySelector('.new-session-option[data-kind="powershell"]')?.offsetParent`, 'powershell option', 10000);
    const options = JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('.new-session-option[data-kind]')].filter(b=>b.offsetParent).map(b=>({kind:b.dataset.kind,text:b.textContent.trim(),selected:b.classList.contains('selected')})))`));
    result.options = options;
    await shot('01-launch-center');
    if (COMPANY) {
      check(result.product === 'AI HUB-Huawei', `跑的是公司版（${result.product} ${result.version}）`);
      check(j(options.map(o => o.kind)) === j(['codeagent', 'powershell']), `新建会话只列 CodeAgent 与 PowerShell（${options.map(o => o.text).join('、')}）`);
      check(options[0].selected, 'CodeAgent 排第一并默认选中');
    } else {
      check(options.some(o => o.kind === 'powershell'), '主仓库启动中心有 PowerShell');
    }

    // ② 点 PowerShell → 创建
    await click('.new-session-option[data-kind="powershell"]');
    const before = JSON.parse(await c.eval(`require('electron').ipcRenderer.invoke('get-sessions').then(list => JSON.stringify(list.map(s => s.id)))`));
    await click('#new-session-submit');
    const created = await until(`require('electron').ipcRenderer.invoke('get-sessions').then(list => list.find(s => s.kind === 'powershell' && !${j(before)}.includes(s.id)) || null)`, 'powershell session', 30000);
    check(!!created, `创建了 PowerShell 会话（${created.title || created.id}）`);
    await until(`document.getElementById('new-session-menu').style.display === 'none'`, 'center closed', 10000);
    // 终端用 canvas 绘制，文字从 xterm 的缓冲区读（和其他终端验收一样）。
    const termText = `(()=>{const t=terminalCache.get(${j(created.id)})?.terminal;if(!t)return '';const b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join(String.fromCharCode(10));})()`;
    // 提示符随本机 PowerShell 配置变（默认 PS C:\>，装了美化主题就不是），只看终端出现了内容；能不能用看下一步执行命令。
    await until(`${termText}.trim().length > 0`, 'prompt', 30000);
    check(true, '终端里出现了 PowerShell 提示符');
    await shot('02-powershell-session');

    // ③ 真实打字：在终端输入框里键入命令并回车
    assert.ok(await c.eval(`(()=>{const t=terminalCache.get(${j(created.id)})?.terminal;if(!t)return false;t.focus();return document.activeElement?.classList.contains('xterm-helper-textarea');})()`), '终端拿到键盘焦点');
    await c.send('Input.insertText', { text: 'Write-Output ("hub-ps-" + (6*7))' });
    await sleep(300);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`/^hub-ps-42\\s*$/m.test(${termText})`, 'command output', 20000);
    check(true, '在终端里键入命令执行，输出 hub-ps-42');
    await shot('03-powershell-command');
    result.passed = true;
  } catch (error) {
    try { await shot('failure'); result.screen = await c.eval(`document.body.innerText.slice(0, 1500)`); } catch (_) {}
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), j(result, null, 2));
    try { if (hub) await gracefulQuit(hub); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`e2e-company-powershell-launch: OK (${result.checks.length} checks)`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
