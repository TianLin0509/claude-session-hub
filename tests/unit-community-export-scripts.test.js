'use strict';
// 防复发（2026-10-14）：公司版两次因为导出包漏了脚本而功能失效——编排员工具 scripts/orchestrator-mcp.js、
// 桌面图标排列 scripts/desktop-icon-layout.ps1/.cs。代码在包里、脚本不在包里，功能一用就坏，而单测和自用版都看不出来。
// 这里真实导出一次公司版，扫包里的代码引用到的 scripts/ 文件，逐个确认包里有。
// 确实不该带的（所在功能在公司版关闭、或只是文案里提到）列在 NOT_SHIPPED 并写明原因；新增引用要么进导出清单，要么在这里说明。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NOT_SHIPPED = {
  'account-tool-adapter.py': '账号页的生图/中转账号（公司版 features.accounts=false）',
  'aliyun-console.js': '账号页的阿里云控制台（公司版 features.accounts=false）',
  'hub-browser-setup.py': '账号页的专用浏览器初始化（公司版 features.accounts=false）',
  'assistant-mcp.js': '助理（公司版 features.assistant=false）',
  'chatgpt-file-draft.py': '文件管理里的 ChatGPT 草稿（公司没有 ChatGPT）',
  'file-scope-guard.py': '注释里提到的 ~/.claude/scripts 外部 hook，不是 Hub 自带的文件',
  'merge_task.py': '开发群聊界面文案里提到的项目合并脚本名，不加载',
};

const repo = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-export-scripts-'));
try {
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', path.join(out, 'x')],
    { cwd: repo, stdio: 'ignore', windowsHide: true, timeout: 150000 });
  const root = path.join(out, 'x');
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (entry.name.endsWith('.js')) files.push(p); } };
  for (const dir of ['core', 'main', 'renderer']) walk(path.join(root, dir));
  files.push(path.join(root, 'main.js'));
  const refs = new Map();
  const patterns = [/scripts['"]\s*,\s*['"]([\w.-]+\.(?:js|ps1|cs|py|cmd|bat))['"]/g, /scripts[\\/]([\w.-]+\.(?:js|ps1|cs|py|cmd|bat))/g];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) for (const m of text.matchAll(pattern)) {
      if (!refs.has(m[1])) refs.set(m[1], new Set());
      refs.get(m[1]).add(path.relative(root, file));
    }
  }
  assert.ok(refs.has('orchestrator-mcp.js') && refs.has('desktop-icon-layout.ps1'), '扫描本身有效：能找到已知的脚本引用');
  const missing = [...refs].filter(([name]) => !fs.existsSync(path.join(root, 'scripts', name)) && !NOT_SHIPPED[name])
    .map(([name, where]) => `scripts/${name}（引用处：${[...where].slice(0, 3).join('、')}）`);
  assert.deepEqual(missing, [], '公司版代码引用了导出包里没有的脚本：加进 community/manifest.json 的 include，或在本测试的 NOT_SHIPPED 写明为什么不带');
  for (const name of ['orchestrator-mcp.js', 'desktop-icon-layout.ps1', 'desktop-icon-layout.cs']) assert.ok(fs.existsSync(path.join(root, 'scripts', name)), name);
  console.log(`unit-community-export-scripts: OK（${refs.size} 个脚本引用，${Object.keys(NOT_SHIPPED).length} 个按名单不带）`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
