'use strict';

// 2026-10-08 田哥决定整体下线英灵（巴菲特 / 利弗莫尔镜头）：初心后端 v1.11.0 已删
// /api/spirits/*，Hub 侧的 MCP 工具、群聊 @英灵、下一轮英雄编队条、初心英雄大厅一并删除。
// 这里守住「不再长回来」：运行时代码里不允许再出现这些入口或调用。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'main', 'renderer'];
const SCAN_FILES = ['main.js', 'main-bootstrap.js'];
const TEXT_EXT = /\.(?:js|cjs|mjs|css|html|json)$/i;

const FORBIDDEN = [
  { id: 'chuxin spirit API', re: /\/api\/spirits\b/ },
  { id: 'spirit MCP tools', re: /\bspirit_(?:list|manifest|prepare|validate)\b/ },
  { id: 'spirit registry', re: /SPIRIT_REGISTRY_ROOT|spirit-lens-registry|spirit-registry/ },
  { id: 'group chat @英灵', re: /@英灵|英灵议事/ },
  { id: 'hero prompt dock', re: /hero-prompts|heroIdBySid|mr-hero-|下一轮英雄/ },
  { id: 'chuxin hero hall', re: /chuxin:run-agent-task|selected-heroes|heroIds\b|cx-hero-card/ },
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [];
for (const dir of SCAN_DIRS) walk(path.join(root, dir), files);
for (const file of SCAN_FILES) {
  const full = path.join(root, file);
  if (fs.existsSync(full)) files.push(full);
}

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) hits.push(`${path.relative(root, file)}:${index + 1} [${rule.id}] ${line.trim().slice(0, 120)}`);
    }
  });
}

assert.deepStrictEqual(hits, [], `英灵功能已下线，运行时代码不应再引用：\n${hits.join('\n')}`);
for (const removed of ['core/spirit-registry.js', 'core/hero-prompts.js']) {
  assert.strictEqual(fs.existsSync(path.join(root, removed)), false, `${removed} 应已删除`);
}

console.log(`  OK retired spirit feature stays removed (${files.length} runtime files scanned)`);
