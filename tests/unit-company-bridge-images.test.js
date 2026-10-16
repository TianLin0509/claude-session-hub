'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bridgeCrypto = require('../core/company-bridge/crypto');
const { MAX_TEXT_BYTES, envelopeSize, sealImage, openImage } = require('../core/company-bridge/image-message');
const fs = require('node:fs');
const path = require('node:path');
const { rig, pair } = require('./helpers/company-bridge-rig');
const { generatedPng, fixtureCodec } = require('./helpers/bridge-image-fixture');
const { hash, maxDataBytes } = require('../core/company-bridge/image-message');

async function imageRig(t, extra = {}) {
  const r = rig(t, { homeDeps: { imageCodec: fixtureCodec }, companyDeps: { imageCodec: fixtureCodec, ...extra } });
  await pair(r);
  r.hs.map.set('h1', { id: 'h1', kind: 'claude', status: 'idle' });
  const q = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h1', arguments: { question: '请核对这张本机合成测试图，只有测试内容。' } });
  await r.company.checkNow(); await r.home.checkNow();
  const sid = r.company.thread(q.thread).sessionId;
  const file = path.join(r.root, 'generated.png'); fs.writeFileSync(file, generatedPng());
  return { ...r, thread: q.thread, sid, file };
}

test('图片专用文本封装：只编码一次，完整消息低于 60000 字节，压缩图片逐字节还原', () => {
  const key = bridgeCrypto.derive(bridgeCrypto.newSecret());
  const data = crypto.randomBytes(43000);
  const message = { v: 1, mid: crypto.randomUUID(), type: 'image', gen: 'g', thread: 'Q-1017-01', round: 1, format: 'webp', caption: '中文图注', sha256: crypto.createHash('sha256').update(data).digest('hex') };
  const blob = sealImage(key, 'home', message, data);
  assert.ok(/^[A-Za-z0-9+/=_-]+$/.test(blob), '现有 relay_server.py 仅接受该字符集');
  assert.ok(envelopeSize('home', message.mid, blob) < MAX_TEXT_BYTES);
  assert.ok(blob.length < data.length * 1.36, '不是双重 Base64');
  const restored = openImage(key, 'home', blob);
  assert.deepEqual(restored.data, data);
  assert.equal(restored.caption, '中文图注');
  assert.throws(() => openImage(key, 'company', blob), /./, '方向绑定');
});

test('图片消息：超限、篡改和元信息不完整均拒绝', () => {
  const key = bridgeCrypto.derive(bridgeCrypto.newSecret());
  const data = crypto.randomBytes(45000);
  const message = { v: 1, mid: crypto.randomUUID(), type: 'image', gen: 'g', thread: 'H-1017-01', round: 1, format: 'webp', sha256: crypto.createHash('sha256').update(data).digest('hex') };
  assert.throws(() => sealImage(key, 'home', message, data), /60000/);
  const small = data.subarray(0, 200);
  message.sha256 = crypto.createHash('sha256').update(small).digest('hex');
  const blob = sealImage(key, 'home', message, small);
  const corrupted = blob.slice(0, 20) + (blob[20] === 'a' ? 'b' : 'a') + blob.slice(21);
  assert.throws(() => openImage(key, 'home', corrupted), /./);
  assert.throws(() => sealImage(key, 'home', { ...message, mid: '../escape' }, small), /编号/);
});

test('完整 UTF-8 消息的精确预算包含中文、转义字符、方向和密文封装', () => {
  const key = bridgeCrypto.derive(bridgeCrypto.newSecret());
  const m = { mid: crypto.randomUUID(), type: 'image', gen: 'test', thread: 'Q-1017-01', round: 1, format: 'png', caption: '汉字"\\\n'.repeat(80), sha256: '0'.repeat(64) };
  const n = maxDataBytes('company', m), bytes = Buffer.alloc(n, 7); m.sha256 = hash(bytes);
  const blob = sealImage(key, 'company', m, bytes);
  assert.ok(envelopeSize('company', m.mid, blob) >= 59998);
  assert.ok(envelopeSize('company', m.mid, blob) < 60000);
  const tooBig = Buffer.alloc(n + 1, 7);
  assert.throws(() => sealImage(key, 'company', { ...m, sha256: hash(tooBig) }, tooBig), /60000/);
});

test('公司到家里：超过 2 万字的图片消息还原、校验、通知，重复投递只通知一次', async t => {
  const r = await imageRig(t);
  const sent = await r.company.askHome.invoke({ name: 'send_image_home', callerSessionId: r.sid, arguments: { thread: r.thread, path: r.file, caption: '纯合成图' } });
  assert.ok(sent.textBytes > 20000 && sent.textBytes < 60000);
  assert.equal(sent.state, 'sent');
  await r.home.checkNow(); await r.company.checkNow();
  const received = r.home.images.get(sent.id);
  assert.deepEqual(fs.readFileSync(received.path), fs.readFileSync(r.file));
  assert.equal(received.state, 'delivered'); assert.equal(r.company.images.get(sent.id).state, 'delivered');
  assert.equal(r.hs.sentTo('h1').filter(x => x.text.startsWith('【通道图片')).length, 1);
  const rows = [...r.relay.channels.values()].flatMap(x => x.rows), row = rows.find(x => x.mid === sent.id);
  const decoded = bridgeCrypto.open(bridgeCrypto.derive(r.company.link.activeSecret()), 'home', row.blob);
  await r.home.receive(decoded); await r.home.images.tick();
  assert.equal(r.hs.sentTo('h1').filter(x => x.text.startsWith('【通道图片')).length, 1);
  const wrong = { ...decoded, mid: crypto.randomUUID(), gen: 'old' };
  await r.home.receive(wrong); assert.equal(r.home.images.get(wrong.mid), null);
});

test('家里到公司同样可用；其他会话和非图片不能借用图片出口', async t => {
  const r = await imageRig(t);
  await assert.rejects(r.home.images.send('someone-else', { thread: r.thread, path: r.file }), /另一个会话/);
  const bad = path.join(r.root, 'not-an-image.png'); fs.writeFileSync(bad, 'This is not an image. '.repeat(20));
  await assert.rejects(r.home.images.send('h1', { thread: r.thread, path: bad }), /真实的/);
  const sent = await r.home.invoke({ name: 'send_image_company', callerSessionId: 'h1', arguments: { thread: r.thread, path: r.file } });
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.company.images.get(sent.id).state, 'delivered');
  assert.ok(r.cs.sentTo(r.sid).some(x => x.text.startsWith('【通道图片')));
  assert.deepEqual(fs.readFileSync(r.company.images.get(sent.id).path), fs.readFileSync(r.file));
});

test('离线图片持久排队，重建服务后恢复；没有对端能力确认时不发图片', async t => {
  const r = await imageRig(t);
  r.company.store.set('imagePeer', null);
  const before = r.relay.posts;
  await assert.rejects(r.company.images.send(r.sid, { thread: r.thread, path: r.file }), /尚未确认/);
  assert.equal(r.company.images.list().length, 0); assert.equal(r.relay.posts, before);
  r.company.store.set('imagePeer', { gen: r.company.link.gen(), capability: 'image-text-v1' });
  r.relay.offline = true;
  const sent = await r.company.images.send(r.sid, { thread: r.thread, path: r.file });
  assert.equal(sent.state, 'queued');
  r.company.images = new (require('../core/company-bridge/images').BridgeImages)(r.company);
  assert.equal(r.company.images.get(sent.id).state, 'queued');
  r.relay.offline = false;
  await r.company.checkNow(); await r.home.checkNow(); await r.company.checkNow();
  assert.equal(r.company.images.get(sent.id).state, 'delivered');
  assert.equal([...r.relay.channels.values()].flatMap(x => x.rows).filter(x => x.mid === sent.id).length, 1);
});

test('图片专用通行证不能调用 ask_home，伪造 imagesOnly 字段也无效', async t => {
  const r = await imageRig(t); await r.company.askHome.start();
  const plan = r.company.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-bridge' }, id: r.sid });
  assert.equal(plan.env.HUB_HOME_LINK_IMAGES_ONLY, '1');
  const endpoint = JSON.parse(fs.readFileSync(plan.env.HUB_HOME_LINK_ENDPOINT_FILE, 'utf8'));
  const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + plan.env.HUB_HOME_LINK_PASS, 'X-Hub-Home-Link-Session': r.sid }, body: JSON.stringify({ name: 'ask_home', imagesOnly: false, arguments: { question: '不能通过图片工具再次委托家里回答问题。' } }) });
  const rejected = await response.json(); assert.equal(rejected.ok, false); assert.match(rejected.error, /只开放图片工具/);
  await assert.rejects(r.company.askHome.invoke({ name: 'ask_home', callerSessionId: r.sid, arguments: { question: '不能循环求助' } }), /只开放图片工具/);
});

test('压缩进行中解除配对，处理结果不会发给新的对端', async t => {
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const r = await imageRig(t, { imageCodec: { ...fixtureCodec, compress: async (...args) => { await gate; return fixtureCodec.compress(...args); } } });
  const pending = r.company.images.send(r.sid, { thread: r.thread, path: r.file });
  const assertion = assert.rejects(pending, /配对已变更/);
  r.company.unpair(); resume(); await assertion;
  assert.equal(r.company.images.list().length, 0);
});

test('H 求助线程可双向附图，图片列表按会话和线程隔离', async t => {
  const r = await imageRig(t);
  r.cs.map.set('c2', { id: 'c2', kind: 'codeagent', status: 'idle' });
  const q = await r.company.askHome.invoke({ name: 'ask_home', callerSessionId: 'c2', arguments: { question: '请检查本机生成的合成图片，这次需要验证求助线程能双向发送图片。' } });
  await r.home.checkNow(); await r.company.checkNow();
  const hs = r.home.consult.thread(q.thread).sessionId;
  const out = await r.company.images.send('c2', { thread: q.thread, path: r.file });
  await r.home.checkNow(); await r.company.checkNow();
  assert.equal(r.home.images.get(out.id).sessionId, hs);
  assert.equal(r.home.images.get(out.id).state, 'delivered');
  const back = await r.home.images.send(hs, { thread: q.thread, path: r.file });
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.company.images.get(back.id).sessionId, 'c2');
  assert.equal(r.company.images.get(back.id).state, 'delivered');
  assert.equal(r.company.images.view(r.sid).length, 0);
  assert.equal(r.company.images.view('c2', q.thread).length, 2);
  assert.throws(() => r.company.images.view(r.sid, q.thread), /另一个会话/);
  const old = { ...r.company.images.get(back.id), id: crypto.randomUUID(), gen: 'old-pairing' };
  r.company.images.save(old);
  assert.equal(r.company.images.view('c2', q.thread).length, 2, '旧代次同编号的图片不会暴露给新线程');
});

test('图片在会话忙时等待，关闭的会话恢复后只通知一次，通知不含图片编码', async t => {
  const r = await imageRig(t); r.hs.busy.add('h1');
  const sent = await r.company.images.send(r.sid, { thread: r.thread, path: r.file });
  await r.home.checkNow(); assert.equal(r.home.images.get(sent.id).state, 'received');
  r.hs.stored.set('h1', r.hs.map.get('h1')); r.hs.map.delete('h1'); r.hs.busy.delete('h1');
  await r.home.images.tick(); await r.home.images.tick();
  assert.deepEqual(r.hs.resumed, ['h1']);
  const messages = r.hs.sentTo('h1').filter(x => x.text.startsWith('【通道图片'));
  assert.equal(messages.length, 1); assert.ok(messages[0].text.includes('\n')); assert.ok(messages[0].text.length < 1500);
  assert.ok(messages[0].text.includes(r.home.images.get(sent.id).path));
});

test('解码失败会回执错误，伪造校验值的 ACK 不能改变发送状态', async t => {
  const r = await imageRig(t);
  const sent = await r.company.images.send(r.sid, { thread: r.thread, path: r.file });
  await r.company.images.receive({ type: 'image-ack', gen: sent.gen, imageId: sent.id, thread: r.thread, round: 1, sha256: 'f'.repeat(64), state: 'delivered' });
  assert.equal(r.company.images.get(sent.id).state, 'sent');
  r.home.deps.imageCodec = { ...fixtureCodec, validate: async () => { throw new Error('测试解码失败'); } };
  await r.home.checkNow(); await r.company.checkNow();
  assert.equal(r.company.images.get(sent.id).state, 'error');
  assert.equal(r.home.images.get(sent.id), null);
  assert.match(r.company.images.get(sent.id).error, /解码失败/);
});

test('快速到达的接收确认不会被发送完成覆盖', async t => {
  const r = await imageRig(t), flush = r.company.link.flush.bind(r.company.link);
  r.company.link.flush = async () => {
    await flush();
    const item = r.company.images.list()[0];
    if (item) await r.company.images.receive({ type: 'image-ack', gen: item.gen, imageId: item.id, thread: item.thread, round: item.round, sha256: item.sha256, state: 'received' });
  };
  const sent = await r.company.images.send(r.sid, { thread: r.thread, path: r.file });
  assert.equal(sent.state, 'received');
});

test('实际 MCP 子进程通过图片专用凭证发送图片，工具列表与权限一致', async t => {
  const r = await imageRig(t); await r.company.askHome.start();
  const plan = r.company.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-bridge' }, id: r.sid });
  const child = require('node:child_process').spawn(process.execPath, [path.resolve(__dirname, '../scripts/ask-home-mcp.js')], {
    env: { ...process.env, ...plan.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '', errors = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors))); });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_image_home', arguments: { thread: r.thread, path: r.file } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_home', arguments: { question: '不能通过图片专用入口再次向家里委托新的问题。' } } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  await finished;
  const replies = output.trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(replies.find(x => x.id === 1).result.tools.map(x => x.name), ['send_image_home', 'home_images']);
  const result = replies.find(x => x.id === 2).result;
  assert.equal(result.isError, false);
  const sent = JSON.parse(result.content[0].text); assert.ok(sent.textBytes > 20000 && sent.textBytes < 60000);
  assert.match(replies.find(x => x.id === 3).error.message, /未知工具/);
  await r.home.checkNow(); assert.equal(r.home.images.get(sent.id).state, 'delivered');
});
