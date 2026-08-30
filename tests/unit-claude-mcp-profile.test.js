'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildClaudeMcpProfileArgs,
  listClaudeMcpServers,
  normalizeClaudeMcpProfile,
  resolveAllowedMcpNames,
} = require('../core/claude-mcp-profile.js');
const { SessionManager, _private } = require('../core/session-manager.js');

const USER_SERVERS = {
  playwright: { command: 'npx', args: ['@playwright/mcp'] },
  'gemini-cli': { command: 'gemini' },
  'codex-cli': { command: 'codex' },
  deepseek: { command: 'ds' },
  qwen: { command: 'qwen' },
  glm: { command: 'glm' },
  superran: { command: 'python', args: ['-m', 'superran'] },
};

function makeHome({ projects = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-mcp-'));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ mcpServers: USER_SERVERS, projects }, null, 2),
    'utf8'
  );
  const hubDataDir = path.join(home, 'hub-data');
  fs.mkdirSync(hubDataDir, { recursive: true });
  return { home, hubDataDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function readGeneratedConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// 2026-08-29 起默认档由 full 改为 none：superran 这类 MCP 每个进程恒定提交
// 2.66 GB，默认全量加载会让多会话场景直接吃满提交内存。回落方向必须是"最省"，
// 不再是"最全"。详见 unit-claude-mcp-default-none.test.js。
test('档位非法值一律回落 none（默认不加载任何 MCP）', () => {
  assert.equal(normalizeClaudeMcpProfile(undefined), 'none');
  assert.equal(normalizeClaudeMcpProfile(''), 'none');
  assert.equal(normalizeClaudeMcpProfile('nonsense'), 'none');
  assert.equal(normalizeClaudeMcpProfile('LEAN'), 'lean');
  assert.equal(normalizeClaudeMcpProfile('wireless'), 'wireless');
});

test('full 档一个 flag 都不加，行为与改动前逐字一致', () => {
  const h = makeHome();
  try {
    const plan = buildClaudeMcpProfileArgs({ mcpProfile: 'full', homeDir: h.home, hubDataDir: h.hubDataDir, cwd: 'C:\\work' });
    assert.equal(plan.args, '');
    assert.equal(plan.configPath, null);
    assert.equal(fs.existsSync(path.join(h.hubDataDir, 'mcp-profiles')), false, 'full 档不该产生任何文件');
  } finally { h.cleanup(); }
});

test('lean 档写出空 mcpServers 并带上 --strict-mcp-config', () => {
  const h = makeHome();
  try {
    const plan = buildClaudeMcpProfileArgs({ mcpProfile: 'lean', homeDir: h.home, hubDataDir: h.hubDataDir, cwd: 'C:\\work' });
    assert.match(plan.args, /--mcp-config "/);
    // 少了 --strict-mcp-config 的话 CLI 会把这个文件和全局配置合并，等于白干。
    assert.match(plan.args, /--strict-mcp-config/);
    assert.deepEqual(plan.keptServers, []);
    assert.deepEqual(readGeneratedConfig(plan.configPath).mcpServers, {});
  } finally { h.cleanup(); }
});

test('browser 档只留浏览器类，且 server 定义是原样搬过去的', () => {
  const h = makeHome();
  try {
    const plan = buildClaudeMcpProfileArgs({ mcpProfile: 'browser', homeDir: h.home, hubDataDir: h.hubDataDir, cwd: 'C:\\work' });
    assert.deepEqual(plan.keptServers, ['playwright']);
    assert.deepEqual(readGeneratedConfig(plan.configPath).mcpServers.playwright, USER_SERVERS.playwright);
  } finally { h.cleanup(); }
});

test('wireless 档留的是用户真实叫得出名字的那个（superran，不是 superwireless）', () => {
  const h = makeHome();
  try {
    const plan = buildClaudeMcpProfileArgs({ mcpProfile: 'wireless', homeDir: h.home, hubDataDir: h.hubDataDir, cwd: 'C:\\work' });
    assert.deepEqual(plan.keptServers, ['superran']);
  } finally { h.cleanup(); }
});

test('工作区落在无线目录下时自动放行无线 MCP，哪怕选的是 lean', () => {
  const h = makeHome();
  try {
    const plan = buildClaudeMcpProfileArgs({
      mcpProfile: 'lean',
      homeDir: h.home,
      hubDataDir: h.hubDataDir,
      cwd: 'C:\\Vibe\\Wireless\\SuperRAN',
    });
    assert.deepEqual(plan.keptServers, ['superran']);
  } finally { h.cleanup(); }
});

test('项目级 mcpServers 会合并进来（覆盖同名用户级）', () => {
  const projectPath = 'C:/Users/lintian/Stock_test';
  const h = makeHome({ projects: { [projectPath]: { mcpServers: { playwright: { command: 'project-override' } } } } });
  try {
    // Windows 传进来的是反斜杠，Claude CLI 存的是正斜杠 —— 不归一化就匹配不上。
    const merged = listClaudeMcpServers({ homeDir: h.home, cwd: 'C:\\Users\\lintian\\Stock_test' });
    assert.equal(merged.playwright.command, 'project-override');
    assert.equal(merged.superran.command, 'python');
  } finally { h.cleanup(); }
});

test('~/.claude.json 缺失或损坏时回退全量继承，而不是把 MCP 全砍光', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-mcp-bad-'));
  try {
    assert.deepEqual(listClaudeMcpServers({ homeDir: home }), {});
    fs.writeFileSync(path.join(home, '.claude.json'), '{broken', 'utf8');
    assert.deepEqual(listClaudeMcpServers({ homeDir: home }), {});

    // 写不出 config（hubDataDir 为空）时必须返回空 args = 全量继承。
    const plan = buildClaudeMcpProfileArgs({ mcpProfile: 'lean', homeDir: home, hubDataDir: '' });
    assert.equal(plan.args, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('同档位重复调用复用同一个 config 文件，不会攒垃圾', () => {
  const h = makeHome();
  try {
    const a = buildClaudeMcpProfileArgs({ mcpProfile: 'browser', homeDir: h.home, hubDataDir: h.hubDataDir, cwd: 'C:\\a' });
    const b = buildClaudeMcpProfileArgs({ mcpProfile: 'browser', homeDir: h.home, hubDataDir: h.hubDataDir, cwd: 'C:\\b' });
    assert.equal(a.configPath, b.configPath);
    assert.equal(fs.readdirSync(path.join(h.hubDataDir, 'mcp-profiles')).length, 1);
  } finally { h.cleanup(); }
});

test('允许名单在 Claude / Codex 两边用同一套判定', () => {
  assert.equal(resolveAllowedMcpNames('browser').has('playwright'), true);
  assert.equal(resolveAllowedMcpNames('browser').has('superran'), false);
  // 两种叫法都放行：Claude 侧叫 superran，Codex 的 config.toml 里历史上写过 superwireless。
  const wireless = resolveAllowedMcpNames('wireless');
  assert.equal(wireless.has('superran'), true);
  assert.equal(wireless.has('superwireless'), true);
});

test('Codex 的 wireless 档不再把 superran 一起禁掉（原来只放行 superwireless）', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-cfg-'));
  try {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.playwright]\ncommand = "npx"\n\n[mcp_servers.superran]\ncommand = "python"\n',
      'utf8'
    );
    const args = _private.buildCodexMcpIsolationArgs(codexHome, { mcpProfile: 'wireless', cwd: 'C:\\work' });
    assert.match(args, /mcp_servers\.playwright\.enabled=false/);
    assert.doesNotMatch(args, /mcp_servers\.superran\.enabled=false/, 'wireless 档必须留下 superran');
  } finally { fs.rmSync(codexHome, { recursive: true, force: true }); }
});

test('Codex None 即使在 Wireless workspace 也禁用全部全局 MCP', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-none-'));
  try {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.playwright]\ncommand = "npx"\n\n[mcp_servers.superran]\ncommand = "python"\n',
      'utf8'
    );
    const args = _private.buildCodexMcpIsolationArgs(codexHome, {
      mcpProfile: 'none',
      cwd: 'C:\\Vibe\\Wireless\\demo',
      allowedNames: ['playwright', 'superran', 'ai-team'],
    });
    assert.match(args, /mcp_servers\.playwright\.enabled=false/);
    assert.match(args, /mcp_servers\.superran\.enabled=false/);
  } finally { fs.rmSync(codexHome, { recursive: true, force: true }); }
});

test('Codex 思考强度收下全部实测合法档位，乱值回落 max', () => {
  const { normalizeCodexEffort } = _private;
  assert.equal(normalizeCodexEffort('low'), 'low');
  assert.equal(normalizeCodexEffort('MEDIUM'), 'medium');
  assert.equal(normalizeCodexEffort('max'), 'max');
  // 更正（2026-08-16 查 ~/.codex/models_cache.json）：xhigh 不是 Claude 专属，
  // 每个 Codex 模型都支持；gpt-5.6-sol/terra 还有比 max 更高的 ultra。
  // 按模型过滤在 core/codex-model-catalog.js，这里只是语法层白名单。
  assert.equal(normalizeCodexEffort('xhigh'), 'xhigh');
  assert.equal(normalizeCodexEffort('ultra'), 'ultra');
  assert.equal(normalizeCodexEffort('banana'), 'max');
  assert.equal(normalizeCodexEffort(''), 'max');
  assert.equal(normalizeCodexEffort(undefined), 'max');
});

test('fast 默认开，只有显式 fastMode:false 才关（不是任意 falsy）', () => {
  const { shouldUseClaudeFastSettings } = _private;
  const subscription = { CLAUDE_BACKEND: 'subscription' };
  assert.equal(shouldUseClaudeFastSettings(subscription), true);
  assert.equal(shouldUseClaudeFastSettings(subscription, {}), true);
  assert.equal(shouldUseClaudeFastSettings(subscription, { fastMode: true }), true);
  // undefined / null 是"没选过" = 默认开；只有明确 false 才算用户关掉了。
  assert.equal(shouldUseClaudeFastSettings(subscription, { fastMode: undefined }), true);
  assert.equal(shouldUseClaudeFastSettings(subscription, { fastMode: false }), false);
  // API backend 仍然一律不注入 fast，弹窗开关管不着它。
  assert.equal(shouldUseClaudeFastSettings({ CLAUDE_BACKEND: 'api', CLAUDE_API_KEY: 'k' }, { fastMode: true }), false);
});

test('Claude CLI 原地 relaunch 沿用 effort、MCP 档位和关闭 fast 的选择', () => {
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-relaunch-'));
  const oldDataDir = process.env.CLAUDE_HUB_DATA_DIR;
  const manager = new SessionManager();
  let command = '';
  try {
    process.env.CLAUDE_HUB_DATA_DIR = isolatedDataDir;
    manager.sessions.set('relaunch-claude', {
      info: {
        id: 'relaunch-claude',
        kind: 'claude',
        cwd: 'C:\\work',
        currentModel: { id: 'claude-fable-5' },
        effort: 'low',
        mcpProfile: 'lean',
        fastMode: false,
      },
      pty: { write(value) { command += value; }, kill() {} },
      pendingTimers: new Set(),
    });

    assert.equal(manager.relaunchCli('relaunch-claude'), true);
    assert.match(command, /claude --model claude-fable-5 --effort low/);
    assert.match(command, /--mcp-config "/);
    assert.match(command, /--strict-mcp-config/);
    assert.doesNotMatch(command, /--settings/);
  } finally {
    manager.dispose();
    if (oldDataDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
    else process.env.CLAUDE_HUB_DATA_DIR = oldDataDir;
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  }
});

test('迁移前 DeepSeek 群聊 relaunch 保持 Lean 并保留房间 MCP', () => {
  const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-deepseek-legacy-relaunch-'));
  const roomConfig = path.join(isolatedDataDir, 'legacy-room-mcp.json');
  const oldDataDir = process.env.CLAUDE_HUB_DATA_DIR;
  const manager = new SessionManager();
  let command = '';
  try {
    process.env.CLAUDE_HUB_DATA_DIR = isolatedDataDir;
    fs.writeFileSync(roomConfig, JSON.stringify({
      mcpServers: { arena_research: { command: 'node' } },
    }), 'utf8');
    manager.sessions.set('legacy-deepseek', {
      info: {
        id: 'legacy-deepseek',
        kind: 'deepseek',
        transcriptKind: 'deepseek-legacy',
        meetingId: 'meeting-1',
        cwd: 'C:\\work',
        currentModel: { id: 'deepseek-v4-pro[1m]' },
        mcpProfile: 'lean',
      },
      claudeMcpConfigFile: roomConfig,
      pty: { write(value) { command += value; }, kill() {} },
      pendingTimers: new Set(),
    });

    assert.equal(manager.relaunchCli('legacy-deepseek'), true);
    assert.match(command, /claude --model deepseek-v4-pro\[1m\]/);
    assert.match(command, /legacy-room-mcp\.json/);
    assert.match(command, /claude-mcp-lean-none\.json/);
    assert.match(command, /--strict-mcp-config/);
    assert.match(command, /group-chat-claude-settings\.json/);
  } finally {
    manager.dispose();
    if (oldDataDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
    else process.env.CLAUDE_HUB_DATA_DIR = oldDataDir;
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  }
});
