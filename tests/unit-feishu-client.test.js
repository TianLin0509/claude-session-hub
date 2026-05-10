'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  FeishuClient,
  buildMarkdownCard,
  createFeishuMessageSender,
  formatGatewayMessage,
  resolveBaseUrl,
} = require('../core/feishu-client.js');

async function withMockServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw && String(req.headers['content-type'] || '').includes('application/json')) body = JSON.parse(raw);
      const rec = { method: req.method, url: req.url, headers: req.headers, body, raw };
      requests.push(rec);
      handler(req, res, rec, requests);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function testTokenAndReply() {
  await withMockServer((req, res, rec) => {
    if (rec.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      assert.strictEqual(rec.body.app_id, 'app-a');
      assert.strictEqual(rec.body.app_secret, 'secret-a');
      return sendJson(res, { code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (rec.url === '/open-apis/im/v1/messages/msg-a/reply') {
      assert.strictEqual(rec.headers.authorization, 'Bearer tenant-token');
      assert.strictEqual(rec.body.msg_type, 'interactive');
      assert.strictEqual(rec.body.reply_in_thread, true);
      const card = JSON.parse(rec.body.content);
      assert.strictEqual(card.body.elements[0].content, '**标题**');
      return sendJson(res, { code: 0, data: { message_id: 'reply-a' } });
    }
    res.writeHead(404); res.end('{}');
  }, async (baseUrl, requests) => {
    const client = new FeishuClient({ appId: 'app-a', appSecret: 'secret-a', baseUrl });
    await client.sendMarkdown({ replyToMessageId: 'msg-a', text: '**标题**' });
    await client.sendMarkdown({ replyToMessageId: 'msg-a', text: '**标题**' });
    const tokenRequests = requests.filter(r => r.url.includes('tenant_access_token'));
    assert.strictEqual(tokenRequests.length, 1, 'tenant token should be cached');
  });
  console.log('  ok token + reply');
}

async function testChatFallbackSend() {
  await withMockServer((req, res, rec) => {
    if (rec.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      return sendJson(res, { code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (rec.url === '/open-apis/im/v1/messages?receive_id_type=chat_id') {
      assert.strictEqual(rec.body.receive_id, 'chat-a');
      assert.strictEqual(rec.body.msg_type, 'interactive');
      return sendJson(res, { code: 0, data: { message_id: 'msg-b' } });
    }
    res.writeHead(404); res.end('{}');
  }, async (baseUrl) => {
    const client = new FeishuClient({ appId: 'app-a', appSecret: 'secret-a', baseUrl });
    await client.sendMarkdown({ chatId: 'chat-a', text: 'hello', replyToMessageId: null });
  });
  console.log('  ok chat fallback send');
}

async function testMessageSenderFormatting() {
  await withMockServer((req, res, rec) => {
    if (rec.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      return sendJson(res, { code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (rec.url === '/open-apis/im/v1/messages/msg-a/reply') {
      const card = JSON.parse(rec.body.content);
      assert.strictEqual(card.header.title.content, 'Codex 状态');
      assert.ok(card.body.elements[0].content.includes('正在运行'));
      assert.ok(card.body.elements.some(el => el.tag === 'markdown' && el.content.includes('最近输出')));
      return sendJson(res, { code: 0 });
    }
    res.writeHead(404); res.end('{}');
  }, async (baseUrl) => {
    const client = new FeishuClient({ appId: 'app-a', appSecret: 'secret-a', baseUrl });
    const sender = createFeishuMessageSender(client, { logger: { warn() {} } });
    await sender({ type: 'status', text: '正在运行', chatId: 'chat-a', replyToMessageId: 'msg-a' });
  });
  console.log('  ok message sender formatting');
}

async function testSendFileUploadAndReply() {
  const tmp = path.join(os.tmpdir(), 'hub-feishu-file-' + Date.now() + '.md');
  fs.writeFileSync(tmp, '# report\n', 'utf8');
  await withMockServer((req, res, rec) => {
    if (rec.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      return sendJson(res, { code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (rec.url === '/open-apis/im/v1/files') {
      assert.strictEqual(rec.method, 'POST');
      assert.strictEqual(rec.headers.authorization, 'Bearer tenant-token');
      assert.ok(String(rec.headers['content-type']).includes('multipart/form-data'));
      assert.ok(rec.raw.includes('name="file_type"'));
      assert.ok(rec.raw.includes('stream'));
      assert.ok(rec.raw.includes('name="file_name"'));
      assert.ok(rec.raw.includes('report.md'));
      assert.ok(rec.raw.includes('# report'));
      return sendJson(res, { code: 0, data: { file_key: 'file-key-a' } });
    }
    if (rec.url === '/open-apis/im/v1/messages/msg-a/reply') {
      assert.strictEqual(rec.body.msg_type, 'file');
      assert.strictEqual(rec.body.reply_in_thread, true);
      assert.deepStrictEqual(JSON.parse(rec.body.content), { file_key: 'file-key-a' });
      return sendJson(res, { code: 0, data: { message_id: 'file-msg-a' } });
    }
    res.writeHead(404); res.end('{}');
  }, async (baseUrl) => {
    const client = new FeishuClient({ appId: 'app-a', appSecret: 'secret-a', baseUrl });
    await client.sendFile({ filePath: tmp, fileName: 'report.md', replyToMessageId: 'msg-a' });
  });
  fs.rmSync(tmp, { force: true });
  console.log('  ok file upload + reply');
}

async function testMessageSenderSendsReportAttachments() {
  const tmp = path.join(os.tmpdir(), 'hub-feishu-attachment-' + Date.now() + '.html');
  fs.writeFileSync(tmp, '<h1>report</h1>\n', 'utf8');
  await withMockServer((req, res, rec) => {
    if (rec.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      return sendJson(res, { code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }
    if (rec.url === '/open-apis/im/v1/messages/msg-a/reply' && rec.body && rec.body.msg_type === 'interactive') {
      return sendJson(res, { code: 0, data: { message_id: 'card-msg-a' } });
    }
    if (rec.url === '/open-apis/im/v1/files') {
      assert.ok(rec.raw.includes('attachment.html'));
      return sendJson(res, { code: 0, data: { file_key: 'file-key-b' } });
    }
    if (rec.url === '/open-apis/im/v1/messages/msg-a/reply' && rec.body && rec.body.msg_type === 'file') {
      assert.deepStrictEqual(JSON.parse(rec.body.content), { file_key: 'file-key-b' });
      return sendJson(res, { code: 0 });
    }
    res.writeHead(404); res.end('{}');
  }, async (baseUrl, requests) => {
    const client = new FeishuClient({ appId: 'app-a', appSecret: 'secret-a', baseUrl });
    const sender = createFeishuMessageSender(client, { logger: { warn() {} } });
    await sender({
      type: 'output-digest',
      text: 'generated report',
      chatId: 'chat-a',
      replyToMessageId: 'msg-a',
      reportFiles: [{ path: tmp, name: 'attachment.html', type: 'html' }],
    });
    assert.ok(requests.some(r => r.url === '/open-apis/im/v1/files'));
    assert.ok(requests.some(r => r.body && r.body.msg_type === 'file'));
  });
  fs.rmSync(tmp, { force: true });
  console.log('  ok message sender report attachments');
}

function testPureHelpers() {
  assert.strictEqual(resolveBaseUrl('feishu'), 'https://open.feishu.cn');
  assert.strictEqual(resolveBaseUrl('lark'), 'https://open.larksuite.com');
  assert.strictEqual(resolveBaseUrl('https://example.test/'), 'https://example.test');
  assert.strictEqual(buildMarkdownCard('abc').body.elements[0].content, 'abc');
  assert.ok(formatGatewayMessage({ type: 'approval', text: 'run test' }).includes('Codex 工具审批'));
  console.log('  ok pure helpers');
}

(async () => {
  console.log('Running Feishu client tests...');
  testPureHelpers();
  await testTokenAndReply();
  await testChatFallbackSend();
  await testMessageSenderFormatting();
  await testSendFileUploadAndReply();
  await testMessageSenderSendsReportAttachments();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
