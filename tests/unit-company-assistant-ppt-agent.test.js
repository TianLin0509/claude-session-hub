'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { PptLibrary } = require('../core/company-assistant/ppt-library');
const { HubTools } = require('../core/company-assistant/hub-tools');
const python = process.env.CLAUDE_HUB_PPT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ready = spawnSync(python, ['-c', 'import sqlite3; sqlite3.connect(":memory:").execute("create virtual table t using fts5(x)")'], { windowsHide: true }).status === 0;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('PPT 子进程 JSON 与索引进度的汉字跨 pipe 分块仍完整', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-utf8-'));
  const ppt = new PptLibrary({ dir: root, settings: () => ({}), now: Date.now, changed() {} });
  const chunks = [];
  const code = 'const out=Buffer.from(JSON.stringify({ok:true,text:"开始和结尾"}));const err=Buffer.from(JSON.stringify({stage:"扫描素材"})+"\\n");const a=out.indexOf(Buffer.from("开"))+1,b=err.indexOf(Buffer.from("扫"))+1;process.stdout.write(out.subarray(0,a));process.stderr.write(err.subarray(0,b));setTimeout(()=>{process.stdout.write(out.subarray(a));process.stderr.write(err.subarray(b));},40);';
  const value = await ppt.process(process.execPath, ['-e', code], {}, { onProgress: p => chunks.push(p) });
  assert.equal(value.text, '开始和结尾'); assert.deepEqual(chunks, [{ stage: '扫描素材' }]);
});

test('PPT 自建索引：真实 OOXML、增量更新、跨源编号和 MCP 查询均保留只读素材', { skip: !ready, timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-agent-unit-')), pool = path.join(root, 'pool'), doctor = path.join(root, 'doctor');
  const built = spawnSync(python, [path.join(__dirname, 'fixtures/company-ppt-agent-library.py'), pool], { windowsHide: true, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const old = spawnSync(python, [path.join(__dirname, 'fixtures/company-ppt-index.py'), doctor], { windowsHide: true, encoding: 'utf8' });
  assert.equal(old.status, 0, old.stderr);
  const sourceHashes = Object.fromEntries(fs.readdirSync(pool).map(name => [name, sha(path.join(pool, name))]));
  const doctorHash = sha(path.join(doctor, 'index.db'));
  const settings = { ppt: { roots: [pool], db: path.join(doctor, 'index.db'), python } };
  const a = { dir: path.join(root, 'assistant'), now: Date.now, changed() {}, settings: () => settings, state: () => ({ sessionId: 'unit-ppt-agent' }) };
  const ppt = a.ppt = new PptLibrary(a);
  ppt.startIndex(); await ppt.indexJob;
  assert.equal(ppt.indexState.state, 'partial'); assert.equal(ppt.indexState.indexed, 5); assert.equal(ppt.indexState.failed, 1); assert.equal(ppt.indexState.skippedPpt, 1);
  const status = await ppt.refresh({ force: true });
  assert.equal(status.files, 6); assert.equal(status.pages, 17); assert.equal(status.sources.length, 2);
  const find = await ppt.find({ question: '少量射频链怎么配合多天线？', queries: ['少量射频链', 'hybrid beamforming', 'RF chains'] });
  assert.ok(find.candidates.some(c => c.ref.name === '20261021-array-architecture.pptx' && c.ref.page === 1));
  assert.ok(find.candidates.every(c => c.snippet.length <= 120));
  const page = find.candidates.find(c => c.ref.name === '20261021-array-architecture.pptx' && c.ref.page === 1);
  const foundDoctor = await ppt.execute('search', { query: 'SRS 信道估计' });
  assert.ok(new Set(foundDoctor.candidates.map(c => c.ref.source_id)).size > 1);
  assert.equal(new Set(foundDoctor.candidates.map(c => c.id)).size, foundDoctor.candidates.length);
  const read = await ppt.read({ ids: [page.id] });
  assert.match(read.pages[0].text, /64 antennas uses only 4 RF chains/); // real page order, not slide1.xml order
  assert.equal(read.pages[0].text_truncated, false);
  await assert.rejects(ppt.execute('organize'), /不能移动/);
  await assert.rejects(ppt.read({ ids: ['1:1'] }), /索引来源/);
  await assert.rejects(ppt.read({ refs: [{ ...page.ref, page_hash: 'wrong' }] }), /已变化/);

  const bridge = new HubTools(a, { nodeExecutable: process.execPath });
  await bridge.start();
  const entry = bridge.mcpEntry('unit-ppt-agent');
  const child = spawn(entry.command, entry.args, { windowsHide: true, env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', serial = 0; const pending = new Map();
  child.stdout.on('data', chunk => { buffer += chunk; let n; while ((n = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); const r = JSON.parse(line); pending.get(r.id)?.(r); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => reject(new Error('MCP request timed out')), 45000); pending.set(id, r => { clearTimeout(timer); pending.delete(id); r.error ? reject(new Error(r.error.message)) : resolve(r.result); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    const result = await rpc('tools/call', { name: 'ppt_library', arguments: { op: 'search', plan: { intent: 'phase update', queries: ['alternating optimization', '模拟相位', 'phase shifters'] } } });
    assert.equal(result.isError, false); assert.ok(JSON.parse(result.content[0].text).candidates.some(c => c.ref.page === 2 && /architecture/.test(c.ref.name)));
    const actual = await rpc('tools/call', { name: 'ppt_library', arguments: { op: 'read', ids: [page.id] } });
    assert.equal(actual.isError, false); assert.match(JSON.parse(actual.content[0].text).pages[0].text, /4 RF chains/);
  } finally { child.kill(); bridge.close(); }

  ppt.beginTask('test-evidence');
  const evidence = await ppt.read({ ids: [page.id] });
  const decision = { title: '架构', summary: '少量 RF 链', task: { purpose: '解释阵列结构', conditions: [] }, results: [{ id: page.id, label: '混合架构', relevance: '直接适用', use: '讲架构', reason: '写明64天线和4条射频链', quote: 'An array with 64 antennas uses only 4 RF chains.', conditions: '文字证据，图未核查', assessments: [] }], gaps: [], search_note: '测试索引' };
  await assert.rejects(ppt.execute('report', { decision, evidence: { ...evidence, pages: evidence.pages.map(p => ({ ...p, text: p.text + 'invented' })) } }), /实际读到/);
  const report = await ppt.execute('report', { decision: { ...decision, summary: '全库都是英文', search_note: '全部都是英文', gaps: ['无依据的范围推断'] } }); assert.match(report.report, /64 antennas/);
  assert.doesNotMatch(report.report, /全库都是英文|全部都是英文|无依据的范围推断/);
  assert.match(report.report, /本轮完整读过 1 页/);
  assert.equal(ppt.takeTaskReport('test-evidence'), report.report); assert.equal(ppt.takeTaskReport('test-evidence'), '');
  assert.equal(ppt.takeTaskResult('test-evidence')[0].id, page.id);
  const foreignPage = foundDoctor.candidates.find(c => c.ref.source_id !== page.ref.source_id && c.ref.file_id === page.ref.file_id);
  assert.ok(foreignPage, 'fixture exercises duplicate file ids across two index sources');
  ppt.beginTask('cross-source-condition');
  const cross = await ppt.read({ ids: [page.id, foreignPage.id] });
  const quote = cross.pages.find(p => p.id === foreignPage.id).text.slice(0, 20);
  const misleading = { ...decision, task: { purpose: '核对来源', conditions: [{ id: 'c1', text: '需本页支持', required: true }] },
    results: [{ ...decision.results[0], assessments: [{ condition_id: 'c1', status: '满足', reason: '错误地跨来源引用', evidence: [{ id: foreignPage.id, quote }] }] }] };
  await assert.rejects(ppt.execute('report', { decision: misleading }), /其他文稿/);
  assert.deepEqual(ppt.takeTaskResult('cross-source-condition'), []);
  ppt.startIndex(); await ppt.indexJob;
  assert.equal(ppt.indexState.indexed, 0); assert.equal(ppt.indexState.unchanged, 5);
  for (const [name, digest] of Object.entries(sourceHashes)) assert.equal(sha(path.join(pool, name)), digest);
  assert.equal(sha(path.join(doctor, 'index.db')), doctorHash);
  await assert.rejects(ppt.runPython({ db: path.join(doctor, 'index.db'), roots: [pool] }, { index: true }), /并非 Hub 自建索引/);
  assert.equal(sha(path.join(doctor, 'index.db')), doctorHash, 'ownership rejection happens before journal/schema writes');
  const changedFile = path.join(pool, '20261021-array-architecture.pptx');
  fs.appendFileSync(changedFile, '\n'); // ZIP remains readable; size changes invalidate the old page link.
  await assert.rejects(ppt.open(page.id), /源文件已更新/);
  const changedHash = sha(changedFile);
  fs.unlinkSync(path.join(pool, '20261021-uplink-power.pptx')); // This test owns the complete temporary corpus.
  ppt.startIndex(); await ppt.indexJob;
  assert.equal(ppt.indexState.indexed, 1); assert.equal(ppt.indexState.unchanged, 3);
  const changedStatus = await ppt.refresh({ force: true }); assert.equal(changedStatus.files, 5); assert.equal(changedStatus.pages, 14);
  assert.equal(sha(changedFile), changedHash, 'incremental extraction never rewrites the original presentation');
  const removed = await ppt.find({ question: 'removed', queries: ['open-loop', 'closed-loop', '功控'] });
  assert.ok(removed.candidates.every(c => !/uplink-power/.test(c.ref.path)), 'removed presentations leave the owned index');
  ppt.close();
});
