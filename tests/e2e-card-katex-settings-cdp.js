'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-katex-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-katex-settings');
const CARD_SCREENSHOT = path.join(ARTIFACT_DIR, `card-katex-${RUN_ID}.png`);
const SETTINGS_SCREENSHOT = path.join(ARTIFACT_DIR, `card-settings-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `card-katex-${RUN_ID}.json`);
const PORT = Number(process.env.HUB_CARD_KATEX_E2E_PORT || (9450 + (process.pid % 300)));

async function screenshot(client, filePath) {
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

async function mountFixture(client) {
  return await client.eval(`(() => {
    const overlay = document.getElementById('msg-overlay');
    const empty = document.getElementById('empty-state');
    const panel = document.getElementById('terminal-panel');
    if (empty) empty.style.display = 'none';
    if (panel) panel.style.display = '';
    overlay.innerHTML = '';
    overlay.classList.remove('hidden');
    currentView = 'card';
    const card = window._mountTurnCard(overlay, {
      id: 'katex-e2e-turn',
      role: 'assistant',
      kind: 'claude',
      model: 'claude-opus-5',
      ts: Date.now(),
      text: [
        '# KaTeX 卡片验收',
        '',
        '行内公式 $m = h \\\\cdot v$ 已渲染；下面是块级公式：',
        '',
        '$$\\\\text{HVP}:\\\\ m = h\\\\cdot(8\\\\cdot2) + v\\\\cdot2 + p \\\\Rightarrow \\\\textbf{极化最快}$$',
        '',
        '$$\\\\sum_{i=1}^{n} i = \\\\frac{n(n+1)}{2}$$',
        '',
        '~~~bash',
        'echo "$NOT_MATH"',
        '~~~',
        '',
        '代码块里的美元符号保持原样。'
      ].join('\\n')
    });
    const body = card.querySelector('.turn-body');
    const code = body.querySelector('pre code');
    const computed = getComputedStyle(body);
    return {
      katexGlobal: typeof window.katex,
      autoRenderGlobal: typeof window.renderMathInElement,
      mathCount: body.querySelectorAll('.katex').length,
      displayMathCount: body.querySelectorAll('.katex-display').length,
      renderedMathText: Array.from(body.querySelectorAll('.katex')).map(node => node.textContent),
      bodyText: body.innerText,
      rawDelimiterLeft: body.innerText.includes('$$'),
      codePreserved: !!code && code.textContent.includes('$NOT_MATH'),
      fontSize: computed.fontSize,
      fontFamily: computed.fontFamily,
      mathProcessed: body.dataset.mathRendered,
    };
  })()`);
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    ui: { card_font_size: 18, card_font_family: 'serif' },
  }, null, 2), 'utf8');

  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port: PORT };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: PORT, label: 'card-katex-settings' });
    await _waitMs(1400);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });

    result.initial = await mountFixture(client);
    console.log('[card-katex initial]', JSON.stringify(result.initial));
    assert.equal(result.initial.katexGlobal, 'object');
    assert.equal(result.initial.autoRenderGlobal, 'function');
    assert.ok(result.initial.mathCount >= 3, `expected inline + display math, got ${result.initial.mathCount}`);
    assert.ok(result.initial.displayMathCount >= 2);
    assert.equal(result.initial.rawDelimiterLeft, false);
    assert.equal(result.initial.codePreserved, true);
    assert.equal(result.initial.fontSize, '18px');
    assert.match(result.initial.fontFamily, /serif|Songti|SimSun/i);
    assert.equal(result.initial.mathProcessed, 'true');
    await screenshot(client, CARD_SCREENSHOT);

    result.settings = await client.eval(`(async () => {
      document.getElementById('options-settings').click();
      await new Promise(resolve => setTimeout(resolve, 180));
      const modal = document.getElementById('config-modal');
      const size = document.getElementById('cfg-card-font-size');
      const family = document.getElementById('cfg-card-font-family');
      size.value = '20';
      size.dispatchEvent(new Event('input', { bubbles: true }));
      family.value = 'mono';
      family.dispatchEvent(new Event('change', { bubbles: true }));
      const liveBody = document.querySelector('.turn-body');
      const live = getComputedStyle(liveBody);
      document.getElementById('config-save').click();
      await new Promise(resolve => setTimeout(resolve, 250));
      const saved = await ipcRenderer.invoke('get-hub-config-raw');
      return {
        modalVisible: !modal.classList.contains('hidden'),
        sizeValue: size.value,
        sizeLabel: document.getElementById('cfg-card-font-size-value').textContent,
        familyValue: family.value,
        liveFontSize: live.fontSize,
        liveFontFamily: live.fontFamily,
        savedFontSize: saved.cardFontSize,
        savedFontFamily: saved.cardFontFamily,
        saveMessage: document.getElementById('config-save-msg').textContent,
      };
    })()`);
    assert.equal(result.settings.modalVisible, true);
    assert.equal(result.settings.sizeValue, '20');
    assert.equal(result.settings.sizeLabel, '20px');
    assert.equal(result.settings.familyValue, 'mono');
    assert.equal(result.settings.liveFontSize, '20px');
    assert.match(result.settings.liveFontFamily, /Cascadia|Consolas/i);
    assert.equal(result.settings.savedFontSize, 20);
    assert.equal(result.settings.savedFontFamily, 'mono');
    assert.match(result.settings.saveMessage, /卡片字体已立即生效/);
    await screenshot(client, SETTINGS_SCREENSHOT);

    await client.eval(`location.reload()`);
    await _waitMs(1500);
    result.afterReload = await mountFixture(client);
    assert.equal(result.afterReload.fontSize, '20px');
    assert.match(result.afterReload.fontFamily, /Cascadia|Consolas/i);
    assert.ok(result.afterReload.mathCount >= 3);

    result.cancelRestore = await client.eval(`(async () => {
      document.getElementById('options-settings').click();
      await new Promise(resolve => setTimeout(resolve, 160));
      const size = document.getElementById('cfg-card-font-size');
      const family = document.getElementById('cfg-card-font-family');
      size.value = '22';
      size.dispatchEvent(new Event('input', { bubbles: true }));
      family.value = 'system';
      family.dispatchEvent(new Event('change', { bubbles: true }));
      const previewSize = getComputedStyle(document.querySelector('.turn-body')).fontSize;
      document.getElementById('config-cancel').click();
      const restored = getComputedStyle(document.querySelector('.turn-body'));
      const saved = await ipcRenderer.invoke('get-hub-config-raw');
      return {
        previewSize,
        restoredSize: restored.fontSize,
        restoredFamily: restored.fontFamily,
        savedFontSize: saved.cardFontSize,
        savedFontFamily: saved.cardFontFamily,
      };
    })()`);
    assert.equal(result.cancelRestore.previewSize, '22px');
    assert.equal(result.cancelRestore.restoredSize, '20px');
    assert.match(result.cancelRestore.restoredFamily, /Cascadia|Consolas/i);
    assert.equal(result.cancelRestore.savedFontSize, 20);
    assert.equal(result.cancelRestore.savedFontFamily, 'mono');

    result.cardScreenshot = CARD_SCREENSHOT;
    result.settingsScreenshot = SETTINGS_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
