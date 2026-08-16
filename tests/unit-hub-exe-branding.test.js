'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BRANDED_EXE_NAME,
  BRAND_STAMP_NAME,
  brandedExePathFor,
  cleanupStaleBrandedExes,
  describeBrandingHealth,
  ensureBrandedHubExe,
  inspectBrandedHubExe,
  isBrandedExePath,
  parseVersionQuad,
  readBrandStamp,
  resolveHostExePath,
  resolveHubLaunchExePath,
} = require('../core/hub-exe-branding.js');
const { repointHubDesktopShortcuts } = require('../core/windows-shell-integration.js');

// 真 resedit 要吃一个合法 PE，单测里没必要也不该扛 220MB。只验证本模块的
// 编排逻辑（何时重建、stamp 怎么比、旧副本怎么让位），资源改写交给真机验证。
function makeFakeResedit() {
  const calls = { icons: 0, versionStrings: [] };
  const versionInfo = {
    setFileVersion() {},
    setProductVersion() {},
    setStringValues(_lang, values) { calls.versionStrings.push(values); },
    outputToResourceEntries() {},
  };
  return {
    calls,
    lib: {
      NtExecutable: { from: (buf) => ({ generate: () => Buffer.concat([buf, Buffer.from('|branded')]) }) },
      NtExecutableResource: { from: () => ({ entries: [], outputResource() {} }) },
      Data: { IconFile: { from: (ico) => ({ icons: [{ data: ico }] }) } },
      Resource: {
        IconGroupEntry: { replaceIconsForResource() { calls.icons += 1; } },
        VersionInfo: { fromEntries: () => [versionInfo], createEmpty: () => versionInfo },
      },
    },
  };
}

function makeHarness({ hostBytes = 4096 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-exe-brand-'));
  const appRoot = path.join(temp, 'claude-session-hub');
  const distDir = path.join(appRoot, 'node_modules', 'electron', 'dist');
  const hostExePath = path.join(distDir, 'electron.exe');
  const icoPath = path.join(appRoot, 'claude-wx.ico');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(hostExePath, Buffer.alloc(hostBytes, 7));
  fs.writeFileSync(icoPath, 'ICO-V1');
  return {
    temp,
    appRoot,
    distDir,
    hostExePath,
    icoPath,
    brandedExePath: path.join(distDir, BRANDED_EXE_NAME),
    stampPath: path.join(distDir, BRAND_STAMP_NAME),
    opts(extra = {}) {
      return {
        execPath: hostExePath,
        icoPath,
        productVersion: '1.6.10',
        platform: 'win32',
        minExeBytes: 1024,
        ...extra,
      };
    },
    cleanup() { fs.rmSync(temp, { recursive: true, force: true }); },
  };
}

test('品牌化副本名与宿主 exe 互相解析', () => {
  const branded = brandedExePathFor('C:\\hub\\node_modules\\electron\\dist\\electron.exe');
  assert.equal(path.basename(branded), BRANDED_EXE_NAME);
  assert.equal(isBrandedExePath(branded), true);
  assert.equal(isBrandedExePath('C:\\hub\\electron.exe'), false);
  // 已经从副本启动时，"宿主"仍然是同目录的 electron.exe，否则会拿副本去改副本。
  assert.equal(path.basename(resolveHostExePath(branded)), 'electron.exe');
  assert.equal(path.basename(resolveHostExePath('C:\\x\\electron.exe')), 'electron.exe');
});

test('版本号被夹到 PE 允许的 4 段 16 位整数', () => {
  assert.deepEqual(parseVersionQuad('1.6.10'), [1, 6, 10, 0]);
  // 预发布标签不是数字，落到 0；PE 的 VS_FIXEDFILEINFO 只能存四个整数。
  assert.deepEqual(parseVersionQuad('2.0.0-beta.3'), [2, 0, 0, 0]);
  assert.deepEqual(parseVersionQuad('99999.1'), [65535, 1, 0, 0]);
  assert.deepEqual(parseVersionQuad(''), [0, 0, 0, 0]);
});

test('副本不存在时 inspect 报缺失，启动路径回落 electron.exe', () => {
  const h = makeHarness();
  try {
    const inspection = inspectBrandedHubExe(h.opts());
    assert.equal(inspection.ok, false);
    assert.equal(inspection.reason, 'branded-exe-missing');
    // 回落是硬要求：品牌化随时可能失败，桌面图标绝不能因此点不开。
    assert.equal(resolveHubLaunchExePath(h.opts()), h.hostExePath);
    assert.match(describeBrandingHealth(h.opts()).message, /npm install/);
  } finally { h.cleanup(); }
});

test('首次生成写出副本与 stamp，且完全不碰 electron.exe', () => {
  const h = makeHarness();
  try {
    const before = fs.readFileSync(h.hostExePath);
    const fake = makeFakeResedit();
    const result = ensureBrandedHubExe(h.opts({ resedit: fake.lib, productName: 'AI 群聊 Hub' }));

    assert.equal(result.changed, true);
    assert.equal(result.reason, 'branded-exe-missing');
    assert.equal(fs.existsSync(h.brandedExePath), true);
    assert.equal(fake.calls.icons, 1);
    assert.equal(fake.calls.versionStrings[0].FileDescription, 'AI 群聊 Hub');
    // node_modules 完整性铁律：宿主 exe 必须一个字节都没变。
    assert.deepEqual(fs.readFileSync(h.hostExePath), before);

    const stamp = readBrandStamp(h.stampPath);
    assert.equal(stamp.productVersion, '1.6.10');
    assert.equal(stamp.hostSize, before.length);
    // 启动路径这时才切到副本。
    assert.equal(resolveHubLaunchExePath(h.opts()), h.brandedExePath);
  } finally { h.cleanup(); }
});

test('stamp 对得上就不重复生成 220MB 副本', () => {
  const h = makeHarness();
  try {
    ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib }));
    const mtimeBefore = fs.statSync(h.brandedExePath).mtimeMs;
    const fake = makeFakeResedit();
    const again = ensureBrandedHubExe(h.opts({ resedit: fake.lib }));

    assert.equal(again.changed, false);
    assert.equal(again.reason, 'current');
    assert.equal(fake.calls.icons, 0);
    assert.equal(fs.statSync(h.brandedExePath).mtimeMs, mtimeBefore);
  } finally { h.cleanup(); }
});

test('图标换了会让 stamp 失效并重建', () => {
  const h = makeHarness();
  try {
    ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib }));
    fs.writeFileSync(h.icoPath, 'ICO-V2-DIFFERENT');

    assert.equal(inspectBrandedHubExe(h.opts()).reason, 'stamp-stale');
    const fake = makeFakeResedit();
    const result = ensureBrandedHubExe(h.opts({ resedit: fake.lib }));
    assert.equal(result.changed, true);
    assert.equal(fake.calls.icons, 1);
    assert.equal(inspectBrandedHubExe(h.opts()).ok, true);
  } finally { h.cleanup(); }
});

test('Electron 升级（宿主 exe 变化）同样触发重建', () => {
  const h = makeHarness();
  try {
    ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib }));
    fs.writeFileSync(h.hostExePath, Buffer.alloc(8192, 9));

    // 过期的副本是老版本 Electron 配新版 resources，起不来。宁可先回落 electron.exe。
    assert.equal(inspectBrandedHubExe(h.opts()).reason, 'stamp-stale');
    assert.equal(resolveHubLaunchExePath(h.opts()), h.hostExePath);
    assert.equal(ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib })).changed, true);
    assert.equal(resolveHubLaunchExePath(h.opts()), h.brandedExePath);
  } finally { h.cleanup(); }
});

test('重建时旧副本改名让位（可能正被运行中的 Hub 锁着，删不掉）', () => {
  const h = makeHarness();
  try {
    ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib }));
    fs.writeFileSync(h.icoPath, 'ICO-V2');

    // 模拟旧副本被占用：改名成功但删不掉。
    const realRm = fs.rmSync;
    let renamed = null;
    const fsModule = {
      ...fs,
      renameSync(from, to) { if (String(to).includes('.stale-')) renamed = to; return fs.renameSync(from, to); },
      rmSync(target, options) {
        if (String(target).includes('.stale-')) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
        return realRm(target, options);
      },
    };
    const result = ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib, fsModule }));

    assert.equal(result.changed, true);
    assert.ok(renamed, '旧副本应被改名而不是就地覆盖');
    assert.equal(fs.existsSync(renamed), true);
    assert.equal(inspectBrandedHubExe(h.opts()).ok, true);

    // 下一次启动（不再被锁）应把残留清干净。
    const removed = cleanupStaleBrandedExes({ hostExePath: h.hostExePath });
    assert.equal(removed.length, 1);
    assert.equal(fs.existsSync(renamed), false);
  } finally { h.cleanup(); }
});

test('写了一半的副本按不可用处理，不会被挂到快捷方式上', () => {
  const h = makeHarness();
  try {
    ensureBrandedHubExe(h.opts({ resedit: makeFakeResedit().lib }));
    fs.writeFileSync(h.brandedExePath, 'truncated');
    assert.equal(inspectBrandedHubExe(h.opts()).reason, 'branded-exe-truncated');
    assert.equal(resolveHubLaunchExePath(h.opts()), h.hostExePath);
  } finally { h.cleanup(); }
});

test('resedit 抛错时保持原状并回落，不留半个 exe', () => {
  const h = makeHarness();
  try {
    const exploding = makeFakeResedit().lib;
    exploding.NtExecutable.from = () => { throw new Error('bad PE'); };
    const result = ensureBrandedHubExe(h.opts({ resedit: exploding, logger: { warn() {} } }));

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'branding-failed');
    assert.match(result.error, /bad PE/);
    assert.equal(fs.existsSync(h.brandedExePath), false);
    assert.equal(fs.readdirSync(h.distDir).filter(n => n.includes('.tmp-')).length, 0);
    assert.equal(resolveHubLaunchExePath(h.opts()), h.hostExePath);
  } finally { h.cleanup(); }
});

test('非 Windows 完全不动文件系统', () => {
  const h = makeHarness();
  try {
    const result = ensureBrandedHubExe(h.opts({ platform: 'darwin', resedit: makeFakeResedit().lib }));
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'not-win32');
    assert.equal(fs.existsSync(h.brandedExePath), false);
  } finally { h.cleanup(); }
});

test('桌面上指向同一个 Hub 的启动器会一起换到新 exe，其它快捷方式不动', () => {
  const h = makeHarness();
  try {
    const desktopDir = path.join(h.temp, 'Desktop');
    fs.mkdirSync(desktopDir, { recursive: true });
    const links = new Map();
    const put = (name, details) => {
      const p = path.join(desktopDir, name);
      fs.writeFileSync(p, 'lnk');
      links.set(path.resolve(p), details);
      return path.resolve(p);
    };
    const hubArgs = `"${path.resolve(h.appRoot)}"`;
    const claudeWx = put('claudeWX.lnk', {
      target: h.hostExePath, args: hubArgs, cwd: h.appRoot, icon: h.icoPath, description: '自定义备注',
    });
    const otherApp = put('Cursor.lnk', {
      target: 'C:\\Program Files\\cursor\\Cursor.exe', args: '', cwd: 'C:\\Program Files\\cursor',
    });
    // 同一个 electron dist 起的**别的**项目：args 不是本 Hub 的 appRoot，必须放过。
    const otherElectronApp = put('Sibling.lnk', {
      target: h.hostExePath, args: '"C:\\some\\other\\project"', cwd: 'C:\\some\\other\\project',
    });

    const shell = {
      readShortcutLink(p) {
        const v = links.get(path.resolve(p));
        if (!v) throw new Error('missing');
        return { ...v };
      },
      writeShortcutLink(p, _op, details) { links.set(path.resolve(p), { ...details }); return true; },
    };

    const repointed = repointHubDesktopShortcuts({
      shell,
      desktopDir,
      appRoot: h.appRoot,
      fromExecDir: h.distDir,
      toExecPath: h.brandedExePath,
    });

    assert.deepEqual(repointed, [claudeWx]);
    assert.equal(links.get(claudeWx).target, h.brandedExePath);
    assert.equal(links.get(claudeWx).description, '自定义备注', '用户自己写的备注要保留');
    assert.equal(links.get(claudeWx).icon, h.icoPath);
    assert.equal(links.get(otherApp).target, 'C:\\Program Files\\cursor\\Cursor.exe');
    assert.equal(links.get(otherElectronApp).target, h.hostExePath);

    // 幂等：再跑一次没有可改的了。
    assert.deepEqual(
      repointHubDesktopShortcuts({ shell, desktopDir, appRoot: h.appRoot, fromExecDir: h.distDir, toExecPath: h.brandedExePath }),
      []
    );
  } finally { h.cleanup(); }
});
