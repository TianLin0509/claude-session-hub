'use strict';
// 整理桌面·一键收纳（2026-10-14）：按类型归纳、按模式一键收纳；公司版图标排列失败（导出漏脚本、乱码横幅）的修复。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopOrganizer, categoryOf } = require('../core/desktop-organizer');
const { createDesktopIconLayout, failureDetail, decodeOutput } = require('../core/desktop-icon-layout');
(async () => {
  // 类型归纳
  const cases = { '汇报.pptx': '演示', 'a.docx': '文档', 'b.xlsx': '表格', 'c.pdf': 'PDF', 'd.PNG': '图片', 'e.zip': '压缩包', 'setup.exe': '安装包', 'f.py': '代码', 'g.dat': '其他', 'Excel.lnk': '快捷方式', 'run.bat': '快捷方式' };
  for (const [name, expected] of Object.entries(cases)) assert.equal(categoryOf(name, false), expected, name);
  assert.equal(categoryOf('资料', true), '文件夹');

  // 一键收纳：按模式，不传逐项清单
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-desktop-oneclick-'));
  const desktop = path.join(root, 'Desktop');
  await fs.mkdir(desktop);
  for (const name of ['报告.docx', '图.png', 'Excel.lnk']) await fs.writeFile(path.join(desktop, name), name);
  const service = createDesktopOrganizer({ testRoot: root });
  let plan = await service.scan();
  assert.ok(plan.items.every(item => item.category), '每一项都带类型');
  assert.match(plan.batch, /^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{8}$/, '批次名：本地时间 + 短编号');
  await assert.rejects(service.execute({ id: plan.id, mode: 'weird' }), /未知的收纳方式/);
  const kept = await service.execute({ id: plan.id, mode: 'keep-launchers' });
  assert.equal(kept.moved, 2);
  assert.ok(fsSync.existsSync(path.join(desktop, 'Excel.lnk')), '保留快捷方式');
  assert.ok(fsSync.existsSync(path.join(service.archive, plan.batch, '文档', '报告.docx')));
  assert.ok(fsSync.existsSync(path.join(service.archive, plan.batch, '图片', '图.png')));
  plan = await service.scan();
  await assert.rejects(service.execute({ id: plan.id, mode: 'keep-launchers' }), /没有需要收纳/, '只剩快捷方式时保留模式无事可做');
  plan = await service.scan();
  const all = await service.execute({ id: plan.id, mode: 'all' });
  assert.equal(all.moved, 1);
  assert.ok(fsSync.existsSync(path.join(service.archive, plan.batch, '快捷方式', 'Excel.lnk')), '全部收走：快捷方式进「快捷方式」');
  assert.equal((await service.undo()).restored, 1, '撤销最近一次');

  // 图标排列：缺脚本直接说清；PowerShell 的横幅不当错误；GBK 输出能读
  await assert.rejects(createDesktopIconLayout({ platform: 'win32', exists: () => false }).arrange(), /缺少排列脚本 desktop-icon-layout\.ps1，请更新 Hub/);
  const gbk = Buffer.from([0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd]); // 「找不到」
  assert.equal(decodeOutput(gbk), '找不到');
  const banner = Buffer.concat([Buffer.from('Windows PowerShell\r\n'), Buffer.from([0xb0, 0xe6, 0xc8, 0xa8, 0xcb, 0xf9, 0xd3, 0xd0]), Buffer.from(' (C) Microsoft Corporation\r\n\r\n')]);
  assert.equal(failureDetail({ stdout: banner, stderr: Buffer.concat([gbk, Buffer.from(' x.ps1')]), message: 'exit 1' }), '找不到 x.ps1');
  assert.equal(failureDetail({ stdout: Buffer.from(JSON.stringify({ ok: false, error: 'Explorer unavailable' })), message: 'exit 1' }), 'Explorer unavailable');
  let args;
  await createDesktopIconLayout({ platform: 'win32', exists: () => true, run: async (_exe, a, options) => { args = { a, options }; return { stdout: Buffer.from(JSON.stringify({ ok: true, after: { flags: 0x801, spacingX: 90, spacingY: 100, icons: [] } })) }; } }).arrange();
  assert.ok(args.a.includes('-ExecutionPolicy') && args.a.includes('Bypass') && args.a.includes('-NoLogo'), '只对这次调用放开执行策略、不出横幅');
  assert.equal(args.options.encoding, 'buffer', '按字节收，自己判断编码');

  // 公司/社区版导出带上排列脚本
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'community', 'manifest.json'), 'utf8'));
  for (const file of ['scripts/desktop-icon-layout.ps1', 'scripts/desktop-icon-layout.cs']) assert.ok(manifest.include.includes(file), file);
  await fs.rm(root, { recursive: true, force: true });
  console.log('PASS desktop one-click: categories, mode-based archive, readable layout errors, export ships layout scripts');
})().catch(error => { console.error(error); process.exitCode = 1; });
