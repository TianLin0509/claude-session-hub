'use strict';
// 把 renderer/assets/hub-pet/ 里的形象打成在线下载用的形象包（2026-10-17）：
//   node scripts/build-hub-pet-packs.js --out <目录> [--version 1.0.0] [--ids 05-rabbit,07-shiba,...]
// 产出 <id>-<version>.json（schema 1，图片为 webp data URI）和 catalog.json（字节数 + SHA-256）。
// 上架顺序：先传全部包，最后传 catalog.json（和 AI 头像包同一个规矩，见 docs/appearance-packs.md）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validatePack, validateCatalog } = require('../core/hub-pet/role-packs');
const { ROLES } = require('../core/hub-pet/state');

const DEFAULT_IDS = ['05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'];
const DESCRIPTIONS = { '05-rabbit': '软萌兔子，待机、打字、欢呼、打盹四个姿态', '07-shiba': '元气柴犬，待机、打字、欢呼、打盹四个姿态',
  '09-hamster': '圆滚仓鼠，待机、打字、欢呼、打盹四个姿态', '11-cockatiel': '玄凤鹦鹉，待机、打字、欢呼、打盹四个姿态' };

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }

function buildPacks({ assetsDir, out, version = '1.0.0', ids = DEFAULT_IDS }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  const packs = [];
  for (const id of ids) {
    const meta = manifest[id];
    if (!meta) throw new Error(`manifest.json 里没有 ${id}`);
    const files = {};
    for (const pose of meta.poses) files[pose + '.webp'] = 'data:image/webp;base64,' + fs.readFileSync(path.join(assetsDir, id, pose + '.webp')).toString('base64');
    for (const seq of meta.sequences || []) files['seq-' + seq + '.webp'] = 'data:image/webp;base64,' + fs.readFileSync(path.join(assetsDir, id, 'seq-' + seq + '.webp')).toString('base64');
    const name = (ROLES.find(r => r.id === id) || {}).name || id;
    const pack = { schema: 1, id, version, name, description: DESCRIPTIONS[id] || '', meta, files };
    validatePack(pack);
    const body = Buffer.from(JSON.stringify(pack));
    const file = `${id}-${version}.json`;
    fs.writeFileSync(path.join(out, file), body);
    packs.push({ id, version, file, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), name, description: pack.description });
  }
  const catalog = validateCatalog({ schema: 1, version, packs });
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog, null, 1));
  return catalog;
}

if (require.main === module) {
  const out = arg('--out');
  if (!out) { console.error('用法：node scripts/build-hub-pet-packs.js --out <目录> [--version 1.0.0] [--ids a,b]'); process.exit(2); }
  const catalog = buildPacks({ assetsDir: path.join(__dirname, '..', 'renderer', 'assets', 'hub-pet'), out: path.resolve(out),
    version: arg('--version', '1.0.0'), ids: arg('--ids') ? arg('--ids').split(',') : DEFAULT_IDS });
  for (const p of catalog.packs) console.log(`${p.file}  ${p.bytes} 字节  ${p.sha256}`);
  console.log('catalog.json 已写好：先上传全部包，最后上传 catalog.json');
}

module.exports = { buildPacks, DEFAULT_IDS };
