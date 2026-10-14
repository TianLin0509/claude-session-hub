'use strict';
// 无线 Tab · SuperRAN 助理真人操作验收：隔离 Hub + 假协作台（假接入包脚本，不碰线上协作台）+ 真实 Codex 会话。
// 验收：左侧点「无线」打开页面，显示默认主力 GPT-6 Astra · 最高 · 标准速度、替补 Opus 5.5 · 最高；
// 设置里改主力（为省额度，本验收改用 GPT-6 Luna · 低）；点「立即检查」后，已推进提案新开一个会话并发出执行提示词，
// 画面不被切走；含删除操作的提案停在「待你放行」；点「打开会话」进入该会话；点别的 Tab 页面收起，再进状态仍在。
// 只验证派发链路：确认收到后立刻停下这一轮；前后核对本机真实 SuperRAN 登记文件没被改动。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function fakePortal(root) {
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'e2e0000000000000'), repo = path.join(root, 'SuperRAN-e2e');
  fs.mkdirSync(kit, { recursive: true }); fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  const sha = 'e2e'.padEnd(64, '0');
  const list = { user: 'lintian-admin', proposals: [
    { id: 'e2e00000a1a1a1a1', title: 'E2E 演练：尾包重传应在下一个下行时隙发生', author: 'member:演练甲', state: 'accepted', executor: '', content_revision: 1, content_sha: sha, result: '', note: '', markdown: '📌 **演练提案**\n## 给人看\n人话：尾包首传失败后，下一个可用下行时隙就该重传。' },
    { id: 'e2e00000b2b2b2b2', title: 'E2E 演练：红灯测试里有删除目录的操作', author: 'member:演练乙', state: 'accepted', executor: '', content_revision: 1, content_sha: sha, result: '', note: '', markdown: '### 红灯测试\n```python\nimport shutil\nshutil.rmtree(\"C:/Temp/x\")\n```' },
    { id: 'e2e00000c3c3c3c3', title: 'E2E 演练：还没推进的提案', author: 'member:演练丙', state: 'submitted', executor: '', content_revision: 1, content_sha: sha, result: '', note: '', markdown: '' },
  ] };
  fs.writeFileSync(path.join(kit, 'list.json'), JSON.stringify(list), 'utf8');
  fs.writeFileSync(path.join(kit, 'superran-proposals.py'), [
    'import sys, pathlib',
    'sys.stdout.reconfigure(encoding="utf-8"); sys.stderr.reconfigure(encoding="utf-8")',
    'if sys.argv[-1] == "list":',
    '    print(pathlib.Path(__file__).with_name("list.json").read_text(encoding="utf-8")); sys.exit(0)',
    'print("服务返回 401：这是 E2E 假协作台，没有真实身份", file=sys.stderr); sys.exit(1)',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(kit, 'superran-proposals.json'), '{"role":"executor"}');
  fs.writeFileSync(path.join(kit, 'kit.json'), JSON.stringify({ user: 'lintian-admin', url: 'https://ai.lt-stockpartner.tech/superran-dev', expires: Math.floor(Date.now() / 1000) + 86400 * 25 }));
  fs.writeFileSync(path.join(home, '.config', 'superran', 'local-installation.json'), JSON.stringify({ root: repo, python: process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe', executor_config: path.join(kit, 'superran-proposals.json'), executor_user: 'lintian-admin' }));
  return { home, repo };
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'wireless-tab-')), data = path.join(root, 'data');
  const out = path.resolve('artifacts/wireless-tab', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 界面 + 真实 Codex 会话（GPT-6 Luna · 低，省额度）；协作台为本机假接入包脚本，未接触线上协作台', out, checks: [] };
  const { home } = fakePortal(root);
  const realRegistry = path.join(os.homedir(), '.config', 'superran', 'local-installation.json');
  const registryBefore = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
  // 隔离 Hub 没有 CLI 登录：照 e2e-assistant-backends-live.js，把 Codex 登录复制进测试目录（隔离 Hub 不允许直接用真实账号目录），
  // 工作目录标为受信任；替补也设成 Codex，不碰 Claude 登录。结束时核对真实登录文件没被改动。
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8').replace(/^﻿/, ''));
  const prov = cfg.providers?.codex || {}, profile = (prov.subscription_profiles || []).find(p => p.id === prov.subscription_profile) || { id: 'default', label: '主账号', home: '' };
  const codexAuth = path.join(profile.home || path.join(os.homedir(), '.codex'), 'auth.json'), codexHome = path.join(root, 'codex');
  const authBefore = fs.readFileSync(codexAuth);
  fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
  const models = path.join(path.dirname(codexAuth), 'models_cache.json'); if (fs.existsSync(models)) fs.copyFileSync(models, path.join(codexHome, 'models_cache.json'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [path.join(root, 'SuperRAN-e2e'), root].map(p => "[projects.'" + p.toLowerCase() + "']\ntrust_level = \"trusted\"").join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'config.json'), j({ providers: { codex: { backend: 'subscription', subscription_profile: profile.id, subscription_profiles: [{ id: profile.id, label: profile.label, home: codexHome }] } } }));
  let hub, cdp;
  const until = async (label, read, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await read(); if (v) return v; await wait(300); } throw Error('timeout ' + label); };
  const click = async selector => { await until('clickable ' + selector, () => cdp.eval('(()=>{const e=document.querySelector(' + j(selector) + ');if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'), 20000); const p = await cdp.eval('(()=>{const r=document.querySelector(' + j(selector) + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'); for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  const visible = () => cdp.eval('!!document.querySelector("#wireless-page:not([hidden])")');
  const text = sel => cdp.eval('(document.querySelector(' + j(sel) + ')?.innerText||"").replace(/\\s+/g," ")');
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'wireless-tab', allowExternalState: true,
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), CLAUDE_HUB_WIRELESS_HOME: home, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '',
        CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
        HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') } });
    cdp = await connectFirstPage(hub); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => cdp.eval('!!document.getElementById("btn-wireless") && typeof window.__wirelessHide==="function"'));
    if (await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click('#btn-toggle-navigation');
    // 1. 打开无线页：默认配置。
    await click('#btn-wireless'); await until('wireless page', visible);
    const strip = await until('strip', async () => { const t = await text('.wp-strip'); return /主力/.test(t) && t; });
    assert.match(strip, /主力 GPT-6 Astra · 最高 · 标准速度/); assert.match(strip, /替补 Opus 5\.5 · 最高/);
    assert.match(strip, /同时最多 2 个/); assert.match(strip, /lintian-admin · 还剩 2[45] 天/);
    await until('导航高亮「无线」', () => cdp.eval('document.querySelector("#btn-wireless").getAttribute("aria-current")==="page" && !document.querySelector("#btn-home").hasAttribute("aria-current")'), 5000);
    await shot('01-open-defaults'); result.checks.push('点「无线」打开 SuperRAN 助理页：默认主力 GPT-6 Astra · 最高 · 标准速度，替补 Opus 5.5 · 最高，同时 2 个，接入包剩余天数正确，导航高亮「无线」');
    // 2. 设置里把主力改成 GPT-6 Luna · 低（只为省额度），保存后状态条更新。
    await click('[data-wp="settings"]'); await until('settings', () => cdp.eval('!!document.querySelector(".wp-settings")'));
    await shot('02-settings');
    for (const route of ['primary', 'fallback']) await cdp.eval('(()=>{const fs=document.querySelector(\'.wp-settings fieldset[data-route="' + route + '"]\');const k=fs.querySelector(\'[data-f="kind"]\');k.value="codex";k.dispatchEvent(new Event("change"));const m=fs.querySelector(\'[data-f="model"]\');m.value="gpt-6-luna";m.dispatchEvent(new Event("change"));fs.querySelector(\'[data-f="effort"]\').value="low";})()');
    await click('.wp-settings [data-x="save"]'); await until('saved', async () => { const t = await text('.wp-strip'); return /主力 GPT-6 Luna · 低 · 标准速度/.test(t) && /替补 GPT-6 Luna · 低/.test(t); });
    result.checks.push('设置面板改主力、替补的后端 / 模型 / 思考深度，保存后状态条立即更新（本验收为省额度、免登录改成 GPT-6 Luna · 低）');
    // 3. 立即检查：已推进提案新开会话并发出提示词；危险提案待放行；未推进的不出现。画面不被切走。
    const activeBefore = await cdp.eval('typeof activeSessionId!=="undefined"?activeSessionId:null');
    await click('[data-wp="check"]');
    await until('working', async () => /处理中/.test(await text('[data-sec="active"]')), 60000);
    await until('confirmed', async () => /已交给 Agent/.test(await text('[data-sec="active"]')), 120000);
    const held = await text('[data-sec="held"]');
    assert.match(held, /红灯测试里有删除目录的操作/); assert.match(held, /Python 删除文件/);
    assert.doesNotMatch(await text('.wp-body'), /还没推进的提案/);
    assert.equal(await visible(), true, '派发后仍停在无线页');
    assert.equal(await cdp.eval('typeof activeSessionId!=="undefined"?activeSessionId:null'), activeBefore, '没有切到新会话');
    const session = await cdp.eval('(async()=>{const all=await require("electron").ipcRenderer.invoke("get-sessions");const s=all.find(x=>x.purpose==="wireless-proposal");return s&&{id:s.id,kind:s.kind,title:s.title,model:s.currentModel?.id||s.model||null}})()');
    assert.ok(session, '会话栏里有提案会话'); assert.equal(session.kind, 'codex'); assert.match(session.title, /^无线 · E2E 演练：尾包重传/);
    result.session = session;
    await shot('03-dispatched'); result.checks.push('点「立即检查」：已推进提案新开 Codex 会话并确认收到执行提示词；含删除操作的提案停在「待你放行」并列出原因；未推进的提案不出现；画面不被切走');
    // 4. 待放行的选「不处理」。
    await click('[data-sec="held"] [data-wp^="dismiss:"]'); await until('dismissed', async () => /你选择不处理/.test(await text('[data-sec="recent"]')));
    result.checks.push('「待你放行」的提案点「不处理」后移到最近结果');
    // 5. 切到别的 Tab 再回来。
    await click('#btn-home'); await until('closed', async () => !(await visible()), 5000);
    await click('#btn-wireless'); await until('reopen', async () => /处理中/.test(await text('[data-sec="active"]')), 10000);
    result.checks.push('点「主页」无线页收起，再进状态仍在');
    // 6. 打开会话：进入该提案会话。
    await click('[data-sec="active"] [data-wp^="open:"]');
    await until('session opened', async () => !(await visible()) && await cdp.eval('typeof activeSessionId!=="undefined"&&activeSessionId===' + j(session.id)), 15000);
    await shot('04-session'); result.checks.push('点「打开会话」进入该提案的会话');
    // 7. 只验证派发链路：确认收到后立刻按 Esc 停下这轮，不让真实 Agent 在本机继续动作。
    await wait(8000);
    await cdp.eval('require("electron").ipcRenderer.send("terminal-input",{sessionId:' + j(session.id) + ',data:"\u001b"})');
    await wait(3000); await shot('05-stopped');
    result.checks.push('派发后按 Esc 停下这一轮（本验收不让真实 Agent 继续执行）');
    result.passed = true;
  } catch (e) { result.error = e.stack; process.exitCode = 1; if (cdp) await shot('failure').catch(() => {}); }
  finally {
    if (cdp) cdp.close();
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); try { await gracefulQuit(hub); } catch (e) { result.cleanupError = e.message; } }
    const registryAfter = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
    result.realRegistryUnchanged = registryAfter === registryBefore;
    result.realCodexAuthUnchanged = Buffer.compare(fs.readFileSync(codexAuth), authBefore) === 0;
    if (!result.realRegistryUnchanged || !result.realCodexAuthUnchanged) { result.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'result.json'), j(result, null, 1)); console.log(j(result, null, 1));
  }
}
main();
