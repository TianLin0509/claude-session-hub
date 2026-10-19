'use strict';
// 读文件通道（2026-10-20，core/company-bridge/file-query.js、op:'files'）真实端到端：
//   node tests/e2e-company-files.js [--out <截图目录>] [--keep]
// 两台隔离 Hub：家里 = 当前工作区源码；公司 = 当前工作区按公司目标导出、以源码方式启动（公司侧只带 file-query.js，不带家里侧 home.js / company-ask.js）。
// 中间是真实的通道服务（relay_server.py，绑 localhost）。公司侧只读测试自己造的临时目录（readRoots 指过去），不碰公司电脑、不碰生产 Hub。
// 流程：配对 → 家里用「问公司」那条命令行（真 CLI 子进程，通行证按真 Hub 的算法从本机密钥推导）读一份真文件 → 列目录 → 找文件
//   → 越界路径被挡 → 凭据被隐去 → 5 秒内重复读被挡 → 关掉开关被挡 → 公司审计日志逐条留痕。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const RELAY = process.env.HUB_E2E_RELAY || 'C:\\Users\\lintian\\company-drop\\server\\relay_server.py';
const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261020-company-files-e2e-claude1'));
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// 真凭据一律用假值；这些字串一个都不许出现在家里收到的回报里
const SECRETS = ['sk-abcdefghijklmnopqrstuvwxyz0123456789', 'SuperSecret12345', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ', 'q7Zx9Kp2Lm5Nb8Vc4Xd6'];

function makeFixture(root) {
  const readDir = path.join(root, 'readdir'), outsideDir = path.join(root, 'outside');
  fs.mkdirSync(readDir, { recursive: true }); fs.mkdirSync(outsideDir, { recursive: true });
  // 一份像 LUT 表的文本（220 行，模拟 AirView 的 tool/txt 文档；内容是本测试自己编的）
  const lut = ['# 256QAM 判决门限表（测试用样例，不是任何真实表格）', '# idx\tI_low\tI_high\tQ_low\tQ_high\tlabel'];
  for (let i = 0; i < 218; i++) lut.push([i, (-1 + i / 109).toFixed(4), (-0.99 + i / 109).toFixed(4), (-0.5 + i / 218).toFixed(4), (-0.49 + i / 218).toFixed(4), 'L' + (i % 16)].join('\t'));
  const lutFile = path.join(readDir, 'DL256QAM.txt');
  fs.writeFileSync(lutFile, lut.join('\n') + '\n', 'utf8');
  const secretsFile = path.join(readDir, 'collect.log');
  fs.writeFileSync(secretsFile, [
    '# 采集脚本片段（测试用假凭据）',
    'export API_TOKEN=sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'password=SuperSecret12345',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'internal_code=q7Zx9Kp2Lm5Nb8Vc4Xd6',
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
    '-----END PRIVATE KEY-----',
    'source_path=C:/AirView/src/mac/scheduler.c',
    'artifact_sha256=3b1f4a9c8e2d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a',
    'doc_url=https://github.com/TianLin0509/ai-hub-codeagent/blob/main/README.md',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(readDir, 'readme.md'), '# 调度器笔记\n\n改 RRC_FILTER_COEFF 之前先跑一遍 regress。\n', 'utf8');
  const outsideFile = path.join(outsideDir, 'never.txt');
  fs.writeFileSync(outsideFile, '这段内容一个字都不该出现\n', 'utf8');
  return { readDir, outsideDir, lutFile, secretsFile, outsideFile, lutLines: lut };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-company-files-'));
  const t0 = Date.now(); const log = m => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  const fixture = makeFixture(root);
  const result = { passed: false, root, out, checks: [], timings: {},
    scope: '真实 Electron ×2（家里源码 + 公司版导出）+ 真实通道服务（localhost）+ 真命令行子进程 read/list/search 真读盘' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); log('✔ ' + label); };
  let relay, home, company, hc, cc, asker;
  try {
    // ---- 公司版导出 ----
    const exportDir = process.env.COMPANY_ENTRY || path.join(root, 'export');
    if (!process.env.COMPANY_ENTRY) {
      execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
    }
    check(fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'file-query.js')) && fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'hub-admin.js'))
      && !fs.existsSync(path.join(exportDir, 'core', 'company-bridge', 'home.js')) && !fs.existsSync(path.join(exportDir, 'scripts', 'company-ask.js')),
      '公司版导出：带公司侧 file-query.js / hub-admin.js，不带家里侧 home.js / company-ask.js');

    // ---- 真通道服务 ----
    const relayPort = await freePort();
    relay = spawn(PY, ['-I', RELAY, '--root', path.join(root, 'relay'), '--port', String(relayPort)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${relayPort}/health`); if (r.ok) break; } catch {} await _waitMs(200); }
    const apiUrl = `http://127.0.0.1:${relayPort}`;

    const cdata = path.join(root, 'company-data'), hdata = path.join(root, 'home-data');
    { const { AssistantStore } = require('../core/hub-assistant/store'); const s = new AssistantStore(path.join(cdata, 'company-bridge')); s.set('featureUnlock', { at: Date.now(), via: 'e2e-files' }); s.db.close(); }
    const common = { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') };
    [home, company] = await Promise.all([
      launchIsolatedHub({ dataDir: hdata, port: await freePort(), windowMode: 'background', label: 'files-home', allowExternalState: true,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'home-hubhome'), CLAUDE_HUB_BRIDGE_ROLE: 'home', CLAUDE_HUB_BRIDGE_API_URL: apiUrl, CLAUDE_HUB_WIRELESS_TIMER: '0' } }),
      launchIsolatedHub({ dataDir: cdata, port: await freePort(), windowMode: 'background', label: 'files-company', allowExternalState: true, entryPath: exportDir,
        extraEnv: { ...common, CLAUDE_HUB_HOME_DIR: path.join(root, 'company-hubhome'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'cac'), AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
          AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]), AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000' } }),
    ]);
    [hc, cc] = await Promise.all([connectFirstPage(home), connectFirstPage(company)]);
    for (const c of [hc, cc]) await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const until = async (label, read, timeout = 60000, every = 1000) => { let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { last = await read(); } catch (e) { last = 'ERR ' + e.message; } if (last && !String(last).startsWith('ERR ')) return last; await _waitMs(every); } throw Error('timeout ' + label + ' last=' + j(last)); };
    const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); log('截图 ' + f); return f; };
    const status = c => c.eval('require("electron").ipcRenderer.invoke("bridge:status")');
    await until('renderers', async () => (await hc.eval('typeof window.__wirelessHide==="function"')) && (await cc.eval('typeof sessions!=="undefined"')), 90000, 300);

    // ---- 配对 ----
    const { code } = await hc.eval('require("electron").ipcRenderer.invoke("bridge:create-pairing")');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:pair", { code: ${j(code)} })`);
    await until('paired', async () => (await status(cc)).link.state === 'paired' && (await status(hc)).link.state === 'paired', 120000, 2000);
    check(true, '家里与公司配对接通（真通道服务）');

    // ---- 公司侧设置：界面上的「文件读取」开关默认开；「额外可读目录」填测试目录并保存生效 ----
    const cs0 = await status(cc);
    check(cs0.settings.allowRemoteFiles === true && cs0.settings.readRoots.length === 0, '公司「文件读取」默认打开，可读目录一开始是空的');
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ readRoots: [fixture.readDir] })})`);
    await until('readRoots saved', async () => {
      await cc.eval('document.getElementById("btn-toggle-navigation") && document.getElementById("btn-settings") && document.getElementById("btn-settings").click()');
      return (await status(cc)).settings.readRoots.includes(fixture.readDir);
    }, 20000, 500);
    const cs1 = await status(cc);
    check(cs1.settings.readRoots.length === 1 && cs1.settings.readRoots[0] === fixture.readDir, '额外可读目录保存生效：' + fixture.readDir);
    result.shots = [await shot(cc, '01-company-settings')];

    // ---- 家里：一个真会话当提问方（只取它的 id；通行证按真 Hub 的算法推导，与 Hub 给 Claude / Codex 会话挂的是同一个）----
    asker = await hc.eval(`require("electron").ipcRenderer.invoke('create-session', ${j({ kind: 'powershell', opts: { title: '读文件测试 · 提问方' } })})`);
    const hsid = asker && asker.id;
    assert.ok(hsid, 'home asker session: ' + j(asker));
    const master = (() => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(hdata, 'company-bridge', 'assistant.sqlite'), { readOnly: true });
      try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='localMaster'").get().value); } finally { db.close(); } })();
    const cliEnv = { ...process.env, HUB_BRIDGE_SESSION_ID: hsid, HUB_BRIDGE_SESSION_PASS: createHmac('sha256', master).update('session:' + hsid).digest('hex'),
      HUB_BRIDGE_ENDPOINT_FILE: path.join(hdata, 'company-bridge', 'mcp-endpoint.json') };
    const cli = args => {
      const raw = execFileSync(process.execPath, [path.join(repo, 'scripts', 'company-ask.js'), ...args], { env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 120000 });
      result.calls = (result.calls || []).concat([{ args, out: raw.trim() }]);
      return JSON.parse(raw);
    };

    // ---- 1. 读一份真文件 ----
    const readAt = Date.now();
    const first = cli(['--files', 'read', '--file', fixture.lutFile]);
    result.timings.firstReadMs = Date.now() - readAt;
    result.firstView = { id: first.id, status: first.status, bytes: first.bytes, waived: first.waitedSec, summary: first.summary, degraded: first.degraded };
    check(first.ok === true && first.status === '已回报', `读文件回报到达：${first.status}（${(result.timings.firstReadMs / 1000).toFixed(1)} 秒，编号 ${first.id}）`);
    const r1 = first.result || {};
    check(Array.isArray(r1.lines) && r1.lines.join('\n') === fixture.lutLines.join('\n') && r1.totalLines === fixture.lutLines.length && r1.more !== true,
      `读回来的 ${r1.lines.length} 行与公司那份文件逐行一致（共 ${r1.totalLines} 行、${r1.sizeBytes} 字节，未截断）`);
    check(r1.path === fixture.lutFile && /^[1-9]/.test(String(first.bytes)) && first.bytes < 60000 && (first.degraded || []).length === 0,
      `一条消息装下整份内容：${first.bytes} 字节（< 60000），没有降级`);
    result.shots.push(await shot(hc, '02-home-after-read'));

    // ---- 2. 5 秒内再读：被挡 ----
    const again = cli(['--files', 'read', '--file', fixture.secretsFile]);
    check(again.status === '公司没处理' && /5 秒内只做一次/.test(again.note || ''), '5 秒内重复读被挡：' + again.note);

    // ---- 3. 列目录 + 找文件（各算各的限频：列目录 10 秒、找文件 20 秒）----
    const listed = cli(['--files', 'list', '--dir', fixture.readDir, '--depth', '1', '--limit', '50']);
    const l = listed.result || {};
    check(listed.status === '已回报' && l.files >= 3 && (l.entries || []).some(e => e.name === 'DL256QAM.txt') && (l.entries || []).some(e => e.name === 'collect.log'),
      `列目录：${l.dirs || 0} 个子目录、${l.files || 0} 个可读文件，逐个带名字`);
    const found = cli(['--files', 'search', '--content', 'RRC_FILTER_COEFF', '--root', fixture.readDir, '--limit', '20']);
    const s = found.result || {};
    check(found.status === '已回报' && (s.matches || []).length === 1 && /readme\.md$/.test(s.matches[0].file || s.matches[0].path || ''),
      `找文件：内容含 RRC_FILTER_COEFF 的命中 ${(s.matches || []).length} 个，指向 readme.md`);

    // ---- 4. 等过 5 秒，读带凭据的那份：隐去凭据、保留代码与路径 ----
    await _waitMs(Math.max(0, 6000 - (Date.now() - readAt)));
    const sec = cli(['--files', 'read', '--file', fixture.secretsFile]);
    const text = (sec.result?.lines || []).join('\n');
    const leaked = SECRETS.filter(x => text.includes(x));
    check(sec.status === '已回报' && !leaked.length && /<已隐去>/.test(text) && /<已隐去：私钥 \/ 证书>/.test(text),
      '凭据类内容都隐去了' + (leaked.length ? '（漏了：' + leaked.join('、') + '）' : '：密钥、密码、Bearer 令牌、私钥块'));
    check(text.includes('source_path=C:/AirView/src/mac/scheduler.c') && text.includes('artifact_sha256=3b1f4a9c8e2d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a')
      && text.includes('doc_url=https://github.com/TianLin0509/ai-hub-codeagent/blob/main/README.md'),
      '脱敏只动凭据：源码路径、sha256、文档 URL 原样保留');

    // ---- 5. 可读目录之外的路径：挡 ----
    const out5 = cli(['--files', 'read', '--file', fixture.outsideFile]);
    check(out5.status === '公司没处理' && /不在可读目录里/.test(out5.note || '') && !j(out5).includes('一个字都不该出现'),
      '可读目录之外的路径被挡，且没有内容带回来：' + out5.note);

    // ---- 6. 带编号取回上一次的结果：不再麻烦公司 ----
    const before = (await status(cc)).hubAdmin.lastFiles;
    const cached = cli(['--files', 'read', '--id', first.id]);
    const after = (await status(cc)).hubAdmin.lastFiles;
    check(cached.ok === true && (cached.result?.lines || []).join('\n') === fixture.lutLines.join('\n') && before && after && before.id === after.id && before.at === after.at,
      `带编号 ${first.id} 取回上一次结果：内容一致，公司没有再读一次盘`);

    // ---- 7. 关掉开关：挡；打开：通 ----
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ allowRemoteFiles: false })})`);
    const off = cli(['--files', 'read', '--file', fixture.lutFile]);
    check(off.status === '公司没处理' && /没允许对端读取文件/.test(off.note || ''), '关掉「文件读取」后同一份文件读不到：' + off.note);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ allowRemoteFiles: true })})`);
    await _waitMs(1000);
    await cc.eval(`require("electron").ipcRenderer.invoke("bridge:set-settings", ${j({ allowRemoteFiles: true })})`);
    // 限频从上一次成功读结束算：等 5 秒再读一次，验证打开就通
    await _waitMs(5500);
    const on = cli(['--files', 'read', '--file', fixture.lutFile, '--from', '2', '--lines', '5']);
    check(on.status === '已回报' && (on.result?.lines || []).length === 5 && on.result?.from === 2,
      '重新打开后又能读：只取第 2 行起的 5 行（分段读）');

    // ---- 8. 公司侧留痕：审计日志、状态、界面提示 ----
    const audit = fs.readFileSync(path.join(cdata, 'logs', 'company-files.log'), 'utf8');
    check(new RegExp(`files ${first.id} read`).test(audit) && /files .* list /.test(audit) && /files .* search /.test(audit) && /refused .* read/.test(audit),
      '公司审计日志逐条留痕：成功的 read / list / search 和被挡的都记了');
    const cs2 = await status(cc);
    check(cs2.hubAdmin.lastFiles && cs2.hubAdmin.lastFiles.id === on.id && cs2.hubAdmin.lastFiles.action === 'read',
      '公司状态里记着最近一次读文件：编号 ' + (cs2.hubAdmin.lastFiles || {}).id);
    result.auditTail = audit.trim().split('\n').slice(-4);
    const homeText = await hc.eval('document.querySelector("[data-cl=\\"files\\"]") ? document.querySelector("[data-cl=\\"files\\"]").innerText.slice(0,200) : "(公司联动区块没有读文件按钮，说明走命令行/MCP 这条路)"');
    result.homeHint = homeText;
    result.passed = true;
  } catch (error) {
    result.error = (error && error.stack) || String(error);
    console.error(result.error);
  } finally {
    try { hc && hc.close(); } catch {}
    try { cc && cc.close(); } catch {}
    if (home) await gracefulQuit(home).catch(() => {});
    if (company) await gracefulQuit(company).catch(() => {});
    try { relay && relay.kill(); } catch {}
    fs.writeFileSync(path.join(out, '20261020-company-files-e2e-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, timings: result.timings, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });