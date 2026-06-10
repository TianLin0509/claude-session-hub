'use strict';
// Phase 3 端到端测试：模拟同事场景 - 隔离 Hub (无 OAuth) + 填 meridian + 验证完整链路
//
// 步骤：
//   1. 全新隔离 data dir（不复制任何 OAuth credentials，模拟同事零账号状态）
//   2. 启动隔离 Hub，CDP attach
//   3. IPC test-meridian-health 验证后端逻辑
//   4. IPC save-hub-config 写入 meridian 配置 + 验证 config.json 落盘
//   5. IPC get-hub-config-raw 验证读回
//   6. IPC get-meridian-usage 拉取 telemetry
//   7. UI 截图：初始界面 / 配置面板 / Claude detail / 测试按钮结果
//   8. UI 字段值断言（cfg-meridian-url / token / summary）
//   9. UI 测试按钮触发 + 等待结果 + 文本断言
//
// 不做：真正起 Claude session 跑对话（要 PTY + Claude binary 装在隔离 home，超出 IPC E2E 范围）

const path = require('path');
const fs = require('fs');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const DATA_DIR = 'C:\\temp\\hub-meridian-e2e';
const CDP_PORT = 9230;
const MERIDIAN_URL = 'https://meridian.lthub.xyz:8443';
const MERIDIAN_TOKEN = '8a3fc9dbadf28dba0749b45229ef3c97cde0f0a41063cc95b5b4d35b7d17ec64';
const ARTIFACT_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, label) {
  if (!cond) throw new Error(`FAIL [${label}]: condition is false`);
}

async function takeScreenshot(client, name) {
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`    screenshot → ${file}`);
  return file;
}

async function main() {
  console.log('=== Phase 3 E2E: 模拟同事 Hub 走 Meridian 代理 ===\n');

  // Step 0: 清空隔离 data dir, 模拟全新同事环境
  console.log('Step 0: 重置隔离 data dir');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`    dataDir = ${DATA_DIR}（空，无 OAuth credentials）\n`);

  console.log('Step 1: launch isolated Hub');
  const hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: CDP_PORT, label: 'meridian-e2e' });
  console.log(`    pid=${hub.pid} cdpHttp=${hub.cdpHttpBase}\n`);

  let exitCode = 0;
  try {
    console.log('Step 2: attach CDP renderer');
    const client = await connectFirstPage(hub);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    console.log(`    attached\n`);

    await _waitMs(1500);
    await takeScreenshot(client, 'p3-meridian-1-initial.png');

    console.log('Step 3: IPC test-meridian-health（验证后端逻辑）');
    const healthResult = await client.eval(`(async () => {
      return await ipcRenderer.invoke('test-meridian-health', {
        url: '${MERIDIAN_URL}',
        token: '${MERIDIAN_TOKEN}'
      });
    })()`);
    console.log(`    result: ${JSON.stringify(healthResult)}`);
    assertEq(healthResult.healthOk, true, 'healthOk');
    assertEq(healthResult.authOk, true, 'authOk');
    assertTrue(healthResult.model && healthResult.model.startsWith('claude-'), 'model name');
    assertTrue(healthResult.latencyMs > 0 && healthResult.latencyMs < 30000, 'latency reasonable');
    console.log(`    ✓ health+auth pass · model=${healthResult.model} · latency=${healthResult.latencyMs}ms\n`);

    console.log('Step 4: IPC save-hub-config（写 meridian 配置 + enabled=true）');
    const saveResult = await client.eval(`(async () => {
      return await ipcRenderer.invoke('save-hub-config', {
        meridianUrl: '${MERIDIAN_URL}',
        meridianToken: '${MERIDIAN_TOKEN}',
        meridianEnabled: true,
      });
    })()`);
    console.log(`    save IPC result: ${JSON.stringify(saveResult)}`);
    const cfgFile = path.join(DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assertEq(cfg.providers && cfg.providers.meridian && cfg.providers.meridian.url, MERIDIAN_URL, 'config.json meridian.url');
    assertEq(cfg.providers.meridian.token, MERIDIAN_TOKEN, 'config.json meridian.token');
    assertEq(cfg.providers.meridian.enabled, true, 'config.json meridian.enabled');
    console.log(`    ✓ meridian providers 持久化 OK`);

    // 验证 Codex 联动：meridianEnabled=true 应该自动配置 codex 走团队 relay
    const codex = cfg.providers.codex || {};
    assertEq(codex.backend, 'api', 'codex.backend联动→api');
    assertEq(codex.base_url, `${MERIDIAN_URL}/codex/v1`, 'codex.base_url联动→meridian/codex/v1');
    assertEq(codex.api_key, MERIDIAN_TOKEN, 'codex.api_key联动→meridian token');
    assertEq(codex.model, 'gpt-5.5', 'codex.model联动→gpt-5.5');
    assertEq(codex.provider, 'meridian', 'codex.provider联动→meridian');
    console.log(`    ✓ codex 配置联动 OK · backend=${codex.backend} base_url=${codex.base_url}\n`);

    console.log('Step 5: IPC get-hub-config-raw（验证读回）');
    const editable = await client.eval(`(async () => await ipcRenderer.invoke('get-hub-config-raw'))()`);
    assertEq(editable.meridianUrl, MERIDIAN_URL, 'editable meridianUrl');
    assertEq(editable.meridianToken, MERIDIAN_TOKEN, 'editable meridianToken');
    assertEq(editable.meridianEnabled, true, 'editable meridianEnabled');
    console.log(`    ✓ round-trip OK · url=${editable.meridianUrl} · token=${editable.meridianToken.slice(0,8)}...${editable.meridianToken.slice(-4)}\n`);

    console.log('Step 6: IPC get-meridian-usage（拉 telemetry）');
    const usageResult = await client.eval(`(async () => {
      return await ipcRenderer.invoke('get-meridian-usage', {
        url: '${MERIDIAN_URL}',
        token: '${MERIDIAN_TOKEN}'
      });
    })()`);
    console.log(`    result: ${JSON.stringify(usageResult).slice(0, 250)}`);
    assertEq(usageResult.ok, true, 'usage.ok');
    assertTrue(typeof usageResult.daily.input === 'number', 'usage.daily.input number');
    assertTrue(typeof usageResult.daily.output === 'number', 'usage.daily.output number');
    console.log(`    ✓ daily: req=${usageResult.daily.requests} in=${usageResult.daily.input} out=${usageResult.daily.output}\n`);

    console.log('Step 7: 触发 openConfigModal（点 #options-settings 按钮）');
    await client.eval(`document.getElementById('options-settings').click()`);
    await _waitMs(1500);  // 等 ipcRenderer.invoke('get-hub-config-raw') + DOM 渲染
    await takeScreenshot(client, 'p3-meridian-2-config-modal.png');

    console.log('Step 8: 点 Claude row + 截图 detail');
    await client.eval(`(async () => {
      const claudeRow = document.querySelector('[data-ai="claude"]');
      if (claudeRow) claudeRow.click();
    })()`);
    await _waitMs(800);
    await takeScreenshot(client, 'p3-meridian-3-claude-detail.png');

    const uiState = await client.eval(`({
      hasUrlInput: !!document.getElementById('cfg-meridian-url'),
      hasTokenInput: !!document.getElementById('cfg-meridian-token'),
      hasTestBtn: !!document.getElementById('cfg-meridian-test-btn'),
      urlValue: document.getElementById('cfg-meridian-url')?.value,
      tokenValue: document.getElementById('cfg-meridian-token')?.value,
      claudeSummary: document.getElementById('cfg-summary-claude')?.textContent,
      claudeStatus: document.querySelector('[data-ai=\"claude\"] .config-ai-status')?.textContent,
    })`);
    console.log(`    UI: ${JSON.stringify(uiState)}`);
    assertEq(uiState.hasUrlInput, true, 'cfg-meridian-url exists');
    assertEq(uiState.hasTokenInput, true, 'cfg-meridian-token exists');
    assertEq(uiState.hasTestBtn, true, 'cfg-meridian-test-btn exists');
    assertEq(uiState.urlValue, MERIDIAN_URL, 'UI url loaded');
    assertEq(uiState.tokenValue, MERIDIAN_TOKEN, 'UI token loaded');
    assertTrue(uiState.claudeSummary && uiState.claudeSummary.includes('VPS 代理'), 'Claude summary 显示 VPS 代理');
    console.log(`    ✓ UI 字段全齐 + Claude summary 切换到 "${uiState.claudeSummary}"\n`);

    console.log('Step 9: 点测试按钮触发完整 UX 流');
    await client.eval(`document.getElementById('cfg-meridian-test-btn').click()`);
    // 等测试请求完成（健康 + 微请求 ~5s）
    for (let i = 0; i < 30; i++) {
      const txt = await client.eval(`document.getElementById('cfg-meridian-test-result').textContent`);
      if (txt && (txt.includes('✓') || txt.includes('✗'))) break;
      await _waitMs(500);
    }
    await takeScreenshot(client, 'p3-meridian-4-test-result.png');
    const finalResult = await client.eval(`document.getElementById('cfg-meridian-test-result').textContent`);
    console.log(`    button result: "${finalResult}"`);
    assertTrue(finalResult.includes('✓'), 'test button shows success');
    console.log(`    ✓ 测试按钮 UX 流端到端通过\n`);

    console.log('Step 10: 左上角 options-menu Meridian 入口验证');
    // Trigger badge refresh since config was saved after init() ran
    await client.eval(`(async () => { if (window.refreshMeridianBadge) await window.refreshMeridianBadge(); })()`);
    const popupState = await client.eval(`({
      hasMeridianItem: !!document.getElementById('options-meridian'),
      hasPopup: !!document.getElementById('meridian-config-popup'),
      hasEnableCb: !!document.getElementById('meridian-popup-enable'),
      hasUrlInput: !!document.getElementById('meridian-popup-url'),
      hasTokenInput: !!document.getElementById('meridian-popup-token'),
      hasTestBtn: !!document.getElementById('meridian-popup-test'),
      hasSaveBtn: !!document.getElementById('meridian-popup-save'),
      badgeText: document.getElementById('meridian-status-badge')?.textContent,
    })`);
    console.log(`    popup DOM: ${JSON.stringify(popupState)}`);
    assertEq(popupState.hasMeridianItem, true, 'options-meridian item exists');
    assertEq(popupState.hasPopup, true, 'meridian-config-popup exists');
    assertEq(popupState.hasEnableCb, true, 'enable checkbox exists');
    assertTrue(popupState.badgeText && popupState.badgeText.includes('已启用'), 'badge shows "已启用" (since enabled+url+token all set)');
    console.log(`    ✓ 左上角入口 DOM + badge "${popupState.badgeText}"\n`);

    console.log('Step 11: 点 #options-meridian 打开 popup + 验证字段加载 + 截图');
    await client.eval(`document.getElementById('options-meridian').click()`);
    await _waitMs(800);
    await takeScreenshot(client, 'p3-meridian-5-popup.png');
    const popupValues = await client.eval(`({
      enabled: document.getElementById('meridian-popup-enable').checked,
      url: document.getElementById('meridian-popup-url').value,
      token: document.getElementById('meridian-popup-token').value,
      visible: document.getElementById('meridian-config-popup').style.display !== 'none',
    })`);
    console.log(`    popup values: ${JSON.stringify(popupValues)}`);
    assertEq(popupValues.visible, true, 'popup visible');
    assertEq(popupValues.enabled, true, 'popup enabled checkbox checked');
    assertEq(popupValues.url, MERIDIAN_URL, 'popup url loaded');
    assertEq(popupValues.token, MERIDIAN_TOKEN, 'popup token loaded');
    console.log(`    ✓ 左上角 popup 端到端 UX 通过\n`);

    console.log('=== ALL ASSERTIONS PASSED ✓✓✓ ===');
    console.log(`Artifacts in: ${ARTIFACT_DIR}`);
  } catch (e) {
    console.error(`\nFAIL: ${e.message}`);
    if (e.stack) console.error(e.stack);
    const log = hub.log();
    console.error('\nHUB LOG TAIL (last 20):\n' + log.slice(-20).join('\n'));
    exitCode = 1;
  } finally {
    console.log('\nCleanup: gracefulQuit isolated Hub');
    await gracefulQuit(hub);
    console.log(`    hub PID ${hub.pid} exited, exitCode=${hub.exitCode()}`);
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error('UNHANDLED:', e);
  process.exit(2);
});
