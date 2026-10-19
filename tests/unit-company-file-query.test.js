'use strict';
// 直查读文件（2026-10-20，core/company-bridge/file-query.js + hub-admin.js op:'files' + home.js files）：
// 能读的目录闸门（相对路径、../、不在根里）、后缀与二进制闸门、分段读（UTF-8 / GBK、超长行、超大文件）、
// 列目录与子树统计、按名 / 按内容找文件、凭据脱敏只脱凭据、开关与限频、代次与动作白名单、端到端（内存通道）与审计日志。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rig, pair } = require('./helpers/company-bridge-rig');
const F = require('../core/company-bridge/file-query');

const NOW = 1_800_000_000_000;

// 一棵临时的「公司电脑上的目录」：根 + 子目录 + 各种文件
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const w = (rel, text, enc) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.isBuffer(text) ? text : Buffer.from(text, enc || 'utf8')); return p; };
  w('out/a.txt', '第一行 alpha\n第二行 beta 目标关键词\n第三行 gamma\n');
  w('out/nested/b.log', 'log line 1\nlog line 2\n');
  w('out/big.csv', Array.from({ length: 500 }, (_, i) => `row,${i},${'x'.repeat(20)}`).join('\n'));
  w('out/note.md', '# 标题\n正文\n');
  w('out/secret.key', 'PRIVATE MATERIAL');
  w('out/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
  w('out/binary.dat', Buffer.from([0x00, 0x01, 0x02, 0x03]));
  w('out/creds.txt', 'password: hunter2SECRET\napi_key = aBcDeFgHiJkLmNoPqRsT\nurl=https://example.com/page\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\n-----END RSA PRIVATE KEY-----\n');
  w('out/gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd0, 0xd0])); // 「中文」+ 换行 + 「第二行」
  w('out/longline.txt', 'x'.repeat(1200) + '\n尾巴\n');
  w('out/lines.txt', Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(outside, 'z.txt'), '不在可读目录里的文件\n');
  // 超大可读树（只测统计的上限，不真占 8MB）：用稀疏文件
  const huge = path.join(root, 'out', 'huge.txt');
  fs.writeFileSync(huge, Buffer.alloc(9 * 1024 * 1024, 0x61));
  return { root, outside };
}

async function read(root, p, opts = {}) {
  return F.run({ roots: [root], action: 'read', params: { file: p, ...opts } });
}

test('能读的目录闸门：相对路径落在第一个含它的根里，绝对路径要在根里面，../ 跳不出去，不存在的目录如实报错', async t => {
  const { root, outside } = fixture(t);
  const abs = path.join(root, 'out', 'a.txt');
  assert.equal((await read(root, abs)).file, 'out/a.txt');
  assert.equal((await read(root, 'out/a.txt')).file, 'out/a.txt', '相对路径按根拼');
  await assert.rejects(read(root, path.join(outside, 'z.txt')), /不在可读目录里/);
  await assert.rejects(read(root, path.join(root, '..', path.basename(outside), 'z.txt')), /不在可读目录里/);
  await assert.rejects(read(root, path.join(root, 'out', '..', '..', 'nope.txt')), /不在可读目录里|读不到/);
  await assert.rejects(read(root, ''), /要给出路径/);
  // 根不存在：如实回报，不是静默当成空
  await assert.rejects(F.run({ roots: [path.join(root, '没有这个目录')], action: 'list', params: { dir: '.' } }), /列不了这个目录|不在可读目录里/);
  // 没有设置任何可读目录：明确说清楚
  await assert.rejects(F.run({ roots: [], action: 'read', params: { file: abs } }), /还没设置可读的目录/);
});

test('后缀与二进制闸门：第一期只读文本；密钥类后缀与二进制直接拒绝；目录要用 list', async t => {
  const { root } = fixture(t);
  await assert.rejects(read(root, 'out/secret.key'), /密钥|不给读/);
  assert.equal(F.readableName('id_rsa').ok, false);
  assert.equal(F.readableName('.npmrc').ok, false);
  assert.equal(F.readableName('a.txt').ok, true);
  assert.equal(F.readableName('a.xyz').ok, false);
  await assert.rejects(read(root, 'out/binary.dat'), /二进制|不给读|只读文本/);
  await assert.rejects(read(root, 'out'), /这是一个目录/);
  await assert.rejects(read(root, 'out/huge.txt'), /超过单次读取上限/, '9 MB 的文件不整份读进内存');
});

test('分段读：从任意行开始，返回这段和总行数，没读完时 next 是下一段起点', async t => {
  const { root } = fixture(t);
  const a = await read(root, 'out/lines.txt', { from: 1, lines: 10 });
  assert.equal(a.totalLines, 30);
  assert.deepEqual(a.lines, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
  assert.equal(a.from, 1); assert.equal(a.to, 10); assert.equal(a.more, true); assert.equal(a.next, 11);
  const b = await read(root, 'out/lines.txt', { from: 11, lines: 100 });
  assert.equal(b.from, 11); assert.equal(b.to, 30); assert.equal(b.more, false); assert.equal(b.next, null);
  // 起点超过总行数：贴到最后一行，不报错
  const c = await read(root, 'out/lines.txt', { from: 999, lines: 5 });
  assert.equal(c.from, 30); assert.deepEqual(c.lines, ['L30']); assert.equal(c.more, false);
  // 字数上限截断：单行比预算还长时截断这一行自己
  const d = await read(root, 'out/longline.txt', { from: 1, lines: 10, chars: 1000 });
  assert.equal(d.lines[0].length, 1000); assert.equal(d.truncatedLine, true); assert.equal(d.more, true);
  assert.equal(d.totalLines, 2);
});

test('编码：UTF-8 正常读；中文 Windows 上的 GBK 文本回退解码；正文里没有 BOM 与 \\r', async t => {
  const { root } = fixture(t);
  const a = await read(root, 'out/a.txt');
  assert.deepEqual(a.lines.slice(0, 2), ['第一行 alpha', '第二行 beta 目标关键词']);
  const g = await read(root, 'out/gbk.txt');
  assert.deepEqual(g.lines, ['中文', '第二行'], 'GBK 回退');
  const bom = path.join(root, 'out', 'bom.txt');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带 BOM 的第一行\r\n第二行\r\n', 'utf8')]));
  const b = await read(root, 'out/bom.txt');
  assert.deepEqual(b.lines, ['带 BOM 的第一行', '第二行'], 'BOM 去掉、CRLF 归一');
});

test('列目录：默认只列可读的文本文件，all:true 连不可读的一起列出并写明原因；报整棵子树的量与后缀分布', async t => {
  const { root } = fixture(t);
  const l = await F.run({ roots: [root], action: 'list', params: { dir: 'out' } });
  const names = l.entries.filter(x => x.type === 'file').map(x => x.name);
  assert.deepEqual(names.sort(), ['a.txt', 'big.csv', 'creds.txt', 'gbk.txt', 'huge.txt', 'lines.txt', 'longline.txt', 'note.md']);
  assert.ok(!names.includes('secret.key') && !names.includes('photo.png'), '默认不列不可读的');
  assert.equal(l.entries.find(x => x.name === 'huge.txt').big, true, '超过单次读取上限的文本标出来，家里知道要分段读');
  assert.match(l.note || F.summarize(l), /超过 8 MB/, '摘要里点出大文件');
  assert.ok(l.entries.some(x => x.type === 'dir' && x.name === 'nested'));
  assert.equal(l.depth, 0);
  const all = await F.run({ roots: [root], action: 'list', params: { dir: 'out', all: true } });
  const key = all.entries.find(x => x.name === 'secret.key');
  assert.ok(key && key.unreadable, 'all:true 时列出来并标不可读的原因');
  assert.match(key.unreadable, /凭据|密钥/);
  const deep = await F.run({ roots: [root], action: 'list', params: { dir: 'out', depth: 2 } });
  assert.ok(deep.entries.some(x => x.rel === 'out/nested/b.log'), 'depth 1 以上递归进去；rel 一律相对根目录，能直接喂给 read');
  assert.ok(l.subtree && l.subtree.files >= 7);
  assert.ok(Array.isArray(l.subtree.top) && l.subtree.top.some(x => x.ext === '.txt' && x.text), '整棵子树的字节数按后缀分组，标出哪些是文本');
  // 目录里文件太多：按上限截断并写明，不把整棵树都扫完
  const many = path.join(root, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 205; i += 1) fs.writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.txt`), 'x');
  const cut = await F.run({ roots: [root], action: 'list', params: { dir: 'many' } });
  assert.equal(cut.truncated, true);
  assert.equal(cut.entries.length, 200, '默认最多列 200 项');
  assert.match(cut.note, /只列了前 200 项/);
  const wide = await F.run({ roots: [root], action: 'list', params: { dir: 'many', limit: 205 } });
  assert.equal(wide.entries.length, 205);
  assert.equal(wide.truncated, false);
});

test('找文件：按名字（支持 * 和 ?）或按内容（带回行号、列号和那一行）；超大文件按内容搜索时跳过并说明', async t => {
  const { root } = fixture(t);
  const byName = await F.run({ roots: [root], action: 'search', params: { root: 'out', name: '*.txt' } });
  assert.deepEqual(byName.matches.map(x => x.rel).sort(), ['out/a.txt', 'out/creds.txt', 'out/gbk.txt', 'out/huge.txt', 'out/lines.txt', 'out/longline.txt']);
  const bySub = await F.run({ roots: [root], action: 'search', params: { root: 'out', name: 'note' } });
  assert.deepEqual(bySub.matches.map(x => x.rel), ['out/note.md'], '没有通配符时按子串匹配');
  const byContent = await F.run({ roots: [root], action: 'search', params: { root: 'out', content: '目标关键词' } });
  assert.equal(byContent.matches.length, 1);
  assert.equal(byContent.matches[0].rel, 'out/a.txt');
  assert.equal(byContent.matches[0].line, 2);
  assert.equal(byContent.matches[0].col, 10);
  assert.match(byContent.matches[0].sample, /目标关键词/);
  assert.equal(byContent.matches[0].hits, 1);
  // 内容搜索只认文本后缀：密钥文件、二进制文件不会被读
  const bad = await F.run({ roots: [root], action: 'search', params: { root: 'out', content: 'PRIVATE MATERIAL' } });
  assert.equal(bad.matches.length, 0, '密钥文件不参与内容搜索');
  const capped = await F.run({ roots: [root], action: 'search', params: { root: 'out', content: 'row,', maxKB: 1 } });
  assert.ok(!capped.matches.some(x => x.rel === 'out/big.csv'), '超过 maxKB 的文件跳过');
  assert.ok(capped.skipped.some(x => /超过内容搜索上限/.test(x.why)));
  await assert.rejects(F.run({ roots: [root], action: 'search', params: { root: 'out' } }), /要找什么/);
});

test('凭据脱敏只动凭据：口令、令牌、私钥块隐去；代码、路径、URL、长标识符原样保留', () => {
  const redact = F.makeFileRedactor({});
  const out = redact([
    'password: hunter2SECRET',
    'api_key = aBcDeFgHiJkLmNoPqRsT',
    'Authorization: Bearer abcdefghijklmnop',
    'url=https://example.com/page',
    '请把 D:\\code\\l2\\harq.cpp 里那 32 位的 sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 记下来',
    'const combinedKeyIdentifier = someFunction(a, b);',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKC',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  assert.ok(!out.includes('hunter2SECRET'), '口令隐去');
  assert.ok(!out.includes('aBcDeFgHiJkLmNoPqRsT'), 'key=value 的令牌隐去');
  assert.ok(!out.includes('abcdefghijklmnop'), 'Bearer 令牌隐去');
  assert.ok(!out.includes('MIIEowIBAAKC'), '私钥整块隐去');
  assert.match(out, /<已隐去/);
  assert.ok(out.includes('https://example.com/page'), 'URL 原样（动 URL 会把报告读成废纸）');
  assert.ok(out.includes('D:\\code\\l2\\harq.cpp'), '路径原样');
  assert.ok(out.includes('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), '哈希原样（32+ 位随机串的换代规则只用在诊断段）');
  assert.ok(out.includes('const combinedKeyIdentifier = someFunction(a, b);'), '代码原样');
  // 公司账号实值按 scrubbing 回调隐去
  const withAccount = F.makeFileRedactor({ scrub: s => s.split('w001****11').join('<已隐去>') });
  assert.ok(!withAccount('账号 w001****11 在配 X').includes('w001****11'));
});

test('参数校验：动作白名单、按动作只认自己的字段、范围越界与不认识的参数都拒绝', () => {
  assert.deepEqual(F.ACTIONS, ['list', 'search', 'read']);
  assert.deepEqual(F.parseParams('list', {}), { dir: '.', depth: 0, all: false });
  assert.deepEqual(F.parseParams('read', { file: ' a.txt ', from: 2, lines: 5, chars: 2000 }), { file: 'a.txt', from: 2, lines: 5, chars: 2000 });
  assert.throws(() => F.parseParams('read', {}), /要给出文件路径/);
  assert.throws(() => F.parseParams('read', { file: 'a.txt', from: 0 }), /from 只能是行号/);
  assert.throws(() => F.parseParams('read', { file: 'a.txt', lines: 99999 }), /lines 只能是 1–4000/);
  assert.throws(() => F.parseParams('search', { name: '*.txt', limit: 9999 }), /limit 只能是 1–200/);
  assert.throws(() => F.parseParams('list', { dir: 'x', depth: 99 }), /depth/);
  assert.throws(() => F.parseParams('rm', {}), /不认识的动作/);
  assert.equal(F.parseParams('read', { file: 'a.txt', unknown: 'x' }).unknown, undefined, '不认识的参数不进参数');
});

test('端到端（内存通道）：家里发 --files read → 公司直接读盘、脱敏、压缩回报 → 家里解开；不开会话、参数与结果进审计', async t => {
  const { root } = fixture(t);
  const r = rig(t, { companyDeps: { accountSecrets: () => ['w001****11'] } });
  r.company.setSettings({ resultDirs: [root] });
  await pair(r);
  const createdBefore = r.cs.created.length;
  const sent = await r.home.hubAdmin({ op: 'files', action: 'read', params: { file: 'out/a.txt' } });
  await r.company.checkNow();
  await r.company.hubAdmin.filesTask;
  await r.home.checkNow();
  const view = r.home.filesView(sent.id);
  assert.equal(view.status, '已回报');
  assert.equal(view.action, 'read');
  assert.equal(view.result.file, 'out/a.txt');
  assert.deepEqual(view.result.lines.slice(0, 2), ['第一行 alpha', '第二行 beta 目标关键词']);
  assert.match(view.summary, /读文件 out\/a\.txt：1–3 行 \/ 共 3 行/);
  assert.equal(r.cs.created.length, createdBefore, '不开 CodeAgent 会话');
  assert.equal(r.company.hubAdmin.state().lastFiles.action, 'read');
  assert.equal(r.company.status().hubAdmin.lastFiles.action, 'read', '状态里给界面看最近一次');
  const audit = fs.readFileSync(path.join(r.root, 'company', 'logs', 'company-files.log'), 'utf8');
  assert.match(audit, /files HA-\d{4}-\w+ read/);
  assert.ok(!JSON.stringify(r.company.hubAdmin.state().history).includes('"files":"'), '公司历史里不存正文');
  const notice = r.notices.find(n => /对端读了这台电脑上的文件/.test(`${n.title || ''} ${n.text || ''}`));
  assert.ok(notice, '每次读取给一条轻提示');
  assert.equal(notice.quiet, true, '是轻提示，不弹窗不响铃');
  assert.match(notice.text, /读文件：out\/a\.txt/, '提示里写清读了哪个文件');
});

test('端到端：列目录 → 找文件 → 分段读同一个大文件，家里能按 next 接着读', async t => {
  const { root } = fixture(t);
  const r = rig(t);
  r.company.setSettings({ resultDirs: [root] });
  await pair(r);
  const round = async (action, params, bump = 0) => {
    r.clock.now += bump;
    const sent = await r.home.hubAdmin({ op: 'files', action, params });
    await r.company.checkNow();
    await r.company.hubAdmin.filesTask;
    await r.home.checkNow();
    return r.home.filesView(sent.id);
  };
  const listed = await round('list', { dir: 'out' });
  assert.ok(listed.result.entries.some(x => x.name === 'big.csv'));
  assert.match(listed.summary, /目录 out/);
  const found = await round('search', { root: 'out', name: 'big.csv' });
  assert.equal(found.result.matches.length, 1);
  const first = await round('read', { file: 'out/big.csv', from: 1, lines: 10 });
  assert.equal(first.result.totalLines, 500);
  assert.equal(first.result.next, 11);
  const rest = await round('read', { file: 'out/big.csv', from: first.result.next, lines: 10 }, 6000);
  assert.deepEqual(rest.result.lines, Array.from({ length: 10 }, (_, i) => `row,${10 + i},${'x'.repeat(20)}`));
  const big = listed.result.entries.find(x => x.name === 'big.csv');
  assert.equal(big.type, 'file');
});

test('开关：公司端关掉「文件读取」就拒绝，并且一次盘都不读；开了以后照常', async t => {
  const { root } = fixture(t);
  const r = rig(t);
  r.company.setSettings({ resultDirs: [root] });
  await pair(r);
  r.company.setSettings({ allowRemoteFiles: false });
  let reads = 0; const real = F.listDir;
  const sent = await r.home.hubAdmin({ op: 'files', action: 'list', params: { dir: 'out' } });
  await r.company.checkNow();
  await r.company.hubAdmin.filesTask;
  await r.home.checkNow();
  const view = r.home.filesView(sent.id);
  assert.equal(view.status, '公司没处理');
  assert.match(view.note, /没允许对端读取文件/);
  assert.equal(r.company.hubAdmin.state().lastFilesAt, undefined, '关着时不算一次读取');
  assert.equal(reads, 0);
  // 参数不合法也在家里先挡住
  await assert.rejects(r.home.hubAdmin({ op: 'files', action: 'nope', params: {} }), /action 只能是 list \/ search \/ read/);
  await assert.rejects(r.home.hubAdmin({ op: 'files', action: 'read', params: {} }), /要给出文件路径/);
});

test('限频与并发：读文件 5 秒一次、找文件 20 秒一次；上一条还在跑时这条不处理', async t => {
  const { root } = fixture(t);
  const r = rig(t);
  r.company.setSettings({ resultDirs: [root] });
  await pair(r);
  r.notices.length = 0;
  const first = await r.home.hubAdmin({ op: 'files', action: 'read', params: { file: 'out/a.txt' } });
  await r.company.checkNow();
  await r.company.hubAdmin.filesTask;
  await r.home.checkNow();
  assert.equal(r.home.filesView(first.id).status, '已回报');
  // 紧接着再来一条：公司限频挡住
  const again = await r.home.hubAdmin({ op: 'files', action: 'read', params: { file: 'out/note.md' } });
  await r.company.checkNow();
  await r.company.hubAdmin.filesTask;
  await r.home.checkNow();
  assert.match(r.home.filesView(again.id).note, /5 秒内只做一次/);
  // 找文件是 20 秒一次
  r.clock.now = NOW + 6000;
  const s1 = await r.home.hubAdmin({ op: 'files', action: 'search', params: { root: 'out', name: '*.md' } });
  await r.company.checkNow(); await r.company.hubAdmin.filesTask; await r.home.checkNow();
  assert.equal(r.home.filesView(s1.id).status, '已回报');
  r.clock.now = NOW + 8000;
  const s2 = await r.home.hubAdmin({ op: 'files', action: 'search', params: { root: 'out', name: '*.txt' } });
  await r.company.checkNow(); await r.company.hubAdmin.filesTask; await r.home.checkNow();
  assert.match(r.home.filesView(s2.id).note, /20 秒内只做一次/);
  // 上一条还在跑：并发挡住
  r.clock.now = NOW + 40000;
  r.company.hubAdmin.filesRunning = true;
  r.company.hubAdmin.receive({ type: 'hub-admin', op: 'files', id: 'HA-1020-cccccc', gen: r.company.link.gen(), action: 'read', params: { file: 'out/a.txt' } });
  await r.company.hubAdmin.filesTask;
  assert.match(r.company.hubAdmin.state().history[0].note, /上一条文件读取还在跑/);
  r.company.hubAdmin.filesRunning = false;
});

test('指令闸门：不认识的 op / 过期的配对代次 / 不合法编号一律不处理；旧版公司 Hub 在家里就被挡住', async t => {
  const { root } = fixture(t);
  const r = rig(t);
  r.company.setSettings({ resultDirs: [root] });
  await pair(r);
  assert.equal(r.company.hubAdmin.receive({ type: 'hub-admin', op: 'files', id: 'HA-1020-aaaaaa', gen: 'old-gen', action: 'read', params: { file: 'out/a.txt' } }), true);
  assert.equal(r.company.hubAdmin.receive({ type: 'hub-admin', op: 'files', id: 'bad id!', gen: r.company.link.gen(), action: 'read', params: { file: 'out/a.txt' } }), true);
  assert.equal(r.company.hubAdmin.filesTask, undefined);
  assert.equal(r.company.hubAdmin.state().lastFilesAt, undefined);
  // 公司报过版本却没有 files 能力：家里直接说明，不白等
  const st = r.home.store.get('hubAdmin');
  r.home.store.set('hubAdmin', { ...st, company: { current: '2.1.16', latest: null, at: NOW, caps: ['diag', 'act'] } });
  await assert.rejects(r.home.hubAdmin({ op: 'files', action: 'read', params: { file: 'out/a.txt' } }), /公司 Hub 版本过旧（v2\.1\.16），不支持读文件/);
});

test('公司端不认识的动作、不在可读目录里的路径：都回报成一句话，不给对端错误码', async t => {
  const { root, outside } = fixture(t);
  const r = rig(t);
  r.company.setSettings({ resultDirs: [root] });
  await pair(r);
  r.company.hubAdmin.receive({ type: 'hub-admin', op: 'files', id: 'HA-1020-dddddd', gen: r.company.link.gen(), action: 'delete', params: { file: 'out/a.txt' } });
  await r.company.hubAdmin.filesTask;
  assert.match(r.company.hubAdmin.state().history[0].note, /读文件：不认识的动作/);
  const sent = await r.home.hubAdmin({ op: 'files', action: 'read', params: { file: path.join(outside, 'z.txt') } });
  await r.company.checkNow(); await r.company.hubAdmin.filesTask; await r.home.checkNow();
  const view = r.home.filesView(sent.id);
  assert.equal(view.status, '公司报错');
  assert.match(view.note, /不在可读目录里/);
  assert.ok(!view.note.includes('ENOENT:'), '不回传原始系统错误字样');
});

test('MCP company_files：只读、不排队、不占 CodeAgent；命令行 --files 参数原样交给本机 Hub，id 取旧结果', async t => {
  const { listTools } = require('../scripts/company-bridge-mcp');
  const tool = listTools({}).find(x => x.name === 'company_files');
  assert.ok(tool && tool.annotations.readOnlyHint === true && !tool.annotations.destructiveHint, '只读，不标破坏性');
  assert.deepEqual(tool.inputSchema.properties.action.enum, F.ACTIONS);
  assert.deepEqual(tool.inputSchema.required, ['action']);
  assert.match(tool.description, /只读、永不写/);
  assert.match(tool.description, /不占公司 CodeAgent/);
  assert.match(tool.description, /大文件不要一次读完/);
  const http = require('node:http'), { spawn } = require('node:child_process');
  const bodies = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { bodies.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: {} })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const endpoint = path.join(dir, 'mcp-endpoint.json');
  fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/tool` }));
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'company-ask.js'), ...args], { env: { ...process.env, HUB_BRIDGE_SESSION_ID: 's1', HUB_BRIDGE_SESSION_PASS: 'p', HUB_BRIDGE_ENDPOINT_FILE: endpoint }, windowsHide: true });
    child.on('close', code => resolve(code));
  });
  assert.equal(await run(['--files', 'list', '--dir', 'out/case1', '--depth', '1', '--all', '--limit', '50']), 0);
  assert.equal(await run(['--files', 'search', '--name', '*.txt', '--root', 'out', '--maxkb', '1024']), 0);
  assert.equal(await run(['--files', 'read', '--file', 'out/case1/summary.csv', '--from', '11', '--lines', '200', '--chars', '20000']), 0);
  assert.equal(await run(['--files', 'read', '--id', 'HA-1020-abc123']), 0);
  assert.deepEqual(bodies.map(b => [b.name, b.arguments]), [
    ['company_files', { action: 'list', dir: 'out/case1', depth: 1, all: true, limit: 50 }],
    ['company_files', { action: 'search', name: '*.txt', root: 'out', maxKB: 1024 }],
    ['company_files', { action: 'read', file: 'out/case1/summary.csv', from: 11, lines: 200, chars: 20000 }],
    ['company_files', { action: 'read', id: 'HA-1020-abc123' }]]);
});

test('界面契约：设置页有「文件读取」开关和「额外可读目录」，保存时一起提交；状态查看的说明指向它', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'home-link.js'), 'utf8');
  assert.match(ui, /data-hl-f="allowRemoteFiles"/);
  assert.match(ui, /data-hl-f="readRoots"/);
  assert.match(ui, /allowRemoteFiles: field\('allowRemoteFiles'\)\.value === '1'/);
  assert.match(ui, /readRoots: field\('readRoots'\)\.value/);
  assert.match(ui, /要读文件用下面的「文件读取」/);
  // 公司端界面用「对端」：只有「向家里求助」那一节按设计写明家里，这两栏里不能出现
  const rows = ui.split('data-hl-f="allowRemoteFiles"')[1].split("data-hl-f=\"allowRemoteMaintain\"")[0];
  assert.ok(rows.includes('readRoots') && !rows.includes('家里'), '这两栏的文字里不出现「家里」');
  assert.match(rows, /只读、永不写/);
  assert.match(rows, /密钥类后缀和二进制直接拒绝/);
});

test('额外的可读目录（readRoots）也算可读；开关与目录清单一起写进设置', async t => {
  const { root, outside } = fixture(t);
  const r = rig(t);
  r.company.setSettings({ resultDirs: [], codeRoots: [root] });
  await pair(r);
  const sent = await r.home.hubAdmin({ op: 'files', action: 'read', params: { file: path.join(outside, 'z.txt') } });
  await r.company.checkNow(); await r.company.hubAdmin.filesTask; await r.home.checkNow();
  assert.match(r.home.filesView(sent.id).note, /不在可读目录里/, '代码位置之外的目录读不到');
  r.company.setSettings({ readRoots: [outside] });
  assert.deepEqual(F.fileRoots(r.company), [root, outside]);
  r.clock.now += 6000;
  const ok = await r.home.hubAdmin({ op: 'files', action: 'read', params: { file: path.join(outside, 'z.txt') } });
  await r.company.checkNow(); await r.company.hubAdmin.filesTask; await r.home.checkNow();
  assert.deepEqual(r.home.filesView(ok.id).result.lines, ['不在可读目录里的文件']);
  assert.equal(r.company.settings().allowRemoteFiles, true, '默认开');
  assert.throws(() => r.company.setSettings({ readRoots: Array.from({ length: 11 }, (_, i) => 'D:\\d' + i) }), /最多 10 个/);
});