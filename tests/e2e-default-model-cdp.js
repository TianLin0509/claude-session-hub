'use strict';
// 新建会话面板「设为默认模型」的真实 GUI 证据。
// 跑：node tests/e2e-default-model-cdp.js
//
// 单测只能证明纯函数对；这一条证明的是另外几件事：按钮真的渲染出来了、点击
// 真的把值写进了隔离实例的 config.json、关掉面板重开之后预选真的变了。
// 三者任何一环断掉，用户看到的就还是每次回到出厂默认。

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-default-model-'));
  const dataDir = path.join(root, 'data');
  const checks = [];
  let hub;
  let cdp;

  const until = async (expr, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await cdp.eval(expr)) return;
      await sleep(100);
    }
    throw new Error('timeout: ' + label);
  };

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port: await freePort(),
      windowMode: 'hidden',
      label: 'default-model',
      extraEnv: { CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
    });
    cdp = await connectFirstPage(hub);
    await until("typeof ipcRenderer !== 'undefined' && !!window.WorkspaceController", 'renderer');

    const openPanel = async () => {
      await cdp.eval('window.WorkspaceController.openNewSessionModal({kind:"claude"})');
      await until('!!document.getElementById("new-session-model")?.options.length', 'model options');
      // 打开时会异步重读配置再 paint，等那一轮落定。
      await sleep(400);
    };
    const btn = 'document.getElementById("new-session-model-default")';
    const sel = 'document.getElementById("new-session-model")';

    // ① 初始状态：预选出厂默认，按钮显示「默认 ✓」且不可点。
    await openPanel();
    const initialModel = await cdp.eval(`${sel}.value`);
    assert.equal(initialModel, 'claude-opus-5[1m]', '首次应预选出厂默认模型');
    assert.equal(await cdp.eval(`${btn}.hidden`), false, '按钮应当可见');
    assert.equal(await cdp.eval(`${btn}.textContent`), '默认 ✓');
    assert.equal(await cdp.eval(`${btn}.disabled`), true, '已是默认时不可再点');
    checks.push('初始预选出厂默认，按钮显示「默认 ✓」且禁用');

    // ② 改选另一个模型：按钮应变成可点的「设为默认」。
    const target = 'claude-sonnet-5';
    await cdp.eval(`(()=>{const s=${sel};s.value=${JSON.stringify(target)};`
      + 's.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await until(`${btn}.textContent === '设为默认'`, '按钮转为可设置态');
    assert.equal(await cdp.eval(`${btn}.disabled`), false);
    checks.push('改选非默认模型后按钮变为可点的「设为默认」');

    // ③ 点击，等按钮回到「默认 ✓」。
    await cdp.eval(`${btn}.click()`);
    await until(`${btn}.textContent === '默认 ✓' && ${btn}.disabled === true`, '设置生效');
    // 点击不该触发 label 的默认行为把下拉值改掉。
    assert.equal(await cdp.eval(`${sel}.value`), target, '点击后选中的模型不应被改动');
    checks.push('点击「设为默认」后按钮转为「默认 ✓」，选中项未被 label 行为干扰');

    // 留一张视觉证据：模型那一行长什么样。UI 改动光有断言不够，得能看见。
    try {
      const outDir = path.resolve('artifacts/default-model');
      fs.mkdirSync(outDir, { recursive: true });
      const box = await cdp.eval('(()=>{const f=document.getElementById("new-session-model")'
        + '.closest(".session-tuning-field").getBoundingClientRect();'
        + 'return JSON.stringify({x:Math.max(0,f.x-8),y:Math.max(0,f.y-8),'
        + 'width:f.width+16,height:f.height+16});})()');
      const clip = { ...JSON.parse(box), scale: 2 };
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
      const file = path.join(outDir, 'model-field-set-default.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('截图：' + file);
    } catch (error) {
      console.warn('截图失败（不影响判定）：', error && error.message);
    }

    // ④ 真的落盘了吗 —— 直接读隔离实例的 config.json。
    const configPath = path.join(dataDir, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.models.defaults.claude, target, 'config.json 应写入 models.defaults.claude');
    checks.push('config.json 的 models.defaults.claude 已写入 ' + target);

    // ⑤ 关掉面板重开：预选应当是新默认值，而不是回到出厂默认。这一步才是
    //    用户真正要的效果。
    await cdp.eval('window.WorkspaceController.closeNewSessionModal?.()');
    await sleep(200);
    await openPanel();
    assert.equal(await cdp.eval(`${sel}.value`), target, '重开面板应预选用户设的默认模型');
    assert.equal(await cdp.eval(`${btn}.textContent`), '默认 ✓');
    checks.push('关闭后重开面板，预选为用户设定的 ' + target);

    // ⑥ 切到 Codex 再切回来：per-CLI 独立，Codex 不该被 Claude 的默认值污染。
    await cdp.eval('window.WorkspaceController.openNewSessionModal({kind:"codex"})');
    await until('!!document.getElementById("new-session-model")?.options.length', 'codex options');
    await sleep(400);
    const codexModel = await cdp.eval(`${sel}.value`);
    assert.ok(codexModel.startsWith('gpt-'), 'Codex 应保持自己的模型，实际：' + codexModel);
    checks.push('切到 Codex 时模型仍是 Codex 自己的 ' + codexModel);

    // ⑦ 打开面板后立刻手选，异步回读配置不得把用户的选择改掉。
    //    （审查发现的竞态：原实现拿「当前值是否等于出厂默认」当判据，用户手选的
    //     模型若恰好等于出厂默认就会被悄悄改写。）
    await cdp.eval('window.WorkspaceController.openNewSessionModal({kind:"claude"})');
    await until('!!document.getElementById("new-session-model")?.options.length', 'claude options');
    await cdp.eval('(()=>{const s=' + sel + ';s.value="claude-opus-5[1m]";'
      + 's.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await sleep(700);  // 盖过异步回读 + paint
    assert.equal(await cdp.eval(`${sel}.value`), 'claude-opus-5[1m]',
      '异步回读配置不得覆盖用户刚手选的模型');
    checks.push('打开面板后手选的模型不被异步回读覆盖');

    // ⑧ 重启 Hub，**完全不打开新建会话面板**，直接问 resolveSessionTuning ——
    //    群聊/圆桌成员走的就是它。默认模型如果只在打开面板时才加载，这里拿到的
    //    会是出厂默认，成员就享受不到用户设的默认值。必须重启验证，因为上面那些
    //    步骤已经把配置加载过了，在同一个实例里测不出这个缺陷。
    await gracefulQuit(hub);
    hub = await launchIsolatedHub({
      dataDir,
      port: await freePort(),
      windowMode: 'hidden',
      label: 'default-model-restart',
      extraEnv: { CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
    });
    cdp = await connectFirstPage(hub);
    await until("typeof ipcRenderer !== 'undefined' && !!window.WorkspaceController", 'renderer restart');
    // 装个探针证明这一段确实没打开过面板。不能拿「下拉有没有选项」当判据 ——
    // 那个 select 是 index.html 里的静态元素，启动时的 paint() 就把它填好了，
    // 跟面板开没开无关。
    await cdp.eval('(()=>{window.__panelOpened=false;'
      + 'const original=window.WorkspaceController.openNewSessionModal;'
      + 'window.WorkspaceController.openNewSessionModal=function(...args){'
      + 'window.__panelOpened=true;return original.apply(this,args);};})()');
    // 等模块加载时那次拉取落定，但全程不碰新建会话面板。
    await until('window.WorkspaceController.resolveSessionTuning("claude","",{}).model === '
      + JSON.stringify(target), '群聊路径拿到用户设的默认模型', 15000);
    assert.equal(await cdp.eval('window.__panelOpened'), false,
      '本段不应打开过新建会话面板，否则证明不了「面板之外也生效」');
    checks.push('重启后未开面板，群聊走的 resolveSessionTuning 直接拿到 ' + target);

    console.log('\n通过的检查项：');
    for (const c of checks) console.log('  ✔ ' + c);
    console.log('\nE2E PASS');
    return 0;
  } catch (error) {
    console.error('\nE2E FAIL:', error && error.message ? error.message : error);
    console.error('已通过：', checks);
    return 1;
  } finally {
    if (hub) { try { await gracefulQuit(hub); } catch (_) {} }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(code => process.exit(code));
