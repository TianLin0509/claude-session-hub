'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');
const { createHtmlArtifactPreviewRenderer, previewPdfPath } = require('../core/html-artifact-preview.js');

app.commandLine.appendSwitch('disable-gpu');
const keepAlive = setInterval(() => {}, 1_000);

async function run() {
  const lifecycleWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-preview-electron-'));
  let server = null;
  let externalRequestCount = 0;
  try {
    server = http.createServer((_request, response) => {
      externalRequestCount += 1;
      response.writeHead(204);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const externalUrl = `http://127.0.0.1:${server.address().port}/must-be-blocked.png`;
    const artifactDir = path.join(tempDir, 'artifact');
    const dataDir = path.join(tempDir, 'hub-data');
    fs.mkdirSync(artifactDir, { recursive: true });
    const htmlPath = path.join(artifactDir, '20260901-electron-preview.html');
    fs.writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;padding:48px;background:#f5f8f6;color:#18251d;font-family:"Microsoft YaHei",sans-serif}
.card{background:white;border:1px solid #d8e8dd;border-radius:24px;padding:42px;box-shadow:0 12px 30px #163b2518}
h1{margin:0 0 20px;color:#17803d;font-size:42px}p{font-size:24px;line-height:1.7}
</style></head><body><section class="card"><h1>AI Hub 成果快递</h1><p>HTML 安全静态预览已生成。</p><img src="${externalUrl}"></section></body></html>`, 'utf8');

    const render = createHtmlArtifactPreviewRenderer({
      BrowserWindow,
      getOutputDir: () => dataDir,
      loadTimeoutMs: 10_000,
    });
    const previewPath = await render(htmlPath);
    assert.equal(fs.existsSync(previewPath), true);
    const stat = fs.statSync(previewPath);
    assert.ok(stat.size > 1_000, `captured PNG is unexpectedly small: ${stat.size}`);
    const image = nativeImage.createFromPath(previewPath);
    assert.equal(image.isEmpty(), false);
    const size = image.getSize();
    assert.ok(size.width > 0 && size.width <= 1_500, `invalid preview width: ${size.width}`);
    assert.ok(size.height > 0 && size.height <= 3_000, `invalid preview height: ${size.height}`);
    assert.ok(size.height / size.width <= 16 / 9, `preview ratio exceeds Feishu limit: ${size.width}x${size.height}`);
    assert.equal(externalRequestCount, 0, 'preview HTML must not reach even a loopback HTTP server');
    const pdfPath = previewPdfPath(previewPath);
    const pdfStat = fs.statSync(pdfPath);
    assert.ok(pdfStat.size > 1_000, `PDF fallback is unexpectedly small: ${pdfStat.size}`);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString('ascii'), '%PDF');
    console.log(`integration-html-artifact-preview-electron.test.js OK ${size.width}x${size.height} PNG=${stat.size} PDF=${pdfStat.size}`);
  } finally {
    try { if (!lifecycleWindow.isDestroyed()) lifecycleWindow.destroy(); } catch {}
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(
  () => { clearInterval(keepAlive); app.quit(); },
  error => {
    clearInterval(keepAlive);
    console.error(error);
    process.exitCode = 1;
    app.quit();
  },
);
