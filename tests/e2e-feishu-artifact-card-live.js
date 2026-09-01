'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const resultPath = String(process.env.HUB_FEISHU_ACCEPT_RESULT || '').trim();
if (resultPath) fs.writeFileSync(resultPath, '{"ok":false,"stage":"bootstrap"}\n', 'utf8');
const { app, BrowserWindow } = require('electron');
const {
  CompletionNotifier,
  isUsableFeishuTarget,
  normalizeNotificationConfig,
} = require('../core/completion-notifier.js');
const { createHtmlArtifactPreviewRenderer } = require('../core/html-artifact-preview.js');

app.commandLine.appendSwitch('disable-gpu');
if (resultPath) fs.writeFileSync(resultPath, '{"ok":false,"stage":"electron_loaded"}\n', 'utf8');
const keepAlive = setInterval(() => {}, 1_000);

function writeSafeResult(result) {
  if (!resultPath) return;
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function writeStage(stage) {
  if (resultPath) fs.writeFileSync(resultPath, `${JSON.stringify({ ok: false, stage })}\n`, 'utf8');
}

async function run() {
  writeStage('run_enter');
  assert.equal(process.env.HUB_FEISHU_LIVE_ACCEPT, '1', 'live Feishu acceptance requires HUB_FEISHU_LIVE_ACCEPT=1');
  assert.ok(resultPath, 'HUB_FEISHU_ACCEPT_RESULT is required');
  const productionConfigPath = path.join(os.homedir(), '.claude-session-hub', 'config.json');
  const productionConfig = JSON.parse(fs.readFileSync(productionConfigPath, 'utf8'));
  const config = normalizeNotificationConfig(productionConfig.notifications || {});
  assert.equal(isUsableFeishuTarget(config.feishuTarget), true, 'configured Feishu target is missing');
  writeStage('config_loaded');

  const lifecycleWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feishu-card-live-'));
  let notifier = null;
  try {
    const artifactDir = path.join(tempDir, 'artifacts');
    const dataDir = path.join(tempDir, 'hub-data');
    fs.mkdirSync(artifactDir, { recursive: true });
    const htmlPath = path.join(artifactDir, '20260901-AIHub-飞书成果快递-验收.html');
    fs.writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:44px;background:linear-gradient(135deg,#eef8f1,#f6fbff);font-family:"Microsoft YaHei",sans-serif;color:#17251c}
.shell{height:587px;background:#fff;border:1px solid #d7eadd;border-radius:24px;padding:42px;box-shadow:0 18px 55px #1f6a361f;display:flex;flex-direction:column;justify-content:center}
.tag{display:inline-block;width:max-content;padding:7px 14px;border-radius:999px;background:#e3f5e8;color:#16753a;font-weight:700}h1{font-size:44px;margin:22px 0 14px;color:#135f30}p{font-size:24px;line-height:1.65;margin:0;color:#526058}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:30px}.metric{padding:18px;border-radius:14px;background:#f1f8f3}.metric b{display:block;font-size:24px;color:#176f39}.metric span{font-size:15px;color:#7a887f}
</style></head><body><main class="shell"><span class="tag">Card 2.0 · 验收通过</span><h1>AI Hub 成果快递</h1><p>Session 完成后，回答摘要、HTML 静态预览与原文件可以安全送达手机飞书。</p><section class="grid"><div class="metric"><b>准确完成</b><span>沿用 authoritative lifecycle</span></div><div class="metric"><b>静态预览</b><span>1200 × 675 PNG</span></div><div class="metric"><b>原件随附</b><span>HTML 文件消息</span></div></section></main></body></html>`, 'utf8');
    writeStage('artifact_ready');

    const renderHtmlPreview = createHtmlArtifactPreviewRenderer({
      BrowserWindow,
      getOutputDir: () => dataDir,
      logger: console,
    });
    notifier = new CompletionNotifier({
      getConfig: () => ({
        notifications: {
          feishuTarget: config.feishuTarget,
          feishuCliPath: config.feishuCliPath,
          includePreview: true,
          notifyGroupChats: true,
        },
      }),
      getLogPath: () => path.join(dataDir, 'notification-delivery.jsonl'),
      renderHtmlPreview,
      retryDelaysMs: [],
      timeoutMs: 30_000,
      logger: console,
    });
    const turnId = `live-${Date.now()}`;
    notifier.notePromptSubmitted({
      hubSessionId: 'feishu-card-live-acceptance',
      turnId,
      submittedAt: Date.now() - 2_000,
    });
    writeStage('delivery_start');
    const outcome = await notifier.handleTurnComplete({
      hubSessionId: 'feishu-card-live-acceptance',
      turnId,
      completedAt: Date.now(),
      modelId: 'gpt-5.6-sol',
      text: `B 方案已实现并通过隔离验收：完成判断沿用 Hub authoritative lifecycle；飞书主消息为 Card 2.0；HTML 以安全静态图预览，原文件紧随投递。\n\n绝对路径：${htmlPath}`,
    }, {
      title: 'AI Hub 飞书成果快递 · 验收',
      kind: 'codex',
      model: 'gpt-5.6-sol',
      cwd: artifactDir,
      completionNotificationEnabled: true,
    });
    writeSafeResult({
      ok: outcome.ok === true,
      status: outcome.status || null,
      deliveryMode: outcome.deliveryMode || null,
      artifactCount: Number(outcome.artifactCount) || 0,
      attachmentsSent: Number(outcome.attachmentsSent) || 0,
      warningCodes: Array.isArray(outcome.warningCodes) ? outcome.warningCodes : [],
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.deliveryMode, 'card2');
    assert.equal(outcome.artifactCount, 1);
    assert.equal(outcome.attachmentsSent, 1);
    assert.deepEqual(outcome.warningCodes, []);
  } finally {
    notifier?.dispose();
    try { if (!lifecycleWindow.isDestroyed()) lifecycleWindow.destroy(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(
  () => { clearInterval(keepAlive); app.quit(); },
  error => {
    clearInterval(keepAlive);
    writeSafeResult({ ok: false, errorCode: String(error && (error.code || error.message) || 'unknown').slice(0, 120) });
    console.error(error);
    process.exitCode = 1;
    app.quit();
  },
);
