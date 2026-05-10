'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir.js');

const REPORT_EXTS = new Set(['.html', '.htm', '.md', '.markdown']);

function createReportPublisher({
  reportsDir = path.join(getHubDataDir(), 'reports'),
  token = crypto.randomBytes(18).toString('base64url'),
  getBaseUrl = () => '',
  logger = console,
} = {}) {
  const published = new Map();

  function publishLinksFromText(text) {
    const paths = extractLocalReportPaths(text);
    const links = [];
    for (const filePath of paths) {
      const link = publishFile(filePath);
      if (link) links.push(link);
    }
    return links;
  }

  function publishFile(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const ext = path.extname(resolved).toLowerCase();
    if (!REPORT_EXTS.has(ext)) return null;
    let st = null;
    try { st = fs.statSync(resolved); } catch { return null; }
    if (!st.isFile()) return null;
    if (st.size > 10 * 1024 * 1024) return null;

    fs.mkdirSync(reportsDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const name = path.basename(resolved).replace(/[^\w.\- ()\u4e00-\u9fa5]/g, '_');
    const storedName = `${id}-${name}`;
    const storedPath = path.join(reportsDir, storedName);
    try {
      fs.copyFileSync(resolved, storedPath);
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[report-publisher] copy failed:', err.message);
      }
      return null;
    }

    const entry = { id, name, storedPath, sourcePath: resolved, ext, createdAt: Date.now() };
    published.set(id, entry);
    const baseUrl = String(getBaseUrl() || '').replace(/\/+$/, '');
    const url = baseUrl
      ? `${baseUrl}/reports/${id}/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`
      : '';
    return { id, name, sourcePath: resolved, url, type: ext === '.html' || ext === '.htm' ? 'html' : 'md' };
  }

  function router() {
    const r = express.Router();
    r.get('/:id/:name', (req, res) => {
      if (token && req.query.token !== token) return res.status(401).send('Unauthorized');
      const entry = published.get(String(req.params.id || ''));
      if (!entry) return res.status(404).send('Report not found');
      if (entry.ext === '.html' || entry.ext === '.htm') {
        return res.type('html').send(readText(entry.storedPath));
      }
      return res.type('html').send(renderMarkdownPage(readText(entry.storedPath), entry.name));
    });
    return r;
  }

  return { publishLinksFromText, publishFile, router, token, reportsDir };
}

function extractLocalReportPaths(text) {
  const out = [];
  const seen = new Set();
  const re = /[A-Za-z]:\\[^\r\n`"<>|]+?\.(?:html?|md|markdown)\b/gi;
  for (const match of String(text || '').matchAll(re)) {
    const cleaned = match[0].replace(/[),.;\]\s]+$/g, '');
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function renderMarkdownPage(markdown, title) {
  const body = markdownToHtml(markdown);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title || 'Report')}</title>
<style>
body{margin:0;background:#111;color:#e8e8e8;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:22px 18px 48px}
h1,h2,h3{line-height:1.25;color:#fff;margin:1.2em 0 .5em}
p,ul,ol,pre,blockquote{margin:.75em 0}
code{background:#222;padding:.12em .35em;border-radius:4px}
pre{overflow:auto;background:#1b1b1b;border:1px solid #333;border-radius:8px;padding:14px}
pre code{background:transparent;padding:0}
a{color:#68a6ff}
blockquote{border-left:3px solid #555;padding-left:12px;color:#cfcfcf}
hr{border:0;border-top:1px solid #333;margin:24px 0}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const html = [];
  let inCode = false;
  let list = null;
  let para = [];

  function flushPara() {
    if (!para.length) return;
    html.push(`<p>${inlineMd(para.join(' '))}</p>`);
    para = [];
  }
  function closeList() {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  }

  for (const line of lines) {
    if (/^```/.test(line)) {
      flushPara(); closeList();
      if (inCode) {
        html.push('</code></pre>');
        inCode = false;
      } else {
        html.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(line) + '\n');
      continue;
    }
    if (!line.trim()) {
      flushPara(); closeList();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      flushPara(); closeList();
      html.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushPara();
      if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      html.push(`<li>${inlineMd(bullet[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushPara();
      if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${inlineMd(ordered[1])}</li>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushPara(); closeList(); html.push('<hr>');
      continue;
    }
    para.push(line.trim());
  }
  flushPara(); closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

function inlineMd(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  createReportPublisher,
  extractLocalReportPaths,
  markdownToHtml,
  renderMarkdownPage,
};
