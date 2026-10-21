'use strict';
// 通道会话带上成员自己注册的 MCP（2026-10-21 田哥拍板：默认带上 read-KIA；core/codeagent-member-mcp.js）。
// 覆盖各种注册位置：号池号 / 个人账号配置目录的 .cac.json、用户目录 ~/.cac.json、local 作用域（本目录与其他目录）、
// 工作目录 .mcp.json；同名优先级；不改成员的配置文件；启动参数里带上这份配置；没有可带的不加参数。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectMemberMcpServers, writeMemberMcpConfig } = require('../core/codeagent-member-mcp');

function tree(t) {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'member-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = { root, home: path.join(root, 'home'), personal: path.join(root, 'home', '.cac'), pool: path.join(root, 'hub', 'codeagent-pool', 'accounts', 'abc123'),
    hub: path.join(root, 'hub'), cwd: path.join(root, 'AirView', 'src'), manual: path.join(root, 'work') };
  for (const x of [d.home, d.personal, d.pool, d.hub, d.cwd, d.manual]) fs.mkdirSync(x, { recursive: true });
  return d;
}
const put = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
const stdio = name => ({ type: 'stdio', command: 'node', args: [`C:/mcp/${name}.js`] });

test('号池号的配置目录没有 MCP：从个人账号、用户目录、local 作用域、项目 .mcp.json 收集；同名按优先级', t => {
  const d = tree(t);
  put(path.join(d.pool, '.cac.json'), { userID: 'x', mcpServers: { airview: { command: 'pool-airview' } } });
  put(path.join(d.personal, '.cac.json'), { mcpServers: { airview: { command: 'personal-airview' }, 'read-KIA': stdio('kia') } });
  put(path.join(d.home, '.cac.json'), { mcpServers: { search: { type: 'http', url: 'http://intranet/mcp' }, broken: { args: [] } },
    projects: { [d.cwd.replace(/\\/g, '/')]: { mcpServers: { here: stdio('here') } }, [d.manual]: { mcpServers: { manual: stdio('manual'), 'read-KIA': stdio('kia-local') } } } });
  put(path.join(d.cwd, '.mcp.json'), { mcpServers: { project: stdio('project') } });
  const before = fs.readFileSync(path.join(d.home, '.cac.json'), 'utf8');
  const got = collectMemberMcpServers({ cwd: d.cwd, accountDir: d.pool, personalDir: d.personal, homeDir: d.home });
  assert.deepEqual(Object.keys(got.servers).sort(), ['airview', 'here', 'manual', 'project', 'read-KIA', 'search']);
  assert.equal(got.servers.airview.command, 'pool-airview', '号自己登记的优先');
  assert.deepEqual(got.servers['read-KIA'], stdio('kia'), '个人账号顶层的优先于其他目录 local 的');
  assert.equal(got.sources.here, '用户目录 .cac.json（本目录）', 'local 作用域按路径匹配（不分斜杠方向与大小写）');
  assert.equal(got.sources.manual, '用户目录 .cac.json（其他目录）', '只在手动会话目录登记的也带上');
  assert.ok(!('broken' in got.servers), '没有 command / url 的不带');
  assert.equal(fs.readFileSync(path.join(d.home, '.cac.json'), 'utf8'), before, '不改成员的配置文件');
});

test('只在 ~/.cac.json 顶层登记（我们公司电脑的情形）与个人号会话（号目录 = 个人目录）都成立', t => {
  const d = tree(t);
  put(path.join(d.home, '.cac.json'), { mcpServers: { 'read-KIA': stdio('kia'), airview: stdio('airview') } });
  const pool = collectMemberMcpServers({ cwd: d.cwd, accountDir: d.pool, personalDir: d.personal, homeDir: d.home });
  assert.deepEqual(Object.keys(pool.servers).sort(), ['airview', 'read-KIA']);
  const personal = collectMemberMcpServers({ cwd: d.cwd, accountDir: d.personal, personalDir: d.personal, homeDir: d.home });
  assert.deepEqual(Object.keys(personal.servers).sort(), ['airview', 'read-KIA']);
});

test('写到 Hub 数据目录（内容不变不重写）；什么都没登记时不出文件', t => {
  const d = tree(t);
  assert.equal(writeMemberMcpConfig({ hubDataDir: d.hub, cwd: d.cwd, accountDir: d.pool, personalDir: d.personal, homeDir: d.home }).file, null);
  put(path.join(d.personal, '.cac.json'), { mcpServers: { 'read-KIA': stdio('kia') } });
  const a = writeMemberMcpConfig({ hubDataDir: d.hub, cwd: d.cwd, accountDir: d.pool, personalDir: d.personal, homeDir: d.home });
  assert.ok(a.file.startsWith(path.join(d.hub, 'mcp-profiles')));
  assert.deepEqual(JSON.parse(fs.readFileSync(a.file, 'utf8')), { mcpServers: { 'read-KIA': stdio('kia') } });
  const mtime = fs.statSync(a.file).mtimeMs;
  const b = writeMemberMcpConfig({ hubDataDir: d.hub, cwd: d.cwd, accountDir: d.pool, personalDir: d.personal, homeDir: d.home });
  assert.equal(b.file, a.file); assert.equal(fs.statSync(b.file).mtimeMs, mtime);
});

test('通道会话启动参数带上这份配置（仍带 strict，认不认 strict 的版本结果一样）；人自己开的、助理会话不加', t => {
  const d = tree(t);
  put(path.join(d.home, '.cac.json'), { mcpServers: { 'read-KIA': stdio('kia') } });
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = d.hub;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  const { _private: { buildCodeAgentPtyLaunch } } = require('../core/session-manager');
  const config = { command: 'codeagent', configDir: d.pool, configDirEnv: 'CODEAGENT3_CONFIG_DIR' };
  const env = { USERPROFILE: d.home };
  const bridge = buildCodeAgentPtyLaunch('kia-bridge', 'codeagent', { purpose: 'company-bridge' }, d.cwd, env, config).cmd;
  assert.match(bridge, /--mcp-config \S+claude-mcp-none-none\.json \S+codeagent-member-mcp-[0-9a-f]{12}\.json --strict-mcp-config/);
  const file = bridge.match(/(\S+codeagent-member-mcp-[0-9a-f]{12}\.json)/)[1].replace(/^'|'$/g, '');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['read-KIA']);
  for (const opts of [{}, { purpose: 'company-assistant' }]) {
    assert.doesNotMatch(buildCodeAgentPtyLaunch('kia-other', 'codeagent', opts, d.cwd, env, config).cmd, /codeagent-member-mcp/);
  }
  // 环境里没有用户目录（单测夹具 {}）：不扫，参数与改动前一致
  assert.doesNotMatch(buildCodeAgentPtyLaunch('kia-noenv', 'codeagent', { purpose: 'company-bridge' }, d.cwd, {}, { ...config, configDir: path.join(d.root, 'none') }).cmd, /codeagent-member-mcp/);
});
