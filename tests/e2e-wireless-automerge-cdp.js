'use strict';
// 无线 Tab · SuperRAN 助理「审批合入」一段的真人操作验收（2026-10-15）：隔离 Hub + 假协作台 + 假合并位脚本
// （不碰线上协作台和真实合并机）+ 真实 Codex 会话。
// 验收：左侧点「无线」，状态条显示「审查与合入」一行；点「立即检查」后，提出人已验收的 PR 新开一个「审查」会话
// 并确认收到审查提示词（含 prepare / record），画面不被切走；随后假协作台变成「审查通过且已批准」，再点「立即检查」，
// 审查记为完成、合入由脚本跑完并标「已合入 develop」，可点「合入日志」；合入不开会话。
// 只验证派发链路：审查会话确认收到后立刻停下这一轮；前后核对本机真实登记文件、Codex 登录没被改动。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const CAND = 'c2e'.padEnd(40, '0'), BASE = 'b2e'.padEnd(40, '0');

function fakePortal(root) {
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'e2e0000000000000'), repo = path.join(root, 'SuperRAN-e2e');
  fs.mkdirSync(kit, { recursive: true }); fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  const sha = 'e2e'.padEnd(64, '0');
  const list = { user: 'lintian-admin', proposals: [
    { id: 'e2e00000d4d4d4d4', title: 'E2E 演练：提出人已验收、等审查合入', author: 'member:演练丁', state: 'reported', executor: 'wx-e2e00000-1', content_revision: 1, content_sha: sha,
      result: '📌 **已修改：演练。**', outcome: 'modified', pr_number: 41, note: '提出人验收通过', acceptance_view: { state: 'lead' }, markdown: '📌 **演练提案**' },
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
  fs.writeFileSync(path.join(home, '.config', 'superran', 'local-installation.json'), JSON.stringify({ root: repo, python: PY, executor_config: path.join(kit, 'superran-proposals.json'), executor_user: 'lintian-admin' }));
  // 假合并位脚本：status 读 tasks.json；merge 打几行日志、把状态改成已合入并打印回执；其余命令只回一句。
  const scripts = path.join(root, 'skills', 'superran-review-merge', 'scripts'); fs.mkdirSync(scripts, { recursive: true });
  const tasks = path.join(scripts, 'tasks.json');
  fs.writeFileSync(tasks, j({ trunk: BASE, tasks: [{ pr: 41, title: 'PR 41', state: 'submitted', revision: 2, candidate: CAND, base: BASE, reviews: [] }] }));
  const script = path.join(scripts, 'review_merge.py');
  fs.writeFileSync(script, [
    'import sys, json, pathlib, time',
    'sys.stdout.reconfigure(encoding="utf-8")',
    'store = pathlib.Path(__file__).with_name("tasks.json")',
    'data = json.loads(store.read_text(encoding="utf-8"))',
    'cmd = sys.argv[1]',
    'if cmd == "status":',
    '    print(json.dumps(data, ensure_ascii=False)); sys.exit(0)',
    'if cmd == "merge":',
    '    print("E2E：完整测试闸门 39/39 通过（假）"); sys.stdout.flush(); time.sleep(2)',
    '    for t in data["tasks"]:',
    '        if t["pr"] == int(sys.argv[2]): t["state"] = "completed"',
    '    store.write_text(json.dumps(data), encoding="utf-8")',
    '    print(json.dumps({"pr": int(sys.argv[2]), "state": "completed", "merged": "e2e" + "0" * 37, "cloud_trunk": "e2e" + "0" * 37}, ensure_ascii=False, indent=2)); sys.exit(0)',
    'print(json.dumps({"note": "E2E 假脚本：" + cmd + " 不做任何事"}, ensure_ascii=False)); sys.exit(0)',
  ].join('\n'), 'utf8');
  return { home, repo, script, tasks };
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'wireless-merge-')), data = path.join(root, 'data');
  const out = path.resolve('artifacts/wireless-automerge', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 界面 + 真实 Codex 会话（GPT-6 Luna · 低，省额度）；协作台与合并位脚本均为本机假脚本，未接触线上协作台和真实合并机', out, checks: [] };
  const fake = fakePortal(root);
  const realRegistry = path.join(os.homedir(), '.config', 'superran', 'local-installation.json');
  const registryBefore = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
  // 照 e2e-wireless-tab-cdp.js：把 Codex 登录复制进测试目录，主力和替补都用 Codex，不碰 Claude 登录。
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const prov = cfg.providers?.codex || {}, profile = (prov.subscription_profiles || []).find(p => p.id === prov.subscription_profile) || { id: 'default', label: '主账号', home: '' };
  const codexAuth = path.join(profile.home || path.join(os.homedir(), '.codex'), 'auth.json'), codexHome = path.join(root, 'codex');
  const authBefore = fs.readFileSync(codexAuth);
  fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
  const models = path.join(path.dirname(codexAuth), 'models_cache.json'); if (fs.existsSync(models)) fs.copyFileSync(models, path.join(codexHome, 'models_cache.json'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [fake.repo, root].map(p => "[projects.'" + p.toLowerCase() + "']\ntrust_level = \"trusted\"").join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'config.json'), j({ providers: { codex: { backend: 'subscription', subscription_profile: profile.id, subscription_profiles: [{ id: profile.id, label: profile.label, home: codexHome }] } } }));
  let hub, cdp;
  const until = async (label, read, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await read(); if (v) return v; await wait(300); } throw Error('timeout ' + label); };
  const click = async selector => { await until('clickable ' + selector, () => cdp.eval('(()=>{const e=document.querySelector(' + j(selector) + ');if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'), 20000); const p = await cdp.eval('(()=>{const r=document.querySelector(' + j(selector) + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'); for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  const visible = () => cdp.eval('!!document.querySelector("#wireless-page:not([hidden])")');
  const text = sel => cdp.eval('(document.querySelector(' + j(sel) + ')?.innerText||"").replace(/\\s+/g," ")');
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'wireless-merge', allowExternalState: true,
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), CLAUDE_HUB_WIRELESS_HOME: fake.home, CLAUDE_HUB_WIRELESS_REVIEW_MERGE: fake.script, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '',
        CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
        HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') } });
    cdp = await connectFirstPage(hub); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => cdp.eval('!!document.getElementById("btn-wireless") && typeof window.__wirelessHide==="function"'));
    if (await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click('#btn-toggle-navigation');
    // 1. 打开无线页，主力、替补改成 GPT-6 Luna · 低（省额度、免登录 Claude）。
    await click('#btn-wireless'); await until('wireless page', visible);
    await until('subtitle', async () => /审批人在协作台点「批准合入」后自动合入/.test(await text('.wp-title')));
    await click('[data-wp="settings"]'); await until('settings', () => cdp.eval('!!document.querySelector(".wp-settings")'));
    for (const route of ['primary', 'fallback']) await cdp.eval('(()=>{const fs=document.querySelector(\'.wp-settings fieldset[data-route="' + route + '"]\');const k=fs.querySelector(\'[data-f="kind"]\');k.value="codex";k.dispatchEvent(new Event("change"));const m=fs.querySelector(\'[data-f="model"]\');m.value="gpt-6-luna";m.dispatchEvent(new Event("change"));fs.querySelector(\'[data-f="effort"]\').value="low";})()');
    await click('.wp-settings [data-x="save"]'); await until('saved', async () => /主力 GPT-6 Luna · 低/.test(await text('.wp-strip')));
    result.checks.push('点「无线」打开页面：副标题写明「提出人验收后换一家模型审查；审批人点批准合入后自动合入」；设置改成 GPT-6 Luna · 低（省额度）');
    // 2. 立即检查：提出人已验收的 PR 新开「审查」会话并确认收到提示词；画面不被切走。
    const activeBefore = await cdp.eval('typeof activeSessionId!=="undefined"?activeSessionId:null');
    await click('[data-wp="check"]');
    await until('review working', async () => { const t = await text('[data-sec="active"]'); return /审查/.test(t) && /PR #41/.test(t) && t; }, 60000);
    await until('confirmed', async () => /已交给 Agent/.test(await text('[data-sec="active"]')), 120000);
    const strip = await text('.wp-strip');
    assert.match(strip, /审查与合入/); assert.match(strip, /待审查 1 个 PR，待合入 0 个/);
    assert.equal(await visible(), true, '派发后仍停在无线页');
    assert.equal(await cdp.eval('typeof activeSessionId!=="undefined"?activeSessionId:null'), activeBefore, '没有切到新会话');
    const session = await cdp.eval('(async()=>{const all=await require("electron").ipcRenderer.invoke("get-sessions");const s=all.find(x=>x.purpose==="wireless-proposal");return s&&{id:s.id,kind:s.kind,title:s.title}})()');
    assert.ok(session, '会话栏里有审查会话'); assert.match(session.title, /^无线 · 审查 · E2E 演练/);
    result.session = session;
    await shot('01-review-dispatched');
    result.checks.push('点「立即检查」：提出人已验收的 PR #41 新开「审查」会话（标「审查」、PR 号与候选），确认收到审查提示词；状态条「审查与合入」显示待审查 1 个；画面不被切走');
    // 3. 只验证派发链路：确认收到后按 Esc 停下这一轮。
    await wait(6000);
    await cdp.eval('require("electron").ipcRenderer.send("terminal-input",{sessionId:' + j(session.id) + ',data:"\\u001b"})');
    result.checks.push('审查会话确认收到后按 Esc 停下（本验收不让真实 Agent 继续执行）');
    // 4. 假协作台：审查通过且审批人已批准 → 再检查：审查完成，合入脚本跑完。
    const tasks = JSON.parse(fs.readFileSync(fake.tasks, 'utf8')); tasks.tasks[0].state = 'approved'; fs.writeFileSync(fake.tasks, j(tasks));
    await click('[data-wp="check"]');
    const merged = await until('merged', async () => { const t = await text('[data-sec="recent"]'); return /已合入 develop（e2e00000）/.test(t) && t; }, 60000);
    assert.match(merged, /审查通过，审批人已批准，开始合入/);
    const sessions = await cdp.eval('(async()=>(await require("electron").ipcRenderer.invoke("get-sessions")).filter(x=>x.purpose==="wireless-proposal").length)()');
    assert.equal(sessions, 1, '合入不开会话');
    assert.ok(await cdp.eval('!!document.querySelector("[data-sec=recent] [data-wp^=\\"log:\\"]")'), '有「合入日志」按钮');
    const log = fs.readdirSync(path.join(data, 'wireless', 'logs')).map(f => fs.readFileSync(path.join(data, 'wireless', 'logs', f), 'utf8')).join('\n');
    assert.match(log, /完整测试闸门 39\/39 通过（假）/);
    await shot('02-merged');
    result.checks.push('假协作台变成「审查通过且已批准」后点「立即检查」：审查记「审查通过，审批人已批准，开始合入」，合并脚本跑完标「已合入 develop」，可点「合入日志」，日志里有脚本输出；合入没有新开会话');
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
