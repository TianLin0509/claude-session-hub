'use strict';
// 程序生成的彩色噪声图；只在本机测试使用，不包含用户或公司图片。
const zlib = require('node:zlib');
function crc(b) { let c = 0xffffffff; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(tag, data) { const type = Buffer.from(tag), n = Buffer.alloc(4), checksum = Buffer.alloc(4); n.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([n, type, data, checksum]); }
function generatedPng(width = 100, height = 100) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height); let seed = 179;
  for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[y * (width * 3 + 1) + x] = seed >>> 24; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const { probeImage } = require('../../core/company-bridge/image-probe');
const fixtureCodec = {
  compress: async (buffer, options) => { if (buffer.length > options.maxBytes) throw new Error('fixture exceeds budget'); const info = probeImage(buffer); return { buffer, ...info, originalWidth: info.width, originalHeight: info.height, lossy: false, resized: false, quality: null }; },
  validate: async buffer => probeImage(buffer),
};
module.exports = { generatedPng, fixtureCodec };
