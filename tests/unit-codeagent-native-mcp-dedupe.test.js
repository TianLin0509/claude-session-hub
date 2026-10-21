'use strict';
// 通道会话插件自学习去重（2026-10-21 v3.0.2 回归：CodeAgent 1.2615 不认 strict，~/.cac.json 里的插件和 member-mcp 各起一份）。
// 纯函数：从进程快照数每个插件起了几份（cmd 包装、python -m、node 脚本、uvx 链；单实例不误判、相近名字不串）；
// 生成：有记录且名字仍在原生候选里才跳过；名字移走就照写；版本、号不串用；local / .mcp.json 来源从不跳过；
// 失效：跳过的插件在之后的会话里一份都没起 → 从记录去掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mod = require('../core/codeagent-member-mcp');

function tree(t) {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'native-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = { root, home: path.join(root, 'home'), personal: path.join(root, 'home', '.cac'), pool: path.join(root, 'hub', 'codeagent-pool', 'accounts', 'abc123'),
    hub: path.join(root, 'hub'), cwd: path.join(root, 'AirView', 'src'), manual: path.join(root, 'work') };
  for (const x of [d.home, d.personal, d.pool, d.hub, d.cwd, d.manual]) fs.mkdirSync(x, { recursive: true });
  return d;
}
const put = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj), 'utf8');

const SERVERS = {
  'read-KIA': { command: 'cmd', args: ['/c', 'npx', '-y', '@corp/read-kia'] },
  airview: { command: 'python', args: ['-m', 'airview_mcp.server'] },
  'ssh-remote': { command: 'node', args: ['C:\\mcp\\ssh-remote.js'] },
  'welink-mcp': { command: 'uvx', args: ['--from', 'git+https://git.corp/welink', 'welink-mcp'] },
  intranet: { command: 'node', args: ['C:/mcp/intra.js'] },
  'intranet-ext': { command: 'node', args: ['C:/mcp/intra-ext.js'] },
  w3: { command: 'node', args: ['C:/mcp/w3.js'], enabled: false },
};

// 会话 PTY 树：100 powershell → 101 codeagent 主进程 → 102 serve → 各插件；插件的孙进程和挂在主进程下的不算顶层。
function snapshot({ kia = 2, airview = 2, ssh = 2, welink = 2, intranet = 1, ext = 1 } = {}) {
  const procs = [
    { pid: 100, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo' },
    { pid: 101, ppid: 100, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\codeagent\\cli.js --mcp-config a.json b.json --strict-mcp-config' },
    { pid: 102, ppid: 101, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\codeagent\\cli.js serve --config-dir C:\\Users\\u\\.cac' },
    // 挂在主进程下、不在 serve 底下：不算
    { pid: 150, ppid: 101, name: 'cmd.exe', cmd: 'C:\\Windows\\system32\\cmd.exe /d /s /c "npx -y @corp/read-kia"' },
    // 别的会话的 serve 子进程：不在本树
    { pid: 900, ppid: 899, name: 'node.exe', cmd: 'node C:\\npm\\node_modules\\codeagent\\cli.js serve --config-dir X' },
    { pid: 901, ppid: 900, name: 'node.exe', cmd: 'node C:/mcp/intra.js' },
  ];
  let pid = 200;
  const add = (n, cmd, kids = []) => { for (let i = 0; i < n; i++) { const me = pid++; procs.push({ pid: me, ppid: 102, name: cmd.split(' ')[0], cmd }); for (const k of kids) procs.push({ pid: pid++, ppid: me, name: 'x.exe', cmd: k }); } };
  add(kia, 'C:\\Windows\\system32\\cmd.exe /d /s /c "npx -y @corp/read-kia"', ['node C:\\Users\\u\\AppData\\npm-cache\\_npx\\1\\node_modules\\@corp\\read-kia\\index.js']);
  add(airview, '"C:\\Python311\\python.exe" -m airview_mcp.server');
  add(ssh, '"C:\\Program Files\\nodejs\\node.exe" C:/mcp/ssh-remote.js');
  add(welink, 'C:\\Users\\u\\.local\\bin\\uvx.exe --from git+https://git.corp/welink welink-mcp',
    ['C:\\Users\\u\\.local\\bin\\uv.exe tool uvx --from git+https://git.corp/welink welink-mcp', 'C:\\cache\\python.exe welink-mcp']);
  add(intranet, '"C:\\Program Files\\nodejs\\node.exe" C:\\mcp\\intra.js');
  add(ext, '"C:\\Program Files\\nodejs\\node.exe" C:\\mcp\\intra-ext.js');
  return { processes: procs };
}

test('纯函数：四种启动方式各起 2 份 → 认出重复；单实例、相近名字、孙进程、树外进程不误判', () => {
  const { serveFound, counts } = mod.countServerInstances(SERVERS, snapshot(), 100);
  assert.equal(serveFound, true);
  assert.deepEqual(counts, { 'read-KIA': 2, airview: 2, 'ssh-remote': 2, 'welink-mcp': 2, intranet: 1, 'intranet-ext': 1, w3: 0 });
  assert.deepEqual(mod.countServerInstances(SERVERS, snapshot({ kia: 1, airview: 1, ssh: 1, welink: 1 }), 100).counts['read-KIA'], 1);
  assert.deepEqual(mod.mcpMatchKey(SERVERS['read-KIA']), { runner: 'npx', key: '@corp/read-kia' }, 'cmd 包装剥掉后看真正跑的');
  assert.deepEqual(mod.mcpMatchKey(SERVERS.airview), { runner: 'python', key: 'airview_mcp.server' });
  assert.deepEqual(mod.mcpMatchKey(SERVERS['ssh-remote']), { runner: 'node', key: 'c:/mcp/ssh-remote.js' }, '大小写与斜杠规范化');
  assert.deepEqual(mod.mcpMatchKey({ command: 'C:\\tools\\AirView-MCP.exe' }), { runner: 'airview-mcp', key: 'c:/tools/airview-mcp.exe' });
  assert.equal(mod.countServerInstances(SERVERS, { processes: snapshot().processes.filter(p => p.pid !== 102) }, 100).serveFound, false, '没有 serve 就不数');
});

test('学习 + 生成：有记录且名字仍在 ~/.cac.json → 跳过；移到 .mcp.json / local 作用域 → 照写；不改成员配置', t => {
  const d = tree(t);
  const homeFile = path.join(d.home, '.cac.json');
  put(homeFile, { mcpServers: { 'read-KIA': SERVERS['read-KIA'], intranet: SERVERS.intranet } });
  const where = { hubDataDir: d.hub, cwd: d.cwd, accountDir: d.personal, personalDir: d.personal, homeDir: d.home };
  const first = mod.writeMemberMcpConfig({ ...where, version: '1.2615.0' });
  assert.deepEqual(first.names.sort(), ['intranet', 'read-KIA']);
  assert.deepEqual(first.skipped, [], '还没学过：全写');
  const r = mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.2615.0', written: first.servers, skipped: first.skippedServers, snapshot: snapshot(), rootPid: 100, now: 1760000000000 });
  assert.deepEqual(r.learned, ['read-KIA'], 'intranet 只有 1 份，不记');
  assert.match(r.note, /read-KIA/);
  const before = fs.readFileSync(homeFile, 'utf8');
  const second = mod.writeMemberMcpConfig(where); // 不给版本：用最近学到的
  assert.deepEqual(second.names, ['intranet']);
  assert.deepEqual(second.skipped, ['read-KIA']);
  assert.ok(!('read-KIA' in JSON.parse(fs.readFileSync(second.file, 'utf8')).mcpServers));
  assert.equal(fs.readFileSync(homeFile, 'utf8'), before, '不改成员的配置文件');
  // 名字从 ~/.cac.json 删掉、改登记在工作目录 .mcp.json：记录不再生效，照写
  put(homeFile, { mcpServers: { intranet: SERVERS.intranet } });
  put(path.join(d.cwd, '.mcp.json'), { mcpServers: { 'read-KIA': SERVERS['read-KIA'] } });
  assert.deepEqual(mod.writeMemberMcpConfig(where).names.sort(), ['intranet', 'read-KIA']);
  // 只登记在 local 作用域（其他目录）：照写
  fs.rmSync(path.join(d.cwd, '.mcp.json'));
  put(homeFile, { mcpServers: { intranet: SERVERS.intranet }, projects: { [d.manual]: { mcpServers: { 'read-KIA': SERVERS['read-KIA'] } } } });
  const local = mod.writeMemberMcpConfig(where);
  assert.deepEqual(local.names.sort(), ['intranet', 'read-KIA']);
  assert.equal(local.sources['read-KIA'], '用户目录 .cac.json（其他目录）');
});

test('不同版本、不同号的记录不串用；版本变了按新版本重新学；跳过的插件一份都没起 → 从记录去掉', t => {
  const d = tree(t);
  put(path.join(d.home, '.cac.json'), { mcpServers: { 'read-KIA': SERVERS['read-KIA'] } });
  const where = { hubDataDir: d.hub, cwd: d.cwd, accountDir: d.personal, personalDir: d.personal, homeDir: d.home };
  mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.2615.0', written: { 'read-KIA': SERVERS['read-KIA'] }, snapshot: snapshot(), rootPid: 100 });
  assert.deepEqual(mod.writeMemberMcpConfig({ ...where, version: '1.2615.0' }).skipped, ['read-KIA']);
  assert.deepEqual(mod.writeMemberMcpConfig({ ...where, version: '1.3000.0' }).skipped, [], '新版本没学过：照写');
  assert.deepEqual(mod.writeMemberMcpConfig({ ...where, accountDir: d.pool }).skipped, [], '号池号的记录另算');
  // 新版本认 strict：照写的那一份只起 1 个 → 不记；lastVersion 换成新版本，之后默认按新版本查
  const v2 = mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.3000.0', written: { 'read-KIA': SERVERS['read-KIA'] }, snapshot: snapshot({ kia: 1 }), rootPid: 100 });
  assert.equal(v2.versionChanged, true);
  assert.match(v2.note, /1\.2615\.0 → 1\.3000\.0/);
  assert.deepEqual(mod.writeMemberMcpConfig(where).skipped, [], '默认用最近版本，旧版本的记录不再生效');
  // 回到老版本、但跳过后一份都没起：去掉记录，下次照写
  const back = mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.2615.0', skipped: { 'read-KIA': SERVERS['read-KIA'] }, snapshot: snapshot({ kia: 0 }), rootPid: 100 });
  assert.deepEqual(back.dropped, ['read-KIA']);
  assert.deepEqual(mod.writeMemberMcpConfig({ ...where, version: '1.2615.0' }).skipped, []);
  // 跳过后还有 1 份（CodeAgent 自己加载的）：保留
  mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.2615.0', written: { 'read-KIA': SERVERS['read-KIA'] }, snapshot: snapshot(), rootPid: 100 });
  const kept = mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.2615.0', skipped: { 'read-KIA': SERVERS['read-KIA'] }, snapshot: snapshot({ kia: 1 }), rootPid: 100 });
  assert.deepEqual(kept.kept, ['read-KIA']); assert.deepEqual(kept.dropped, []);
  // 没找到 serve：不动记录
  const store = fs.readFileSync(path.join(d.hub, mod.NATIVE_FILE), 'utf8');
  const none = mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '9.9.9', written: { 'read-KIA': SERVERS['read-KIA'] }, snapshot: { processes: [] }, rootPid: 100 });
  assert.equal(none.serveFound, false);
  assert.equal(fs.readFileSync(path.join(d.hub, mod.NATIVE_FILE), 'utf8'), store);
  // 诊断：按代称给出「会自己加载的插件：…（学习于 …）」
  const desc = mod.describeNativeMcp(d.hub, dir => dir === path.resolve(d.personal).toLowerCase() ? '个人' : '某个号');
  assert.equal(desc.version, '1.2615.0');
  assert.equal(desc.accounts[0].account, '个人');
  assert.match(desc.accounts[0].text, /^会自己加载的插件：read-KIA（学习于 /);
});

test('通道会话启动：跳过学到的插件，并带回学习要用的信息；没有学习记录时与改动前一致', t => {
  const d = tree(t);
  put(path.join(d.home, '.cac.json'), { mcpServers: { 'read-KIA': SERVERS['read-KIA'], intranet: SERVERS.intranet } });
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = d.hub;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  const { _private: { buildCodeAgentPtyLaunch } } = require('../core/session-manager');
  const config = { command: 'codeagent', configDir: d.personal, configDirEnv: 'CODEAGENT3_CONFIG_DIR' };
  const env = { USERPROFILE: d.home };
  const a = buildCodeAgentPtyLaunch('dd-a', 'codeagent', { purpose: 'company-bridge' }, d.cwd, env, config);
  assert.deepEqual(Object.keys(a.memberMcpLearn.written).sort(), ['intranet', 'read-KIA']);
  assert.deepEqual(a.memberMcpLearn.skipped, {});
  mod.learnNativeMcp({ hubDataDir: d.hub, accountDir: d.personal, version: '1.2615.0', written: a.memberMcpLearn.written, snapshot: snapshot(), rootPid: 100 });
  const b = buildCodeAgentPtyLaunch('dd-b', 'codeagent', { purpose: 'company-bridge' }, d.cwd, env, config);
  const file = b.cmd.match(/(\S+codeagent-member-mcp-[0-9a-f]{12}\.json)/)[1].replace(/^'|'$/g, '');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['intranet']);
  assert.deepEqual(Object.keys(b.memberMcpLearn.skipped), ['read-KIA']);
  const log = fs.readFileSync(path.join(d.hub, 'logs', 'codeagent-model.log'), 'utf8');
  assert.match(log, /nativeMcpSkipped=read-KIA/);
  assert.equal(buildCodeAgentPtyLaunch('dd-c', 'codeagent', {}, d.cwd, env, config).memberMcpLearn, undefined, '人自己开的会话不学');
});
