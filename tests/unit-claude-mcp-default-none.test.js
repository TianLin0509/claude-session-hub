'use strict';

// 2026-08-29：Claude 的 MCP 默认档从 full 改成 none。
//
// 起因是用户机器提交内存贴顶（103/107.7 GB）。实测根因：Claude 默认 full 意味着
// 每开一个会话都把 ~/.claude.json 里 7 个 MCP server 全拉起来，其中
// C:\Vibe\Wireless\SuperRAN\scripts\mcp_server.py 一个进程就**恒定提交 2.66 GB**
// （实占只有 20–30 MB —— 全是启动时一次性提交、之后从没碰过的内存）。
// 当时 13 个 Claude 会话 → 单是 superran 就占掉 34.6 GB 提交内存。
// 用户要求：「只有我提到的时候才加载 superRAN，否则不应该加载」。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_CLAUDE_MCP_PROFILE,
  buildClaudeMcpProfileArgs,
  normalizeClaudeMcpProfile,
  resolveAllowedMcpNames,
} = require('../core/claude-mcp-profile.js');

assert.strictEqual(DEFAULT_CLAUDE_MCP_PROFILE, 'none');
// 空值/乱值都要落到 none，不能落回 full
for (const bogus of [undefined, null, '', '   ', 'full-ish', '乱写']) {
  assert.strictEqual(normalizeClaudeMcpProfile(bogus), 'none', `${JSON.stringify(bogus)} 应归一到 none`);
}
// 显式档位仍然有效
for (const good of ['full', 'lean', 'browser', 'wireless', 'none']) {
  assert.strictEqual(normalizeClaudeMcpProfile(good), good);
}

// --- none 是硬关：无线工作区不得把 superran 偷偷放回来 ---
const wirelessCwd = path.join('C:', 'Vibe', 'Wireless', 'SuperRAN');
assert.deepStrictEqual(
  [...resolveAllowedMcpNames('none', { cwd: wirelessCwd })], [],
  'none 档下，工作区在无线目录也不得自动放行 superran',
);
assert.deepStrictEqual(
  [...resolveAllowedMcpNames('none', { cwd: wirelessCwd, extraAllowed: ['superran', 'playwright'] })], [],
  'none 档下 extraAllowed 也一并作废，否则群聊/workspace 会把它加回来',
);
// 但显式选 wireless 仍然要能拿到
assert.ok(resolveAllowedMcpNames('wireless', { cwd: 'C:\\tmp' }).has('superran'));
// lean 保持原语义（无线工作区自动放行）
assert.ok(resolveAllowedMcpNames('lean', { cwd: wirelessCwd }).has('superran'));

// --- 端到端：默认档在无线工作区里也必须写出空的 mcpServers ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-none-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
  mcpServers: {
    superran: { command: 'python', args: ['mcp_server.py'] },
    playwright: { command: 'npx', args: ['playwright'] },
  },
}, null, 2), 'utf8');

const dflt = buildClaudeMcpProfileArgs({
  mcpProfile: undefined, cwd: wirelessCwd, hubDataDir: tmp, homeDir: home,
});
assert.strictEqual(dflt.profile, 'none');
assert.deepStrictEqual(dflt.keptServers, [], '默认档不得保留任何 server');
assert.ok(dflt.args.includes('--strict-mcp-config'),
  '缺 --strict-mcp-config 的话 CLI 会把这份配置和全局配置合并，等于没省');
assert.deepStrictEqual(
  JSON.parse(fs.readFileSync(dflt.configPath, 'utf8')), { mcpServers: {} },
);

// 显式选 wireless 时 superran 必须回来 —— 这就是「我提到的时候才加载」
const wireless = buildClaudeMcpProfileArgs({
  mcpProfile: 'wireless', cwd: wirelessCwd, hubDataDir: tmp, homeDir: home,
});
assert.deepStrictEqual(wireless.keptServers, ['superran']);

// full 仍然是「完全不干预」（空 args = 继承全局）
const full = buildClaudeMcpProfileArgs({
  mcpProfile: 'full', cwd: wirelessCwd, hubDataDir: tmp, homeDir: home,
});
assert.strictEqual(full.args, '');

// --- none 不依赖读用户配置：~/.claude.json 损坏也要照样关干净 ---
fs.writeFileSync(path.join(home, '.claude.json'), '{ 坏掉的 json', 'utf8');
const broken = buildClaudeMcpProfileArgs({
  mcpProfile: undefined, cwd: wirelessCwd, hubDataDir: tmp, homeDir: home,
});
assert.deepStrictEqual(broken.keptServers, []);
assert.ok(broken.args.includes('--strict-mcp-config'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('unit-claude-mcp-default-none: OK');
