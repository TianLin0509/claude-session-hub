'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CompletionNotifier } = require('../core/completion-notifier.js');

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
      "fs.writeFileSync(process.env.HUB_FEISHU_FAKE_CALL_LOG, JSON.stringify(process.argv.slice(2)), 'utf8');",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'missing-scope') {",
      "  process.stderr.write(JSON.stringify({ok:false,error:{type:'authorization',subtype:'missing_scope',code:99991679}}) + '\\n');",
      "  process.exit(3);",
      "}",
      "if (process.env.HUB_FEISHU_FAKE_MODE === 'timeout') { setTimeout(() => {}, 5000); }",
      "else {",
      "process.stdout.write(JSON.stringify({ok:true,identity:'bot',data:{message_id:'om_integration',chat_id:'oc_1234567890'}}) + '\\n');",
      "}",
    ].join('\n'), 'utf8');
    process.env.HUB_FEISHU_FAKE_CALL_LOG = callPath;

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

    const args = JSON.parse(fs.readFileSync(callPath, 'utf8'));
    assert.deepEqual(args.slice(0, 4), ['im', '+messages-send', '--chat-id', 'oc_1234567890']);
    assert.ok(args.includes('--markdown'));
    assert.ok(args.includes('--idempotency-key'));
    assert.ok(args.includes('--as'));
    assert.ok(args.includes('bot'));
    assert.doesNotMatch(args.join('\n'), /PRIVATE BODY/,
      'preview-disabled integration must not pass answer text to the CLI');

    const audit = fs.readFileSync(auditPath, 'utf8');
    assert.match(audit, /"provider":"feishu-cli"/);
    assert.match(audit, /"providerCode":"om_integration"/);
    assert.doesNotMatch(audit, /PRIVATE BODY/);
    notifier.dispose();

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
