'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CompletionNotifier, sendFeishuCli } = require('../core/completion-notifier.js');

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feishu-cli-notifier-'));
  const auditPath = path.join(tempDir, 'notification-delivery.jsonl');
  const callPath = path.join(tempDir, 'fake-cli-call.json');
  const fakeCliPath = path.join(tempDir, 'fake-lark-cli.js');
  const previousLog = process.env.HUB_FEISHU_FAKE_CALL_LOG;
  const previousMode = process.env.HUB_FEISHU_FAKE_MODE;
  try {
    fs.writeFileSync(fakeCliPath, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const isImageUpload = args[0] === 'im' && args[1] === 'images';",
      "const isDriveUpload = args[0] === 'drive' && args[1] === '+upload';",
      "const isDrivePreview = args[0] === 'drive' && args[1] === '+preview';",
      "fs.appendFileSync(process.env.HUB_FEISHU_FAKE_CALL_LOG, JSON.stringify(args) + '\\n', 'utf8');",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'missing-scope') {",
      "  process.stderr.write(JSON.stringify({ok:false,error:{type:'authorization',subtype:'missing_scope',code:99991679}}) + '\\n');",
      "  process.exit(3);",
      "}",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'card-fail' && args.includes('interactive')) {",
      "  process.stderr.write(JSON.stringify({ok:false,error:{type:'validation',subtype:'invalid_card',code:230001}}) + '\\n');",
      "  process.exit(2);",
      "}",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'drive-scope-fail' && isDriveUpload) {",
      "  process.stderr.write(JSON.stringify({ok:false,error:{type:'authorization',subtype:'app_scope_not_applied',code:99991672,missing_scopes:['drive:file:upload']}}) + '\\n');",
      "  process.exit(3);",
      "}",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'drive-preview-client-only' && isDrivePreview) {",
      "  process.stderr.write(JSON.stringify({ok:false,error:{type:'api',subtype:'unknown',code:1060006,message:'file type does not support preview'}}) + '\\n');",
      "  process.exit(2);",
      "}",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'resource-fail' && (isImageUpload || isDriveUpload || args.includes('--file'))) {",
      "  process.stderr.write(JSON.stringify({ok:false,error:{type:'authorization',subtype:'missing_scope',code:99991679}}) + '\\n');",
      "  process.exit(3);",
      "}",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'timeout') { setTimeout(() => {}, 5000); }",
      "else {",
      "let data;",
      "if (isImageUpload) data = {image_key:'img_v3_integration'};",
      "else if (isDriveUpload) data = {file_token:'boxcn_native_preview',url:'https://tenant.feishu.cn/file/boxcn_native_preview',permission_grant:{status:process.env.HUB_FEISHU_FAKE_MODE === 'drive-grant-fail' ? 'failed' : 'granted'}};",
      "else if (isDrivePreview) data = {mode:'list',candidates:[{type:'html',status:'READY',downloadable:true}]};",
      "else data = {message_id:'om_integration',chat_id:'oc_1234567890'};",
      "process.stdout.write(JSON.stringify({ok:true,identity:'bot',data}) + '\\n');",
      "}",
    ].join('\n'), 'utf8');
    process.env.HUB_FEISHU_FAKE_CALL_LOG = callPath;
    fs.writeFileSync(callPath, '', 'utf8');

    const notifier = new CompletionNotifier({
      getConfig: () => ({
        notifications: {
          feishuTarget: 'oc_1234567890',
          includePreview: false,
        },
      }),
      getLogPath: () => auditPath,
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    notifier.notePromptSubmitted({
      hubSessionId: 'integration-session',
      submittedAt: Date.now() - 100,
      turnId: 'turn-integration',
    });
    const result = await notifier.handleTurnComplete({
      hubSessionId: 'integration-session',
      completedAt: Date.now(),
      turnId: 'turn-integration',
      text: 'PRIVATE BODY',
    }, {
      title: '集成验证',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_integration');

    let cliCalls = fs.readFileSync(callPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const args = cliCalls[0];
    assert.deepEqual(args.slice(0, 4), ['im', '+messages-send', '--chat-id', 'oc_1234567890']);
    assert.ok(args.includes('--msg-type'));
    assert.ok(args.includes('interactive'));
    assert.ok(args.includes('--content'));
    assert.ok(args.includes('--idempotency-key'));
    assert.ok(args.includes('--as'));
    assert.ok(args.includes('bot'));
    assert.doesNotMatch(args.join('\n'), /PRIVATE BODY/,
      'preview-disabled integration must not pass answer text to the CLI');

    const artifactDir = path.join(tempDir, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const htmlPath = path.join(artifactDir, '20260901-AIHub-rich-preview.html');
    const pngPath = path.join(tempDir, 'rendered-preview.png');
    fs.writeFileSync(htmlPath, '<!doctype html><h1>Rich artifact</h1>', 'utf8');
    fs.writeFileSync(pngPath, 'PNG', 'utf8');
    const richNotifier = new CompletionNotifier({
      getConfig: () => ({
        notifications: {
          feishuTarget: 'oc_1234567890',
          includePreview: true,
        },
      }),
      getLogPath: () => auditPath,
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      renderHtmlPreview: async artifactPath => {
        assert.equal(artifactPath, htmlPath);
        return pngPath;
      },
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    richNotifier.notePromptSubmitted({
      hubSessionId: 'rich-session',
      submittedAt: Date.now() - 100,
      turnId: 'turn-rich',
    });
    const richResult = await richNotifier.handleTurnComplete({
      hubSessionId: 'rich-session',
      completedAt: Date.now(),
      turnId: 'turn-rich',
      text: `RICH BODY\n\n绝对路径：${htmlPath}`,
      modelId: 'gpt-5.6-sol',
    }, {
      title: '成果快递集成验证',
      kind: 'codex',
      cwd: tempDir,
      completionNotificationEnabled: true,
    });
    assert.equal(richResult.ok, true);
    assert.equal(richResult.deliveryMode, 'card2');
    assert.equal(richResult.artifactCount, 1);
    assert.equal(richResult.attachmentsSent, 0,
      'a Drive-backed HTML must not also be sent as a generic IM file');
    assert.equal(richResult.driveArtifactsUploaded, 1);
    assert.equal(richResult.drivePreviewState, 'ready');
    cliCalls = fs.readFileSync(callPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(cliCalls.length, 5);
    const imageCall = cliCalls.find(call => call[0] === 'im' && call[1] === 'images');
    assert.ok(imageCall.includes('./rendered-preview.png'));
    const driveUploadCall = cliCalls.find(call => call[0] === 'drive' && call[1] === '+upload');
    assert.ok(driveUploadCall.includes(`./${path.basename(htmlPath)}`));
    const drivePreviewCall = cliCalls.find(call => call[0] === 'drive' && call[1] === '+preview');
    assert.ok(drivePreviewCall.includes('boxcn_native_preview'));
    const richCardCall = cliCalls.find(call => {
      const index = call.indexOf('--content');
      return index >= 0 && /RICH BODY/.test(call[index + 1] || '');
    });
    assert.ok(richCardCall.includes('interactive'));
    const richCard = JSON.parse(richCardCall[richCardCall.indexOf('--content') + 1]);
    assert.equal(richCard.schema, '2.0');
    assert.match(JSON.stringify(richCard), /RICH BODY/);
    assert.match(JSON.stringify(richCard), /img_v3_integration/);
    assert.match(JSON.stringify(richCard), /飞书内打开 HTML/);
    assert.match(JSON.stringify(richCard), /https:\/\/tenant\.feishu\.cn\/file\/boxcn_native_preview/);
    assert.equal(cliCalls.some(call => call[0] === 'im' && call[1] === '+messages-send' && call.includes('--file')), false);
    richNotifier.dispose();

    const audit = fs.readFileSync(auditPath, 'utf8');
    assert.match(audit, /"provider":"feishu-cli"/);
    assert.match(audit, /"providerCode":"om_integration"/);
    assert.match(audit, /"driveArtifactsUploaded":1/);
    assert.match(audit, /"drivePreviewState":"ready"/);
    assert.doesNotMatch(audit, /PRIVATE BODY/);
    assert.doesNotMatch(audit, /RICH BODY/);
    assert.doesNotMatch(audit, /tenant\.feishu\.cn|boxcn_native_preview/,
      'audit must not store Drive URLs or file tokens');
    notifier.dispose();

    const cacheCallStart = cliCalls.length;
    const cachedPayload = {
      eventId: 'cache-event',
      target: 'oc_1234567890',
      title: 'Drive cache verification',
      desp: 'done',
      cardInput: {
        sessionTitle: 'Drive cache verification',
        kind: 'codex',
        model: 'gpt-5.6-sol',
        durationText: '1 秒',
        includeContent: true,
        answerText: 'done',
        artifacts: [{ name: path.basename(htmlPath), kind: 'html' }],
      },
      artifacts: [{ path: htmlPath, name: path.basename(htmlPath), kind: 'html' }],
    };
    await sendFeishuCli(cachedPayload, {
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      timeoutMs: 5_000,
    });
    await sendFeishuCli(cachedPayload, {
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      timeoutMs: 5_000,
    });
    cliCalls = fs.readFileSync(callPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const cacheCalls = cliCalls.slice(cacheCallStart);
    assert.equal(cacheCalls.filter(call => call[0] === 'drive' && call[1] === '+upload').length, 1,
      'a retry of the same payload must reuse the Drive upload');
    assert.equal(cacheCalls.filter(call => call[0] === 'drive' && call[1] === '+preview').length, 1);

    process.env.HUB_FEISHU_FAKE_MODE = 'drive-preview-client-only';
    const clientPreviewNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuTarget: 'oc_1234567890', includePreview: true } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      renderHtmlPreview: async () => pngPath,
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    clientPreviewNotifier.notePromptSubmitted({
      hubSessionId: 'client-preview-session',
      submittedAt: Date.now() - 100,
      turnId: 'turn-client-preview',
    });
    const clientPreview = await clientPreviewNotifier.handleTurnComplete({
      hubSessionId: 'client-preview-session',
      completedAt: Date.now(),
      turnId: 'turn-client-preview',
      text: `CLIENT PREVIEW BODY\n\n绝对路径：${htmlPath}`,
    }, {
      title: '客户端 HTML 预览验证',
      kind: 'codex',
      cwd: tempDir,
      completionNotificationEnabled: true,
    });
    assert.equal(clientPreview.ok, true);
    assert.equal(clientPreview.driveArtifactsUploaded, 1);
    assert.equal(clientPreview.drivePreviewState, 'client_only');
    assert.equal(clientPreview.attachmentsSent, 0);
    assert.equal(clientPreview.warningCodes.some(code => code.startsWith('drive_preview_')), false);
    clientPreviewNotifier.dispose();

    process.env.HUB_FEISHU_FAKE_MODE = 'drive-scope-fail';
    const driveFallbackNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuTarget: 'oc_1234567890', includePreview: true } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      renderHtmlPreview: async () => pngPath,
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    driveFallbackNotifier.notePromptSubmitted({
      hubSessionId: 'drive-fallback-session',
      submittedAt: Date.now() - 100,
      turnId: 'turn-drive-fallback',
    });
    const driveFallback = await driveFallbackNotifier.handleTurnComplete({
      hubSessionId: 'drive-fallback-session',
      completedAt: Date.now(),
      turnId: 'turn-drive-fallback',
      text: `DRIVE FALLBACK BODY\n\n绝对路径：${htmlPath}`,
    }, {
      title: 'Drive 权限降级验证',
      kind: 'codex',
      cwd: tempDir,
      completionNotificationEnabled: true,
    });
    assert.equal(driveFallback.ok, true);
    assert.equal(driveFallback.deliveryMode, 'card2');
    assert.equal(driveFallback.driveArtifactsUploaded, 0);
    assert.equal(driveFallback.attachmentsSent, 1,
      'missing Drive scope must fall back to the original IM file');
    assert.ok(driveFallback.warningCodes.includes('drive_upload_missing_scope'));
    driveFallbackNotifier.dispose();

    process.env.HUB_FEISHU_FAKE_MODE = 'drive-grant-fail';
    const grantFailureNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuTarget: 'oc_1234567890', includePreview: true } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      renderHtmlPreview: async () => pngPath,
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    grantFailureNotifier.notePromptSubmitted({
      hubSessionId: 'grant-failure-session',
      submittedAt: Date.now() - 100,
      turnId: 'turn-grant-failure',
    });
    const grantFailure = await grantFailureNotifier.handleTurnComplete({
      hubSessionId: 'grant-failure-session',
      completedAt: Date.now(),
      turnId: 'turn-grant-failure',
      text: `GRANT FAILURE BODY\n\n绝对路径：${htmlPath}`,
    }, {
      title: 'Drive 授权降级验证',
      kind: 'codex',
      cwd: tempDir,
      completionNotificationEnabled: true,
    });
    assert.equal(grantFailure.ok, true);
    assert.equal(grantFailure.driveArtifactsUploaded, 1);
    assert.equal(grantFailure.attachmentsSent, 1,
      'an inaccessible Drive file must retain the generic IM fallback');
    assert.ok(grantFailure.warningCodes.includes('drive_permission_failed'));
    grantFailureNotifier.dispose();

    process.env.HUB_FEISHU_FAKE_MODE = 'resource-fail';
    const resourceFailureNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuTarget: 'oc_1234567890', includePreview: true } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      renderHtmlPreview: async () => pngPath,
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    resourceFailureNotifier.notePromptSubmitted({
      hubSessionId: 'resource-failure-session',
      submittedAt: Date.now() - 100,
      turnId: 'turn-resource-failure',
    });
    const resourceFailure = await resourceFailureNotifier.handleTurnComplete({
      hubSessionId: 'resource-failure-session',
      completedAt: Date.now(),
      turnId: 'turn-resource-failure',
      text: `RESOURCE FAILURE BODY\n\n绝对路径：${htmlPath}`,
    }, {
      title: '资源失败降级验证',
      kind: 'codex',
      cwd: tempDir,
      completionNotificationEnabled: true,
    });
    assert.equal(resourceFailure.ok, true, 'resource-scope failures must not suppress the completion card');
    assert.equal(resourceFailure.deliveryMode, 'card2');
    assert.equal(resourceFailure.artifactCount, 1);
    assert.equal(resourceFailure.attachmentsSent, 0);
    assert.equal(resourceFailure.driveArtifactsUploaded, 0);
    assert.ok(resourceFailure.warningCodes.includes('preview_upload_missing_scope'));
    assert.ok(resourceFailure.warningCodes.includes('drive_upload_missing_scope'));
    assert.ok(resourceFailure.warningCodes.includes('artifact_send_missing_scope'));
    resourceFailureNotifier.dispose();

    process.env.HUB_FEISHU_FAKE_MODE = 'card-fail';
    const fallbackNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuCliPath: fakeCliPath } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    const fallback = await fallbackNotifier.sendTest({ target: 'oc_1234567890' });
    assert.equal(fallback.ok, true, 'an invalid Card 2.0 must not suppress the completion notification');
    assert.equal(fallback.deliveryMode, 'markdown_fallback');
    assert.ok(fallback.warningCodes.includes('card2_cli_validation_error'));
    cliCalls = fs.readFileSync(callPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(cliCalls.at(-2).includes('interactive'));
    assert.ok(cliCalls.at(-1).includes('--markdown'));
    fallbackNotifier.dispose();

    process.env.HUB_FEISHU_FAKE_MODE = 'missing-scope';
    const missingScopeNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuCliPath: fakeCliPath } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      retryDelaysMs: [],
      timeoutMs: 5_000,
    });
    const missingScope = await missingScopeNotifier.sendTest({ target: 'oc_1234567890' });
    assert.equal(missingScope.errorCode, 'missing_scope');
    assert.equal(missingScope.exitCode, 3);
    missingScopeNotifier.dispose();

    process.env.HUB_FEISHU_FAKE_MODE = 'timeout';
    const timeoutNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuCliPath: fakeCliPath } }),
      cliPath: process.execPath,
      cliPrefixArgs: [fakeCliPath],
      retryDelaysMs: [],
      timeoutMs: 50,
    });
    const timeout = await timeoutNotifier.sendTest({ target: 'oc_1234567890' });
    assert.equal(timeout.errorCode, 'timeout');
    assert.equal(timeout.transient, true);
    timeoutNotifier.dispose();

    console.log('integration-completion-notifier-feishu-cli.test.js OK');
  } finally {
    if (previousLog === undefined) delete process.env.HUB_FEISHU_FAKE_CALL_LOG;
    else process.env.HUB_FEISHU_FAKE_CALL_LOG = previousLog;
    if (previousMode === undefined) delete process.env.HUB_FEISHU_FAKE_MODE;
    else process.env.HUB_FEISHU_FAKE_MODE = previousMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
