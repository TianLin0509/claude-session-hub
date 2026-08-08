'use strict';
// 记忆面板 + 梦境系统真实 CDP E2E。
// 隔离 Hub（CLAUDE_HUB_DATA_DIR=临时目录，port 9377）里验证：
//   委托点击打开面板 → 四页签 → 真实 IPC（overview/changelog/config/run-now/save-config）
//   → 设置保存落盘 → Esc 关闭。不碰生产 Hub：PID 白名单 + gracefulQuit。
//
// 用法：node tests/e2e-memory-panel-cdp.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const PORT = 9377;
const SHOT_DIR = 'C:/VibeData/Artifacts/Reports';

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mem-e2e-'));
  const results = [];
  let fails = 0;
  const ok = (cond, msg) => { results.push((cond ? '  ok   ' : ' FAIL ') + msg); if (!cond) fails++; };

  // 静态契约：用量 ticker 渲染里有「记忆」按钮（account-usage-controller.js）。
  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'account-usage-controller.js'), 'utf8');
  ok(controllerSrc.includes('data-action="open-memory"'), '0.1 ticker render 含 open-memory 按钮');
  ok(controllerSrc.includes('qt-memory'), '0.2 ticker 按钮带 qt-memory 样式类');

  // 双保险：home 指到隔离目录（防 memory 孤岛采集扫真实 home、蒸馏写真实三件套），
  // 并清空 DEEPSEEK_API_KEY（env 优先级高于 config.json，父进程的 key 会漏进隔离实例）。
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mem-e2e-home-'));
  // fake home 夹具：规范库 2 文件 + 一个 2 文件的孤岛桶（测二级展开与一键并入）。
  const { projectSlug } = require('../core/claude-transcript-locator.js');
  const canonicalDir = path.join(fakeHome, '.claude', 'projects', projectSlug(fakeHome), 'memory');
  fs.mkdirSync(canonicalDir, { recursive: true });
  fs.writeFileSync(path.join(canonicalDir, 'MEMORY.md'), '# 规范库\n', 'utf8');
  fs.writeFileSync(path.join(canonicalDir, 'feedback_a.md'), '偏好 A\n', 'utf8');
  const islandDir = path.join(fakeHome, '.claude', 'projects', projectSlug('C:/Vibe/_scratch/inbox-e2e'), 'memory');
  fs.mkdirSync(islandDir, { recursive: true });
  fs.writeFileSync(path.join(islandDir, 'only1.md'), '独有记忆 1\n', 'utf8');
  fs.writeFileSync(path.join(islandDir, 'only2.md'), '独有记忆 2\n', 'utf8');
  const hub = await launchIsolatedHub({
    dataDir,
    port: PORT,
    label: 'memory-panel',
    extraEnv: { CLAUDE_HUB_HOME_DIR: fakeHome, DEEPSEEK_API_KEY: '' },
  });
  let cdp;
  try {
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /index\.html/.test(t.url));
    // 等 renderer.js 跑完（app-container 存在且 ipcRenderer 可用）
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      try {
        ready = await cdp.eval(`(function(){return document.readyState==='complete' && !!document.querySelector('.app-container') && !!require('electron').ipcRenderer})()`, { awaitPromise: false });
      } catch { /* retry */ }
      if (!ready) await new Promise(r => setTimeout(r, 500));
    }
    ok(ready, '1.1 隔离 Hub renderer 就绪');

    // 委托打开：ticker 在无用量数据时不渲染按钮，但面板监听挂在 document 上——
    // 造一个同 data-action 的按钮点它，验证的正是产品里的真实委托链路。
    await cdp.eval(`(function(){
      const b = document.createElement('button');
      b.setAttribute('data-action', 'open-memory');
      b.id = 'e2e-open-memory';
      document.body.appendChild(b);
      b.click();
      return '';
    })()`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 800));
    const opened = await cdp.eval(`(function(){
      const o = document.querySelector('.mp-overlay');
      return !!o && o.style.display === 'flex';
    })()`, { awaitPromise: false });
    ok(opened, '2.1 委托点击 → 记忆面板打开');
    const tabCount = await cdp.eval(`document.querySelectorAll('.mp-tab').length`, { awaitPromise: false });
    ok(tabCount === 4, `2.2 四个页签（实际 ${tabCount}）`);

    // 总览：真实 IPC + 渲染（隔离环境文件大多 missing，但结构必须完整渲染）
    await new Promise(r => setTimeout(r, 1200));
    const overviewSections = await cdp.eval(`document.querySelectorAll('#mp-list .mp-section').length`, { awaitPromise: false });
    ok(overviewSections >= 3, `3.1 总览渲染 ${overviewSections} 个区块`);
    const ov = await cdp.eval(`(async function(){
      const { ipcRenderer } = require('electron');
      const o = await ipcRenderer.invoke('memory:get-overview');
      return { ug: o.userGlobalFiles.length, hasClaudeMemory: !!o.claudeMemory, hasSeed: !!o.seedCopies, cfgProvider: o.consolidation.config.provider };
    })()`);
    ok(ov && ov.ug === 4 && ov.hasClaudeMemory && ov.hasSeed, '3.2 memory:get-overview IPC 结构完整（含 Gemini 层）');
    ok(ov && ov.cfgProvider === 'deepseek-api', '3.3 consolidation 默认 provider=deepseek-api');

    // 二级展开：规范库是目录，点击展开子文件列表而不是误预览（ unsupported extension 修复）
    const expandOk = await cdp.eval(`(function(){
      const heads = [...document.querySelectorAll('.mp-dir-head')];
      const h = heads.find(x => x.textContent.includes('规范库'));
      if (!h) return 'no-head';
      h.click();
      const box = h.parentElement.querySelector('.mp-children');
      const visible = !!box && box.style.display !== 'none';
      const rows = box ? box.querySelectorAll('.mp-file[data-path]').length : 0;
      const previewUntouched = !document.querySelector('#mp-preview-content').textContent;
      return visible && rows === 2 && previewUntouched;
    })()`, { awaitPromise: false });
    ok(expandOk === true, `3.4 规范库目录点击→二级展开子文件且不误预览（got ${expandOk}）`);

    // 子文件点击正常预览（文件行走 read-file）
    const filePreviewOk = await cdp.eval(`(async function(){
      const rows = [...document.querySelectorAll('.mp-children .mp-file[data-path]')];
      const row = rows.find(r => r.textContent.includes('MEMORY.md'));
      if (!row) return 'no-row';
      row.click();
      await new Promise(r => setTimeout(r, 600));
      return document.querySelector('#mp-preview-content').textContent.includes('规范库');
    })()`);
    ok(filePreviewOk === true, `3.5 子文件点击→正常预览（got ${filePreviewOk}）`);

    // 孤岛桶一键并入：真实 IPC + 机械合并 + 再查总览孤岛归零
    const mergeClicked = await cdp.eval(`(function(){
      const b = document.querySelector('.mp-merge-btn');
      if (b) b.click();
      return !!b;
    })()`, { awaitPromise: false });
    ok(mergeClicked, '3.6 孤岛桶行有「并入规范库」按钮');
    let mergeText = '';
    for (let i = 0; i < 15 && !/已并入|失败/.test(mergeText); i++) {
      await new Promise(r => setTimeout(r, 1000));
      mergeText = await cdp.eval(`(document.querySelector('.mp-merge-btn')||{}).textContent || ''`, { awaitPromise: false });
    }
    ok(/已并入 2/.test(mergeText), `3.7 孤岛并入完成（${mergeText || '无结果'}）`);
    const ov2 = await cdp.eval(`(async function(){
      const { ipcRenderer } = require('electron');
      const o = await ipcRenderer.invoke('memory:get-overview');
      return { islands: o.claudeMemory.islandCount, files: o.claudeMemory.canonical.files.length, linked: o.claudeMemory.linkedCount };
    })()`);
    ok(ov2 && ov2.islands === 0 && ov2.files === 4 && ov2.linked === 1, `3.8 并入后孤岛归零、规范库 4 文件、桶已换链（${JSON.stringify(ov2)}）`);

    // 梦境记录：手动跑一轮（隔离环境无候选 → no-candidates，验证主进程全链路）
    await cdp.eval(`document.querySelector('.mp-tab[data-tab="dream"]').click();`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 500));
    const hasRunBtn = await cdp.eval(`!!document.querySelector('#mp-run-now')`, { awaitPromise: false });
    ok(hasRunBtn, '4.1 梦境记录页含「立即跑一轮」');
    await cdp.eval(`document.querySelector('#mp-run-now').click();`, { awaitPromise: false });
    let runText = '';
    for (let i = 0; i < 30 && !runText; i++) {
      await new Promise(r => setTimeout(r, 1000));
      runText = await cdp.eval(`(document.querySelector('.mp-run-ok')||{}).textContent || (document.querySelector('.mp-run-err')||{}).textContent || ''`, { awaitPromise: false });
    }
    ok(/候选 0/.test(runText), `4.2 run-now 全链路完成（${runText || '无结果'}）`);
    const stateExists = fs.existsSync(path.join(dataDir, 'consolidation', 'state.json'));
    ok(stateExists, '4.3 state.json 写入隔离数据目录');
    const changelogExists = fs.existsSync(path.join(dataDir, 'consolidation', 'changelog.jsonl'));
    ok(changelogExists, '4.4 changelog.jsonl 落盘（可回溯）');

    // 当前会话：无活动会话 → 显式提示而非报错
    await cdp.eval(`document.querySelector('.mp-tab[data-tab="session"]').click();`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 500));
    const sessionHint = await cdp.eval(`(document.querySelector('#mp-list .mp-empty')||{}).textContent || ''`, { awaitPromise: false });
    ok(/没有.*活动会话/.test(sessionHint), '5.1 当前会话页无会话时给出提示');

    // 设置：5 个通道 + 保存真实落 config.json
    await cdp.eval(`document.querySelector('.mp-tab[data-tab="settings"]').click();`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 500));
    const optCount = await cdp.eval(`document.querySelectorAll('#mp-cfg-provider option').length`, { awaitPromise: false });
    ok(optCount === 5, `6.1 设置页 5 个 LLM 通道（实际 ${optCount}）`);
    await cdp.eval(`(function(){
      document.querySelector('#mp-cfg-schedule').value = '04:20';
      document.querySelector('#mp-cfg-save').click();
      return '';
    })()`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 800));
    const savedCfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    ok(savedCfg.consolidation && savedCfg.consolidation.schedule === '04:20', '6.2 设置保存写入 config.json consolidation 段');
    const cfgBack = await cdp.eval(`(async function(){ const { ipcRenderer } = require('electron'); const c = await ipcRenderer.invoke('consolidation:get-config'); return c.schedule; })()`);
    ok(cfgBack === '04:20', '6.3 保存后 get-config 读回新值');

    // 截图取证（设置页 + 梦境记录页）
    await cdp.send('Page.enable');
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'hub-memory-panel-e2e-settings.png'), Buffer.from(shot1.data, 'base64'));
    await cdp.eval(`document.querySelector('.mp-tab[data-tab="dream"]').click();`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 600));
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, 'hub-memory-panel-e2e-dream.png'), Buffer.from(shot2.data, 'base64'));
    ok(true, '7.1 截图已存 C:/VibeData/Artifacts/Reports/');

    // Esc 关闭
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`, { awaitPromise: false });
    await new Promise(r => setTimeout(r, 400));
    const closed = await cdp.eval(`document.querySelector('.mp-overlay').style.display === 'none'`, { awaitPromise: false });
    ok(closed, '8.1 Esc 关闭面板');
  } catch (err) {
    fails++;
    results.push(` FAIL  异常: ${err && err.message}`);
  } finally {
    if (cdp) await cdp.close();
    await gracefulQuit(hub);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log(fails ? `\nFAIL ${fails}` : '\nmemory panel e2e: ALL OK');
  process.exitCode = fails ? 1 : 0;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
