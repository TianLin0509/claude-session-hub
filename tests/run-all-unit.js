'use strict';
// 全量 unit-*.test.js 串行跑批 + 结果汇总（压力测试回归底线用）。
//   基线（worktree, HEAD=7c131d8）：190 个文件 / 186 通过 / 4 失败 ——
//   unit-spirit-mcp-contract / unit-spirit-registry / unit-chuxin-cli-visibility /
//   unit-groupchat-member-running 依赖相对 checkout 路径的兄弟仓库，在 linked worktree
//   里必然挂，不属于本分支回归。
//
// 用法：node tests/run-all-unit.js  [--json=artifacts/xxx.json]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[k];
}

const ROOT = path.resolve(__dirname, '..');
const files = fs.readdirSync(__dirname)
  .filter(f => /^unit-.*\.test\.js$/.test(f))
  .sort();

const jsonArg = (process.argv.find(a => a.startsWith('--json=')) || '').split('=')[1];

const pass = [];
const fail = [];
const t0 = Date.now();
for (const f of files) {
  const started = Date.now();
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
    });
    pass.push({ file: f, ms: Date.now() - started });
  } catch (err) {
    const tail = String((err.stderr || '') + (err.stdout || '')).split(/\r?\n/)
      .filter(Boolean).slice(-6).join(' | ').slice(0, 400);
    fail.push({ file: f, ms: Date.now() - started, code: err.status, tail });
    process.stderr.write(`FAIL ${f}\n  ${tail}\n`);
  }
}

const out = {
  total: files.length,
  passed: pass.length,
  failed: fail.length,
  elapsedSec: Math.round((Date.now() - t0) / 1000),
  failures: fail,
  slowest: pass.slice().sort((a, b) => b.ms - a.ms).slice(0, 5),
};
console.log(JSON.stringify(out, null, 2));
if (jsonArg) fs.writeFileSync(path.resolve(ROOT, jsonArg), JSON.stringify(out, null, 2));
