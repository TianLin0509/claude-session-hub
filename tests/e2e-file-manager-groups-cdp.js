'use strict';
// 文件管理：默认按修改时间降序、文件组在前、每组前 5 个 + 展开行；
// 文件夹按子树最近改动排序；自动刷新后展开状态仍在。真实隔离 Hub + CDP 鼠标/键盘。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }
function touch(target, seconds, content = 'x') {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.utimesSync(target, seconds, seconds);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-groups-'));
  const workspace = path.join(root, '分组 workspace'); const home = path.join(root, 'codex');
  const output = path.resolve(__dirname, '../artifacts/file-manager-groups', String(Date.now()));
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(workspace); fs.mkdirSync(home);
  const base = Math.floor(Date.now() / 1000) - 86400;
  // 8 个文件：f7 最新 … f0 最旧。
  for (let i = 0; i < 8; i++) touch(path.join(workspace, `file-${i}.md`), base + i * 60, `# ${i}`);
  // 7 个文件夹：自身 mtime 都旧；d-deep 的深层文件最新，应排第一。
  for (let i = 0; i < 6; i++) touch(path.join(workspace, `dir-${i}`, 'a.txt'), base + i * 60);
  touch(path.join(workspace, 'dir-deep', 'x', 'y', 'fresh.md'), base + 3600);
  for (const name of fs.readdirSync(workspace)) {
    const full = path.join(workspace, name);
    if (fs.statSync(full).isDirectory()) {
      for (const sub of ['x', 'x/y']) if (fs.existsSync(path.join(full, sub))) fs.utimesSync(path.join(full, sub), base - 500, base - 500);
      // 自身 mtime 故意与子树活动反序：只看自身 mtime 时 dir-0 最新、dir-deep 最旧。
      const own = name === 'dir-deep' ? base - 5000 : base - 1000 + (5 - Number(name.slice(4))) * 10;
      fs.utimesSync(full, own, own);
    }
  }
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\n');
  const result = { output, checks: [], success: false };
  let hub, cdp;
  async function until(expression, label, timeout = 25000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await cdp.eval(expression)) return; await pause(120); }
    throw new Error(`timeout: ${label || expression}`);
  }
  async function click(expression) {
    const p = await cdp.eval(`(() => {const e=${expression}; if(!e) throw Error('missing click target'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  }
  async function key(name, code, keyCode, text) {
    // 回车需带 text，Chromium 才会像真键盘一样激活聚焦的按钮。
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode });
  }
  async function capture(name) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  const rootRows = `(() => { const out = []; for (const el of document.getElementById('file-manager-tree').children) {
      if (el.classList.contains('fm-group-header')) out.push('#' + el.dataset.group + ':' + el.querySelector('.fm-group-count').textContent);
      else if (el.classList.contains('fm-group-toggle-row')) out.push('>' + el.querySelector('button').textContent);
      else if (el.classList.contains('fm-node')) out.push(el.querySelector('.fm-node-name').textContent); }
    return out; })()`;
  const toggle = group => `document.querySelector('.fm-group-toggle[data-group="${group}"]')`;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), label: 'file-manager-groups', windowMode: 'hidden', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!window.FileManagerPanel');
    assert.equal(await cdp.eval(`localStorage.getItem('hub-file-manager-v2')`), null, 'fresh isolated profile has no saved sort preference');
    const session = await cdp.eval(`ipcRenderer.invoke('create-session', ${JSON.stringify({ kind: 'codex', opts: { cwd: workspace, model: 'gpt-6-astra', mcpProfile: 'none' } })})`);
    await until(`!!document.querySelector('.session-item[data-session-id="${session.id}"]')`);
    await click(`document.querySelector('.session-item[data-session-id="${session.id}"]')`);
    await until(`!!document.querySelector('.btn-file-manager-toggle')`, 'files button');
    await click(`document.querySelector('.btn-file-manager-toggle')`);
    await until(`document.getElementById('file-manager-panel').style.display === 'flex'`, 'panel open');
    await until(`document.querySelectorAll('.fm-group-header').length === 2`, 'group headers');
    assert.equal(await cdp.eval(`document.querySelector('select[aria-label="排序"]').value`), 'mtime');
    result.checks.push('fresh profile defaults to mtime sort');

    // 等子树活动算完：dir-deep 被排到文件夹组第一。
    await until(`(${rootRows}).indexOf('dir-deep') === (${rootRows}).indexOf('#folders:7') + 1`, 'subtree activity re-rank');
    const rows = await cdp.eval(rootRows);
    result.initialRows = rows;
    assert.deepEqual(rows, [
      '#files:8', 'file-7.md', 'file-6.md', 'file-5.md', 'file-4.md', 'file-3.md', '>显示全部 8 个文件（还有 3 个）',
      '#folders:7', 'dir-deep', 'dir-5', 'dir-4', 'dir-3', 'dir-2', '>显示全部 7 个文件夹（还有 2 个）',
    ]);
    result.checks.push('files group first, newest 5 each, folder ranked by deep change');
    const deepTitle = await cdp.eval(`[...document.querySelectorAll('.fm-node')].find(n=>n.querySelector('.fm-node-name').textContent==='dir-deep').querySelector('.fm-file-time').title`);
    assert.match(deepTitle, /子树最近改动：x[\\/]y[\\/]fresh\.md/);
    result.checks.push('folder time tooltip names the deep file');
    await capture('01-default-groups');

    await click(toggle('files'));
    await until(`document.querySelectorAll('.fm-node-name').length === 8 + 5`, 'files expanded');
    assert.equal(await cdp.eval(`${toggle('files')}.textContent`), '收起文件，只显示前 5 个');
    assert.equal(await cdp.eval(`document.activeElement === ${toggle('files')}`), true, 'focus stays on the toggle');
    result.checks.push('click expands all files; focus retained');

    // 键盘：从文件组展开行按 ↓ 走到文件夹行，再走到文件夹展开行，回车展开。
    for (let i = 0; i < 6; i++) await key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await cdp.eval(`document.activeElement === ${toggle('folders')}`), true, 'arrow keys reach the folder toggle');
    await key('Enter', 'Enter', 13, String.fromCharCode(13));
    await until(`document.querySelectorAll('.fm-node-name').length === 8 + 7`, 'folders expanded by keyboard');
    result.checks.push('keyboard arrows + Enter reach and trigger the group toggle');

    // 自动刷新（4 秒）后展开状态仍在，新文件出现并排到最前。
    touch(path.join(workspace, 'new-after-open.md'), Math.floor(Date.now() / 1000));
    await until(`[...document.querySelectorAll('.fm-node-name')].some(e=>e.textContent==='new-after-open.md')`, 'auto refresh', 15000);
    const after = await cdp.eval(rootRows);
    assert.equal(after[1], 'new-after-open.md');
    assert.equal(after.filter(r => !r.startsWith('#') && !r.startsWith('>')).length, 9 + 7);
    assert.ok(after.includes('>收起文件，只显示前 5 个') && after.includes('>收起文件夹，只显示前 5 个'));
    result.checks.push('auto refresh keeps expanded groups and ranks the new file first');
    await capture('02-expanded-after-refresh');

    await click(toggle('files'));
    await until(`${toggle('files')}.textContent === '显示全部 9 个文件（还有 4 个）'`, 'collapse files');
    result.checks.push('collapse returns to top 5');

    // 有筛选词时不截断。
    await cdp.eval(`(()=>{const input=document.getElementById('file-manager-filter');input.value='file-';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`document.querySelectorAll('.fm-node-name').length === 8 && !document.querySelector('.fm-group-toggle[data-group="files"]')`, 'filter shows all matches');
    result.checks.push('filter keyword shows every match without the cut');
    await capture('03-filter-no-cut');
    result.success = true;
  } catch (error) { result.error = error.stack; if (cdp) await capture('failure').catch(() => {}); throw error; }
  finally {
    if (hub) fs.writeFileSync(path.join(output, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close(); if (hub) result.exit = await gracefulQuit(hub);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
