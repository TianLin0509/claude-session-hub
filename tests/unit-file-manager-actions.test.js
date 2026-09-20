'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkedPath, walkFiles, fileOperation } = require('../core/file-manager-service');
const { registerFileManagerIpc } = require('../main/ipc/file-manager-handlers');
const { listWorkspaceDirectory } = require('../core/file-manager-directory');
const { formatSize } = require('../renderer/file-manager-features');
const {createJunctionFixture}=require('./helpers/junction-fixture');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', '中文 report.md'), 'hello 世界', 'utf8');
  return root;
}
function harness(root, extra = {}) {
  const handlers = new Map(); let copied;
  registerFileManagerIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    dataDir: path.join(root, 'isolated-hub'),
    electron: { clipboard: { writeText: value => { copied = value; } }, shell: {} }, ...extra,
  });
  return { call: (name, p) => handlers.get(`file-manager:${name}`)(null, p), copied: () => copied };
}
async function waitJob(h, id) {
  for (let n = 0; n < 200; n++) {
    const job = (await h.call('jobs')).jobs.find(j => j.id === id);
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('job timeout');
}
test('metadata and search find unopened nested files, excluding dependencies', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'secret.md'), 'x');
  const scan = await walkFiles(root, { query: '中文' });
  assert.equal(scan.entries.length, 1); assert.equal(scan.entries[0].size, Buffer.byteLength('hello 世界'));
  assert.ok(scan.entries[0].mtimeMs > 0); assert.equal(scan.skipped[0].reason, 'excluded');
  const list = await listWorkspaceDirectory({ root, directory: path.join(root, 'docs') });
  assert.equal(list.entries[0].size, scan.entries[0].size);
  assert.equal(formatSize(null), '—'); assert.equal(formatSize(0), '0 B');
});
test('scan bounds are explicit and junction ancestors cannot escape', async t => {
  const root = fixture(t);
  const result = await walkFiles(root, { maxEntries: 1 }); assert.equal(result.truncated, true);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-outside-'));
  const link = path.join(root, 'linked');
  await createJunctionFixture(target, link); fs.writeFileSync(path.join(target, 'file.txt'), 'external');
  try {
    await assert.rejects(checkedPath(root, path.join(link, 'file.txt')), /junction/);
    await assert.rejects(checkedPath(root, target), /当前目录/);
    const scan = await walkFiles(root); assert.ok(scan.skipped.some(x => x.reason === 'link'));
  } finally { fs.unlinkSync(link); fs.rmSync(target, { recursive: true }); }
});
test('copy/move refuse overwrites and trash requires scoped paths', async t => {
  const root = fixture(t); const source = path.join(root, 'docs', '中文 report.md');
  fs.mkdirSync(path.join(root, 'dest'));
  let r = await fileOperation({ root, action: 'copy', paths: [source], destination: path.join(root, 'dest') }); assert.equal(r.ok, true);
  r = await fileOperation({ root, action: 'copy', paths: [source], destination: path.join(root, 'dest') }); assert.equal(r.ok, false); assert.match(r.error, /未覆盖/);
  await assert.rejects(fileOperation({ root, action: 'mkdir', paths: [root], name: '../bad' }), /文件名/);
  await assert.rejects(fileOperation({ root, action: 'trash', paths: [root] }, { trashItem: () => assert.fail() }), /根目录/);
  const trashed = [];
  r = await fileOperation({ root, action: 'trash', paths: [source] }, { trashItem: async p => trashed.push(p) });
  assert.equal(r.ok, true); assert.deepEqual(trashed, [source]);
});
test('copy path vs multi-file clipboard are distinct and quote literal paths', async t => {
  const root = fixture(t); const source = path.join(root, 'docs', '中文 report.md');
  const odd = path.join(root, "apostrophe' $(literal).txt"); fs.writeFileSync(odd, 'x');
  let args;
  const h = harness(root, { execFile: async (...values) => { args = values; } });
  assert.equal((await h.call('copy', { root, paths: [source], kind: 'relative' })).ok, true);
  assert.equal(h.copied(), path.relative(root, source));
  assert.equal((await h.call('copy', { root, paths: [source, odd], kind: 'files' })).ok, true);
  assert.equal(args[0], 'powershell.exe'); assert.match(args[1].at(-1), /Set-Clipboard -LiteralPath @\(/);
  assert.ok(args[1].at(-1).includes("apostrophe'' $(literal).txt'"));
  fs.writeFileSync(odd, Buffer.from([0xff, 0xfe]));
  assert.equal((await h.call('copy', { root, paths: [odd], kind: 'content' })).ok, false);
});
test('transfer records preserve verified success, prepared and unknown separately', async t => {
  const root = fixture(t); const source = path.join(root, 'docs', '中文 report.md'); let calls = 0;
  const h = harness(root, { runCompanyDrop: async paths => { calls++; assert.deepEqual(paths, [source]); return { success: true, direct_url: 'https://example.test/a' }; },
    runAttachment: async () => ({ ok: true, prepared: true, sent: false }) });
  const p = { root, paths: [source], target: 'company' };
  const a = await h.call('transfer', p); const b = await h.call('transfer', p);
  assert.equal(a.job.id, b.job.id); assert.equal((await waitJob(h, a.job.id)).state, 'completed'); assert.equal(calls, 1);
  const c = await h.call('transfer', { ...p, target: 'chatgpt' }); assert.equal((await waitJob(h, c.job.id)).state, 'prepared');
  const fresh = harness(root, { runCompanyDrop: async () => ({ error: '网络超时', code: 'timeout' }) });
  const restored = await fresh.call('transfer', { ...p, target: 'chatgpt' }); assert.equal(restored.job.id, c.job.id); assert.equal(restored.duplicate, true);
  fs.appendFileSync(source, '\nchanged');
  const u = await fresh.call('transfer', p); assert.equal((await waitJob(fresh, u.job.id)).state, 'unknown');
  const retry = await fresh.call('transfer', p); assert.equal(retry.duplicate, true);
  assert.ok((await h.call('jobs')).jobs.some(j => j.id === u.job.id && j.state === 'unknown'));
});
test('cancel only queued jobs; validation does not enqueue unsupported paths', async t => {
  const root = fixture(t); const h = harness(root);
  assert.equal((await h.call('transfer', { root, paths: [root], target: 'chatgpt' })).ok, false);
  const created = await h.call('transfer', { root, paths: [root], target: 'company' });
  assert.equal((await h.call('cancel-transfer', { id: created.job.id })).ok, true);
  assert.equal((await h.call('jobs')).jobs[0].state, 'cancelled');
});
