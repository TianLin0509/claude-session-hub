'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AssistantBridge } = require('../core/hub-assistant/bridge');

test('bridge preserves task text when a UTF-8 character spans HTTP chunks', async () => {
  const request = { name: 'send_session', arguments: { text: '继续研究，保留用户原话。' } };
  let observed;
  const bridge = new AssistantBridge(value => { observed = value; return { accepted: true }; });
  await bridge.start();
  try {
    const bytes = Buffer.from(JSON.stringify(request));
    const split = bytes.indexOf(Buffer.from('继')) + 1;
    // Observe the first raw request chunk before sending the remainder. A
    // character decoder must carry the incomplete code point across them.
    const firstReceived = new Promise(resolve => bridge.server.prependOnceListener('request', req => req.once('readable', resolve)));
    let client;
    const response = new Promise((resolve, reject) => {
      client = http.request(bridge.url, { method: 'POST', headers: { authorization: 'Bearer ' + bridge.secret } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      client.on('error', reject);
    });
    client.write(bytes.subarray(0, split));
    await firstReceived;
    client.end(bytes.subarray(split));
    const result = await response;
    assert.equal(result.status, 200);
    assert.deepEqual(observed, {...request,callerSessionId:''});
    assert.equal(result.body.ok, true);
  } finally { bridge.close(); }
});
