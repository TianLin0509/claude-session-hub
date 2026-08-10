'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { CompletionNotifier } = require('../core/completion-notifier.js');

async function main() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { pushid: 'local-mock-push' } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-serverchan-mock-'));
  const notifier = new CompletionNotifier({
    getConfig: () => ({ notifications: { enabled: false } }),
    getLogPath: () => path.join(tempDir, 'notification-delivery.jsonl'),
    endpointBuilder: sendKey => `http://127.0.0.1:${address.port}/${encodeURIComponent(sendKey)}.send`,
    retryDelaysMs: [],
  });

  try {
    const result = await notifier.sendTest({ sendKey: 'SCT_LOCAL_MOCK_123456' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, 'POST');
    assert.strictEqual(requests[0].url, '/SCT_LOCAL_MOCK_123456.send');
    assert.ok(requests[0].contentType.startsWith('application/x-www-form-urlencoded'));
    const form = new URLSearchParams(requests[0].body);
    assert.strictEqual(form.get('title'), 'AI Hub · 通知测试成功');
    assert.ok(form.get('desp').includes('Server酱通知链路已打通'));

    const audit = fs.readFileSync(path.join(tempDir, 'notification-delivery.jsonl'), 'utf8');
    assert.ok(audit.includes('"provider":"serverchan"'));
    assert.ok(audit.includes('"status":"sent"'));
    assert.ok(!audit.includes('SCT_LOCAL_MOCK_123456'));
    console.log('integration-completion-notifier-serverchan-mock.test.js OK');
  } finally {
    notifier.dispose();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
