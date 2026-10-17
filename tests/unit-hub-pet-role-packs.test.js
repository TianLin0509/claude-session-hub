'use strict';
// 桌宠形象包（2026-10-17）：目录与包的校验、安装、列表、下载（本地假源）、设置回落、公司导出只带两只。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validatePack, validateCatalog, createRolePackStore } = require('../core/hub-pet/role-packs');
const { createSettingsStore } = require('../core/hub-pet/settings');
const { buildPacks } = require('../scripts/build-hub-pet-packs');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'renderer', 'assets', 'hub-pet');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-packs-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// 只带小猫、企鹅的「公司版」资产目录（复制 manifest 与两只的图）。
function companyAssets() {
  const dir = tmp();
  fs.copyFileSync(path.join(ASSETS, 'manifest.json'), path.join(dir, 'manifest.json'));
  for (const id of ['01-cat', '03-penguin', 'thumbs']) fs.cpSync(path.join(ASSETS, id), path.join(dir, id), { recursive: true });
  return dir;
}
function packFiles() {
  const out = tmp();
  const catalog = buildPacks({ assetsDir: ASSETS, out, version: '1.0.0', ids: ['05-rabbit', '07-shiba'] });
  return { out, catalog };
}
// 假 fetch：按文件名从目录里读，可选篡改。
function fakeFetch(dir, { tamper = null } = {}) {
  return async url => {
    const name = decodeURIComponent(String(url).split('/').pop());
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    let body = fs.readFileSync(file);
    if (tamper && name === tamper) body = Buffer.concat([body, Buffer.from(' ')]);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
  };
}
const SOURCES = [{ id: 'local', name: '本地', manifest: 'http://pets.test/catalog.json', files: 'http://pets.test/' }];

test('包校验：只收白名单文件名的 WebP，缺姿态、坏图、坏名字都拒绝', () => {
  const { out } = packFiles();
  const good = JSON.parse(fs.readFileSync(path.join(out, '05-rabbit-1.0.0.json'), 'utf8'));
  assert.equal(validatePack(good).id, '05-rabbit');
  const bad = patch => ({ ...good, ...patch });
  assert.throws(() => validatePack(bad({ files: { ...good.files, '../evil.webp': good.files['idle.webp'] } })), /不允许的文件/);
  assert.throws(() => validatePack(bad({ files: { ...good.files, 'run.js': good.files['idle.webp'] } })), /不允许的文件/);
  const png = 'data:image/webp;base64,' + Buffer.from('\x89PNG\r\n\x1a\n0000000000000000').toString('base64');
  assert.throws(() => validatePack(bad({ files: { ...good.files, 'idle.webp': png } })), /不是有效的 WebP/);
  const { 'sleep.webp': _drop, ...noSleep } = good.files;
  assert.throws(() => validatePack(bad({ files: noSleep })), /缺少 sleep\.webp/);
  assert.throws(() => validatePack(bad({ id: '../x' })), /标识或版本无效/);
  assert.throws(() => validatePack(bad({ meta: { poses: ['typing'] } })), /姿态清单无效/);
});

test('目录校验：文件名必须是 <id>-<version>.json，sha256 必须是 64 位十六进制', () => {
  const { catalog } = packFiles();
  assert.equal(validateCatalog(catalog).packs.length, 2);
  assert.throws(() => validateCatalog({ ...catalog, packs: [{ ...catalog.packs[0], file: 'other.json' }] }), /字段无效/);
  assert.throws(() => validateCatalog({ ...catalog, packs: [{ ...catalog.packs[0], sha256: 'abc' }] }), /字段无效/);
  assert.throws(() => validateCatalog({ ...catalog, packs: [catalog.packs[0], catalog.packs[0]] }), /字段无效/);
});

test('列表：公司资产只带小猫企鹅（内置），其余 4 只未安装但有预览图', () => {
  const store = createRolePackStore({ assetsDir: companyAssets(), dataDir: tmp(), sources: SOURCES, fetchImpl: async () => { throw new Error('不该联网'); } });
  const roles = store.listRoles();
  assert.deepEqual(roles.filter(r => r.installed).map(r => r.id), ['01-cat', '03-penguin']);
  assert.ok(roles.filter(r => r.installed).every(r => r.bundled));
  const rabbit = roles.find(r => r.id === '05-rabbit');
  assert.equal(rabbit.installed, false);
  assert.equal(rabbit.previewMain, 'assets/hub-pet/thumbs/05-rabbit.webp');
  assert.equal(store.assetBase('01-cat'), '../assets/hub-pet/01-cat/');
  assert.equal(store.assetBase('05-rabbit'), null);
});

test('下载：本地源下载兔子，核对后装进数据目录；file:// 资产地址；篡改的包不装、原状不变', async () => {
  const { out } = packFiles();
  const dataDir = tmp();
  const events = [];
  const store = createRolePackStore({ assetsDir: companyAssets(), dataDir, sources: SOURCES, fetchImpl: fakeFetch(out), emit: (ch, s) => events.push([ch, s.state.phase]) });
  const snap = await store.download('05-rabbit');
  assert.equal(snap.state.phase, 'installed', JSON.stringify(snap.state));
  assert.ok(store.installed('05-rabbit'));
  assert.ok(fs.existsSync(path.join(dataDir, 'hub-pet', 'roles', '05-rabbit', 'idle.webp')));
  assert.match(store.assetBase('05-rabbit'), /^file:\/\/.*\/hub-pet\/roles\/05-rabbit\/$/);
  assert.deepEqual(store.meta('05-rabbit').poses, ['idle', 'typing', 'happy', 'sleep']);
  assert.ok(events.some(([ch, p]) => ch === 'hub-pet:roles-state' && p === 'downloading'));
  // 目录里有的、下载时被改了一个字节的包：校验不过，不装
  const store2 = createRolePackStore({ assetsDir: companyAssets(), dataDir: tmp(), sources: SOURCES, fetchImpl: fakeFetch(out, { tamper: '07-shiba-1.0.0.json' }) });
  const bad = await store2.download('07-shiba');
  assert.equal(bad.state.phase, 'error');
  assert.equal(bad.state.failedId, '07-shiba');
  assert.equal(store2.installed('07-shiba'), false);
  // 目录连不上：报人话，已安装的照常
  const store3 = createRolePackStore({ assetsDir: companyAssets(), dataDir: tmp(), sources: SOURCES, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  const off = await store3.check();
  assert.equal(off.state.phase, 'error');
  assert.match(off.state.error, /已安装的形象照常可用/);
  assert.ok(store3.installed('01-cat'));
});

test('安装：重装同一形象整目录替换，不留临时目录；坏包不动已装的', () => {
  const { out } = packFiles();
  const dataDir = tmp();
  const store = createRolePackStore({ assetsDir: companyAssets(), dataDir });
  const raw = JSON.parse(fs.readFileSync(path.join(out, '05-rabbit-1.0.0.json'), 'utf8'));
  store.install(raw);
  store.install(raw);
  const rolesDir = path.join(dataDir, 'hub-pet', 'roles');
  assert.deepEqual(fs.readdirSync(rolesDir), ['05-rabbit']);
  assert.throws(() => store.install({ ...raw, files: { ...raw.files, 'x.exe': raw.files['idle.webp'] } }), /不允许的文件/);
  assert.ok(store.installed('05-rabbit'));
  assert.deepEqual(fs.readdirSync(rolesDir), ['05-rabbit']);
});

test('设置：存的形象没装（换到只带两只的版本）时回落小猫；装了就保留', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '07-shiba', mode: 'gentle' }));
  const installed = new Set(['01-cat', '03-penguin']);
  const s = createSettingsStore({ dataDir, company: true, roleOk: id => installed.has(id) });
  assert.equal(s.get().role, '01-cat');
  assert.equal(s.update({ role: '09-hamster' }).role, '01-cat');
  installed.add('09-hamster');
  assert.equal(s.update({ role: '09-hamster' }).role, '09-hamster');
  assert.equal(s.get().peekOnFullscreen, true);
  assert.equal(s.update({ peekOnFullscreen: false }).peekOnFullscreen, false);
});

test('公司导出：去掉兔子/柴犬/仓鼠/玄凤的整套图，保留缩略图；形象包脚本产出的 sha 与文件一致', () => {
  const target = JSON.parse(fs.readFileSync(path.join(ROOT, 'community', 'targets', 'company', 'target.json'), 'utf8'));
  for (const id of ['05-rabbit', '07-shiba', '09-hamster', '11-cockatiel']) assert.ok(target.drop.includes(`renderer/assets/hub-pet/${id}/**`), id);
  assert.ok(!target.drop.some(d => /hub-pet\/(01-cat|03-penguin|thumbs)/.test(d)));
  for (const id of ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel']) assert.ok(fs.existsSync(path.join(ASSETS, 'thumbs', id + '.webp')), id);
  const { out, catalog } = packFiles();
  for (const p of catalog.packs) { const b = fs.readFileSync(path.join(out, p.file)); assert.equal(b.length, p.bytes); assert.equal(sha(b), p.sha256); }
});

test('接线：桌宠渲染端从 assetBase 取图；设置页模块与样式挂上；主进程把 net.fetch 和测试源传给控制器', () => {
  const pet = fs.readFileSync(path.join(ROOT, 'renderer', 'hub-pet', 'pet.js'), 'utf8');
  assert.match(pet, /state\.assetBase \|\|/);
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /AI_HUB_PET_SOURCES/);
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const tab = html.indexOf('styles/pet-settings-tab.css'), controls = html.indexOf('styles/controls.css');
  assert.ok(tab > 0 && tab < controls, '桌宠分页样式在 controls.css 之前加载');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'pet-settings-tab.css'), 'utf8');
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|})\s*[^{}@]+(?={)/g).map(s => s.replace(/^}/, '').trim());
  for (const sel of selectors) for (const part of sel.split(',')) assert.match(part.trim(), /^\.pet-tab/, `样式只用 pet-tab- 前缀：${part}`);
  assert.equal(typeof require('../renderer/hub-pet/pet-settings-tab.js').mountPetSettingsTab, 'function');
});
