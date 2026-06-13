'use strict';

// Artifact 文件服务：通过 outbound WSS 协议给 PWA 发本地 HTML/artifact 内容。
//
// 安全设计：
//   - 路径白名单：只允许 ~/Desktop/claude-artifacts/ 下的文件
//   - 扩展名白名单：.html / .htm / .svg / .png / .jpg / .json / .md / .txt
//   - 大小限制：单文件 ≤ 5MB（base64 后约 7MB，WSS 帧能扛）
//   - device token 校验（在 index.js 路由层做，传到这里时已确认）

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.json', '.md', '.txt', '.css', '.js']);

function getAllowedRoot() {
  // 白名单根目录（用户铁律：HTML artifact 存 Desktop\claude-artifacts）
  return path.join(os.homedir(), 'Desktop', 'claude-artifacts');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

class ArtifactServer {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.root = getAllowedRoot();
  }

  // 返回 { ok: true, contentBase64, mimeType, size } 或 { ok: false, error }
  fetch(requestedPath) {
    if (!requestedPath || typeof requestedPath !== 'string') {
      return { ok: false, error: 'invalid_path' };
    }
    let resolved;
    try {
      // 支持 Windows 反斜杠 + Unix 正斜杠混用
      const normalized = requestedPath.replace(/\//g, path.sep);
      resolved = path.resolve(normalized);
    } catch (e) {
      return { ok: false, error: 'path_resolve_failed' };
    }

    // 白名单根目录检查（防路径遍历 ../）
    const rootResolved = path.resolve(this.root);
    if (!resolved.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep)
        && resolved.toLowerCase() !== rootResolved.toLowerCase()) {
      this.logger.warn(`[artifact] reject path outside whitelist: ${resolved}`);
      return { ok: false, error: 'path_outside_whitelist' };
    }

    // 扩展名检查
    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      this.logger.warn(`[artifact] reject unsupported ext: ${ext}`);
      return { ok: false, error: 'ext_not_allowed' };
    }

    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (e) {
      return { ok: false, error: 'file_not_found' };
    }

    if (!stat.isFile()) {
      return { ok: false, error: 'not_a_file' };
    }
    if (stat.size > MAX_SIZE) {
      return { ok: false, error: 'too_large', size: stat.size, max: MAX_SIZE };
    }

    let content;
    try {
      content = fs.readFileSync(resolved);
    } catch (e) {
      return { ok: false, error: 'read_failed: ' + e.message };
    }

    return {
      ok: true,
      contentBase64: content.toString('base64'),
      mimeType: MIME_TYPES[ext] || 'application/octet-stream',
      size: stat.size,
      resolvedPath: resolved,
    };
  }

  // 列出 root 目录下最近的 N 个 .html 文件（供 PWA 显示历史 artifact）
  listRecent(limit = 50) {
    try {
      if (!fs.existsSync(this.root)) return [];
      const entries = fs.readdirSync(this.root, { withFileTypes: true })
        .filter(e => e.isFile())
        .filter(e => ALLOWED_EXT.has(path.extname(e.name).toLowerCase()))
        .map(e => {
          const fp = path.join(this.root, e.name);
          const stat = fs.statSync(fp);
          return { name: e.name, path: fp, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit);
      return entries;
    } catch (e) {
      this.logger.warn(`[artifact] listRecent failed: ${e.message}`);
      return [];
    }
  }
}

module.exports = { ArtifactServer };
