'use strict';
// 文件管理 · 极简 IDE 版式（mock ①）真机验收：隔离 Hub + CDP 真实鼠标 / 键盘。
// 覆盖：筛选菜单每一项、悬停「＋对话」只进草稿不发送、多选操作条、新鲜度绿点与刷新高亮、
// 本会话改动区、噪声目录降权、根目录下拉、路径复制、Ctrl+P / Enter / Ctrl+Enter、浅色主题。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function put(target, seconds, content = 'x') {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (seconds) fs.utimesSync(target, seconds, seconds);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-ide-'));
  const workspace = path.join(root, 'ide workspace'); const home = path.join(root, 'codex');
  const output = path.resolve(__dirname, '../artifacts/file-manager-ide', String(Date.now()));
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(workspace); fs.mkdirSync(home);
  const old = Math.floor(Date.now() / 1000) - 2 * 86400;
  const files = ['.env', 'data.json', 'script.js', 'notes.txt', 'plan.md', 'summary.md', 'report.md'];
  files.forEach((name, i) => put(path.join(workspace, name), old + i * 60, `# ${name}\n`));
  put(path.join(workspace, 'photo.png'), old - 60, PNG);
  const dirs = ['docs', 'src', 'artifacts', 'output', 'tests', 'lib', 'tools'];
  dirs.forEach((name, i) => put(path.join(workspace, name, 'a.txt'), old + i * 30));
  // 噪声目录：子树最新，但不应占文件夹前 5。
  put(path.join(workspace, '.git', 'index'), old + 7200);
  put(path.join(workspace, 'node_modules', 'pkg', 'index.js'), old + 7200);
  for (const name of [...dirs, '.git', 'node_modules', path.join('node_modules', 'pkg')]) fs.utimesSync(path.join(workspace, name), old, old);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\n');
  const result = { output, checks: [], screenshots: [], success: false };
  let hub, cdp;
  async function until(expression, label, timeout = 25000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await cdp.eval(expression)) return; await pause(100); }
    throw new Error(`timeout: ${label || expression}`);
  }
  async function center(expression) {
    return cdp.eval(`(() => {const e=${expression}; if(!e) throw Error('missing target: ' + ${JSON.stringify(expression)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  }
  async function hover(expression) {
    const p = await center(expression);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    return p;
  }
  async function click(expression, modifiers = 0) {
    const p = await center(expression);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1, modifiers });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1, modifiers });
  }
  async function key(name, code, keyCode, { modifiers = 0, text } = {}) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
  }
  async function capture(name) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(output, `${name}.png`); fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); result.screenshots.push(file);
  }
  const check = label => result.checks.push(label);
  async function withForcedHover(expression, action) {
    const { result: handle } = await cdp.send('Runtime.evaluate', { expression });
    await cdp.send('DOM.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.requestNode', { objectId: handle.objectId });
    await cdp.send('CSS.enable');
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    try { await action(); } finally { await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }); }
  }
  const row = name => `[...document.querySelectorAll('#file-manager-tree .fm-node:not(.fm-change-row)')].find(r=>r.querySelector('.fm-node-name').textContent===${JSON.stringify(name)})`;
  const changeRow = name => `[...document.querySelectorAll('#file-manager-tree .fm-change-row')].find(r=>r.querySelector('.fm-node-name').textContent===${JSON.stringify(name)})`;
  const treeNames = `[...document.querySelectorAll('#file-manager-tree .fm-node:not(.fm-change-row) .fm-node-name')].map(e=>e.textContent)`;
  const option = (key, value) => `document.querySelector('.fm-view-menu [data-fm-option="${key}"]${value ? `[data-value="${value}"]` : ''}')`;
  const composer = `document.querySelector('.floating-input-box').innerText`;
  async function menuPick(key, value) {
    if (!(await cdp.eval(`!!document.querySelector('.fm-view-menu')`))) await click(`document.getElementById('file-manager-view-menu')`);
    await until(`!!${option(key, value)}`, `menu option ${key}=${value}`);
    await click(option(key, value));
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await port(), label: 'file-manager-ide', windowMode: 'hidden', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!window.FileManagerPanel');
    const session = await cdp.eval(`ipcRenderer.invoke('create-session', ${JSON.stringify({ kind: 'codex', opts: { cwd: workspace, model: 'gpt-6-astra', mcpProfile: 'none' } })})`);
    await until(`!!document.querySelector('.session-item[data-session-id="${session.id}"]')`);
    await click(`document.querySelector('.session-item[data-session-id="${session.id}"]')`);
    await until(`!!document.querySelector('.btn-file-manager-toggle') && !!document.querySelector('.floating-input-box')`, 'session surface');
    result.spawnedAt = await cdp.eval(`sessions.get(${JSON.stringify(session.id)}).spawnedAt`);
    assert.ok(result.spawnedAt > 0, 'renderer session carries spawnedAt');
    await click(`document.querySelector('.btn-file-manager-toggle')`);
    await until(`document.querySelectorAll('#file-manager-tree .fm-group-header').length === 3`, 'three sections');
    await until(`document.querySelector('#file-manager-tree [data-group="changes"] .fm-group-count').textContent === '0'`, 'changes scanned');
    await until(`${treeNames}.includes('tools') && !!document.querySelector('.fm-file-time[data-activity]')`, 'folder activity');

    // 版式：单行 26px、默认修改时间降序、复选框与快捷操作默认不可见、底部状态一行。
    const layout = await cdp.eval(`(() => {
      const r = ${row('summary.md')};
      return { height: Math.round(r.querySelector('.fm-node-button').getBoundingClientRect().height),
        checkbox: getComputedStyle(r.querySelector('.fm-select')).opacity, actions: getComputedStyle(r.querySelector('.fm-row-actions')).display,
        footer: document.getElementById('file-manager-status').textContent, headerRows: document.querySelector('.file-manager-header').getBoundingClientRect().height,
        path: document.getElementById('file-manager-root-path').textContent, kbd: document.querySelector('.file-manager-kbd').textContent,
        selects: document.querySelectorAll('#file-manager-panel select').length };
    })()`);
    result.layout = layout;
    assert.equal(layout.height, 26); assert.equal(layout.checkbox, '0'); assert.equal(layout.actions, 'none');
    assert.match(layout.footer, /^\d+ 项 · 自动刷新/); assert.equal(layout.path, workspace); assert.equal(layout.kbd, 'Ctrl P');
    assert.equal(layout.selects, 0, 'no resident dropdowns: everything moved into the filter menu');
    const top = await cdp.eval(treeNames);
    assert.deepEqual(top.slice(0, 5), ['report.md', 'summary.md', 'plan.md', 'notes.txt', 'script.js']);
    check('single-line 26px rows, newest first, hover-only controls, one-line footer');
    // 噪声目录降权：.git / node_modules 子树最新，但不占文件夹前 5。
    const folderTop = await cdp.eval(`[...document.querySelectorAll('#file-manager-tree .fm-node-directory:not(.fm-change-row) .fm-node-name')].map(e=>e.textContent)`);
    assert.equal(folderTop.length, 5); assert.ok(!folderTop.includes('.git') && !folderTop.includes('node_modules'), folderTop.join(','));
    await click(`document.querySelector('.fm-group-toggle[data-group="folders"]')`);
    await until(`${treeNames}.slice(-2).sort().join() === '.git,node_modules'`, 'noise folders at the end');
    await click(`document.querySelector('.fm-group-toggle[data-group="folders"]')`);
    check('noise folders sink below the top 5 and to the end when expanded');
    await capture('01-default');

    // 本会话改动 + 新鲜度绿点：会话启动后新建 / 修改文件。
    put(path.join(workspace, 'fresh-output.md'), 0, '# new');
    put(path.join(workspace, 'docs', 'deep-change.md'), 0, '# deep');
    fs.appendFileSync(path.join(workspace, 'plan.md'), 'edited\n');
    await until(`!!${row('fresh-output.md')}`, 'auto refresh shows new file', 15000);
    result.flashSeen = await cdp.eval(`!!${row('fresh-output.md')}.classList.contains('fm-flash')`);
    await until(`!!${row('plan.md')} && ${row('plan.md')}.querySelector('.fm-fresh') !== null`, 'fresh dot on edited file');
    await click(`document.getElementById('file-manager-refresh')`);
    await until(`!!${changeRow('fresh-output.md')} && !!${changeRow('deep-change.md')} && !!${changeRow('plan.md')}`, 'session changes list');
    const changes = await cdp.eval(`({ count: document.querySelector('#file-manager-tree [data-group="changes"] .fm-group-count').textContent,
      relative: ${changeRow('deep-change.md')}.querySelector('.fm-relative').textContent,
      fresh: !!${row('fresh-output.md')}.querySelector('.fm-fresh'), oldFresh: !!${row('summary.md')}.querySelector('.fm-fresh') })`);
    result.changes = changes;
    assert.equal(changes.count, '3'); assert.equal(changes.relative, 'docs'); assert.equal(changes.fresh, true); assert.equal(changes.oldFresh, false);
    check('session changes lists files modified after spawn (incl. nested) with folder hint; fresh dot only on recent files');
    assert.equal(result.flashSeen, true, 'auto refresh highlights the new row once'); check('auto refresh flashes the new row');
    await capture('02-session-changes-fresh');
    await click(`document.querySelector('[data-fm-section-toggle="changes"]')`);
    await until(`!document.querySelector('#file-manager-tree .fm-change-row')`, 'changes collapsed');
    await click(`document.querySelector('[data-fm-section-toggle="changes"]')`);
    await until(`!!document.querySelector('#file-manager-tree .fm-change-row')`, 'changes expanded');
    check('section headers collapse and expand');

    // 悬停「＋对话」：只写进草稿，不发送。
    await hover(row('report.md'));
    assert.equal(await cdp.eval(`getComputedStyle(${row('report.md')}.querySelector('.fm-row-actions')).display`), 'flex');
    assert.equal(await cdp.eval(`getComputedStyle(${row('report.md')}.querySelector('.fm-file-details')).visibility`), 'hidden');
    assert.equal(await cdp.eval(`getComputedStyle(${row('report.md')}.querySelector('.fm-select')).opacity`), '1');
    // 截图会让后台窗口丢掉鼠标悬停；上面已用真实鼠标断言，截图时用 DevTools 强制 :hover 留证。
    await withForcedHover(row('report.md'), () => capture('03-hover-actions'));
    await hover(row('report.md'));
    await click(`${row('report.md')}.querySelector('.fm-quick-add')`);
    await until(`${composer}.includes(${JSON.stringify(path.join(workspace, 'report.md'))})`, 'quick add writes draft');
    await pause(1500);
    assert.ok(await cdp.eval(`${composer}.includes(${JSON.stringify(path.join(workspace, 'report.md'))})`), 'draft still there (not sent)');
    const turn = await cdp.eval(`(() => { const s = sessions.get(${JSON.stringify(session.id)}); return { turnId: s.nativeRuntime ? s.nativeRuntime.turnId : null, status: s.status }; })()`);
    assert.equal(turn.turnId || null, null);
    check('hover ＋对话 writes the path into the composer draft without sending');
    // 悬停「预览」
    await hover(row('report.md'));
    await click(`${row('report.md')}.querySelector('.fm-quick-preview')`);
    await until(`document.getElementById('preview-panel').style.display==='flex'`, 'preview opens');
    await click(`document.getElementById('preview-close')`);
    check('hover 预览 opens the Hub preview');

    // 多选：勾两个复选框 → 底部操作条 → 加入对话。
    await cdp.eval(`(() => { const box = document.querySelector('.floating-input-box'); box.textContent=''; box.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    assert.equal(await cdp.eval(`document.querySelector('.fm-selection-bar').hidden`), true);
    await hover(row('notes.txt')); await click(`${row('notes.txt')}.querySelector('.fm-select')`);
    await hover(row('summary.md')); await click(`${row('summary.md')}.querySelector('.fm-select')`);
    await until(`!document.querySelector('.fm-selection-bar').hidden && document.querySelector('.fm-selection-text').textContent.startsWith('已选 2 项')`, 'selection bar');
    assert.equal(await cdp.eval(`getComputedStyle(${row('report.md')}.querySelector('.fm-select')).opacity`), '1', 'checkboxes stay visible in multi-select');
    await capture('04-multiselect-bar');
    await click(`document.querySelector('[data-fm-bar="conversation"]')`);
    await until(`${composer}.includes(${JSON.stringify(path.join(workspace, 'notes.txt'))}) && ${composer}.includes(${JSON.stringify(path.join(workspace, 'summary.md'))})`, 'bar adds both');
    await click(`document.querySelector('.fm-bar-clear')`);
    await until(`document.querySelector('.fm-selection-bar').hidden`, 'bar hidden after clear');
    check('multi-select bar appears only with a selection and adds all paths to the draft');

    // 筛选菜单每一项。
    await click(`document.getElementById('file-manager-view-menu')`);
    await until(`!!document.querySelector('.fm-view-menu')`, 'view menu');
    await capture('05-filter-menu');
    await menuPick('sort', 'name');
    await until(`${treeNames}.slice(0,3).join() === '.env,data.json,fresh-output.md'`, 'name sort');
    await menuPick('direction');
    await until(`${treeNames}[0] === 'summary.md'`, 'name desc');
    await menuPick('sort', 'size');
    await until(`${option('sort', 'size')}.getAttribute('aria-checked') === 'true'`, 'size sort');
    assert.equal(await cdp.eval(`document.querySelector('.fm-group-sort').textContent`), '大小 ↓');
    await menuPick('sort', 'mtime');
    await until(`${treeNames}[0] === 'fresh-output.md' || ${treeNames}[0] === 'plan.md'`, 'mtime sort back');
    check('sort: 名称 / 升降序 / 大小 / 修改时间');
    await menuPick('type', 'image');
    await until(`(() => { const n = [...document.querySelectorAll('#file-manager-tree .fm-node-file:not(.fm-change-row) .fm-node-name')].map(e=>e.textContent); return n.length === 1 && n[0] === 'photo.png'; })()`, 'image filter');
    assert.equal(await cdp.eval(`document.getElementById('file-manager-view-menu').classList.contains('has-filter')`), true);
    await menuPick('type', 'document');
    await until(`!${treeNames}.includes('photo.png') && ${treeNames}.includes('report.md') && !${treeNames}.includes('script.js')`, 'document filter');
    await menuPick('type', 'all');
    check('type filter: 图片 / 文档 / 全部, filter icon marks non-default view');
    const filesCount = `document.querySelector('#file-manager-tree [data-group="files"] .fm-group-count').textContent`;
    const shownFiles = await cdp.eval(filesCount);
    await menuPick('showHidden');
    await until(`${filesCount} === String(${Number(shownFiles) - 1})`, 'hide dotfiles');
    await menuPick('showHidden');
    await until(`${filesCount} === ${JSON.stringify(shownFiles)}`, 'show dotfiles');
    check('隐藏项 toggle');
    await menuPick('type', 'image');
    await menuPick('thumbnails');
    await until(`!!${row('photo.png')} && !!${row('photo.png')}.querySelector('img.fm-thumbnail')`, 'thumbnail');
    await menuPick('thumbnails');
    await menuPick('type', 'all');
    check('缩略图 toggle');
    await menuPick('mode', 'recent');
    await until(`document.querySelectorAll('#file-manager-tree .fm-relative').length > 0 && document.querySelectorAll('#file-manager-tree .fm-group-header').length === 0`, 'recent mode flat list');
    await menuPick('mode', 'search');
    await key('Escape', 'Escape', 27);
    await cdp.eval(`(()=>{const input=document.getElementById('file-manager-filter');input.value='deep-change';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`(() => { const n = [...document.querySelectorAll('#file-manager-tree .fm-node-name')].map(e=>e.textContent); return n.length === 1 && n[0] === 'deep-change.md'; })()`, 'project search');
    await cdp.eval(`(()=>{const input=document.getElementById('file-manager-filter');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await menuPick('mode', 'tree');
    await key('Escape', 'Escape', 27);
    await until(`document.querySelectorAll('#file-manager-tree .fm-group-header').length === 3`, 'back to tree');
    check('浏览范围: 最近修改 / 项目搜索 / 目录树');

    // 根目录下拉：导航、收藏、产物目录、交付记录。
    await click(`document.getElementById('file-manager-root')`);
    await until(`!!document.querySelector('.fm-root-menu')`, 'root menu');
    const rootMenu = await cdp.eval(`[...document.querySelectorAll('.fm-root-menu button')].map(b=>b.textContent)`);
    result.rootMenu = rootMenu;
    for (const label of ['＋ 固定当前目录', 'artifacts', 'output', '新建文件夹…', '交付记录', '在资源管理器中打开']) assert.ok(rootMenu.includes(label), label);
    await capture('06-root-menu');
    await click(`document.querySelector('[data-fm-root-action="pin"]')`);
    await click(`document.getElementById('file-manager-root')`);
    await until(`[...document.querySelectorAll('.fm-root-menu button')].some(b=>b.textContent==='★ ide workspace')`, 'favorite listed');
    await click(`[...document.querySelectorAll('.fm-root-menu button')].find(b=>b.textContent==='artifacts')`);
    await until(`document.getElementById('file-manager-root-path').textContent === ${JSON.stringify(path.join(workspace, 'artifacts'))}`, 'navigate to artifacts');
    await click(`document.getElementById('file-manager-root')`);
    await until(`!!document.querySelector('[data-fm-nav="back"]:not(:disabled)')`, 'back enabled');
    await click(`document.querySelector('[data-fm-nav="back"]')`);
    await until(`document.getElementById('file-manager-root-path').textContent === ${JSON.stringify(workspace)}`, 'back to workspace');
    await click(`document.getElementById('file-manager-root')`);
    await click(`document.querySelector('[data-fm-root-action="jobs"]')`);
    await until(`!document.querySelector('.fm-jobs').hidden`, 'jobs panel');
    await click(`document.getElementById('file-manager-root')`);
    await click(`document.querySelector('[data-fm-root-action="jobs"]')`);
    check('root dropdown: pin favorite, artifacts shortcut, back navigation, 交付记录');

    // 路径点击复制（隔离实例用内存剪贴板）。
    await click(`document.getElementById('file-manager-root-path')`);
    await until(`document.getElementById('file-manager-status').textContent === '已复制路径'`, 'copy path');
    check('path line copies on click');

    // 键盘：Ctrl+P 聚焦筛选框；Enter 预览；Ctrl+Enter 加入对话。
    await until(`document.querySelectorAll('#file-manager-tree .fm-group-header').length === 3 && !!${row('tools')}`, 'tree ready');
    await click(`${row('tools')}.querySelector('.fm-node-button')`);
    await until(`${row('tools')}.querySelector('.fm-node-button').getAttribute('aria-expanded') === 'true'`, 'tools expanded');
    await key('p', 'KeyP', 80, { modifiers: 2 });
    assert.equal(await cdp.eval(`document.activeElement === document.getElementById('file-manager-filter')`), true);
    check('Ctrl+P focuses the filter when focus is inside the panel');
    await cdp.eval(`${row('tools')}.querySelector('.fm-node-button').focus()`);
    await key('ArrowDown', 'ArrowDown', 40);
    const focused = await cdp.eval(`document.activeElement.closest('.fm-node')?.querySelector('.fm-node-name').textContent`);
    result.keyboardFocused = focused;
    await cdp.eval(`(() => { const box = document.querySelector('.floating-input-box'); box.textContent=''; box.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await cdp.eval(`${row('tools')}.querySelector('.fm-node-button').focus()`);
    await key('ArrowDown', 'ArrowDown', 40);
    const focusedPath = await cdp.eval(`document.activeElement.closest('[data-fm-node]')?.dataset.path || ''`);
    assert.ok(focusedPath && focusedPath !== path.join(workspace, 'tools'), 'ArrowDown moved focus off the clicked row');
    await key('Enter', 'Enter', 13, { modifiers: 2, text: String.fromCharCode(13) });
    await until(`${composer}.includes(${JSON.stringify(focusedPath)})`, 'ctrl+enter adds focused path');
    assert.equal(await cdp.eval(`${composer}.split(${JSON.stringify(focusedPath)}).join('').includes(${JSON.stringify(path.join(workspace, 'tools'))})`), false, 'previously clicked row is not added');
    check(`Ctrl+Enter adds the focused row (${focused}) to the draft`);
    await cdp.eval(`${row('report.md')}.querySelector('.fm-node-button').focus()`);
    await key('Enter', 'Enter', 13, { text: String.fromCharCode(13) });
    await until(`document.getElementById('preview-panel').style.display==='flex'`, 'enter previews');
    await click(`document.getElementById('preview-close')`);
    check('Enter previews the focused file');

    // 浅色主题。
    await cdp.eval(`document.documentElement.setAttribute('data-theme', 'hub')`);
    await pause(300);
    // color-mix() 的计算值是 color(srgb 0–1 …)，普通颜色是 rgb(0–255 …)，统一换算到 0–255。
    const light = await cdp.eval(`(() => {
      const rgb = v => { const n = v.match(/[\\d.]+/g).map(Number).slice(0, 3); return v.startsWith('color(') ? n.map(x => Math.round(x * 255)) : n; };
      return { bg: rgb(getComputedStyle(document.getElementById('file-manager-panel')).backgroundColor),
        text: rgb(getComputedStyle(${row('report.md')}.querySelector('.fm-node-name')).color) }; })()`);
    result.light = light;
    assert.ok(light.bg[0] > 200 && light.bg[1] > 200 && light.bg[2] > 200, `light background ${light.bg}`);
    assert.ok(light.text[0] < 110, `dark text on light theme ${light.text}`);
    await withForcedHover(row('summary.md'), () => capture('07-light-theme'));
    check('light theme uses theme variables (light panel, dark text)');
    result.success = true;
  } catch (error) { result.error = error.stack; if (cdp) await capture('failure').catch(() => {}); throw error; }
  finally {
    if (hub) fs.writeFileSync(path.join(output, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close(); if (hub) result.exit = await gracefulQuit(hub);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
