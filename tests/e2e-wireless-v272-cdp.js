'use strict';
// 无线 Tab · SuperRAN 助理 v2.7.2 的真人操作验收（2026-10-15）：隔离 Hub + 假协作台 + 假合并位脚本
// （不碰线上协作台和真实合并机）+ 真实 Codex 会话（GPT-6 Luna · 低，省额度；确认收到提示词后按 Esc 停下）。
// 验收两条新链路：
//  A. B 档自动重审：已批准的 PR #41 合入时，假合并脚本按 B 档把任务退回审查（批准保留）→ 页面「最近结果」记「回到审查」
//     → 再检查时自动开「审查」会话、提示词写明「自动重审」和 --trunk → 假协作台回到已批准 → 再检查按新一轮合入并标「已合入」。
//  B. 初审（Agent 执行的第一个子步骤）：新提案派出的会话先只读出计划；计划要改的 native.py 正被在途 PR #17 修改
//     （红档物理文件）→ 页面「正在处理」显示「等 PR #17」和「不等了，直接开始」；点按钮后在原会话开始实现。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const CAND = 'c27'.padEnd(40, '0'), BASE = 'b27'.padEnd(40, '0'), TRUNK = 'd27'.padEnd(40, '0'), CAND17 = 'a17'.padEnd(40, '0');
const NEW = 'e2e72000n1n1n1n1', B41 = 'e2e72000b4b4b4b4', Y17 = 'e2e72000y7y7y7y7';

function fakePortal(root) {
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'e2e0000000000000'), repo = path.join(root, 'SuperRAN-e2e');
  fs.mkdirSync(kit, { recursive: true }); fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  const sha = id => id.padEnd(64, '0');
  const base = { author: 'member:演练丁', content_revision: 1, markdown: '📌 **演练提案**', note: '' };
  const proposals = [
    { ...base, id: NEW, title: 'E2E 演练：新提案，开工前避撞', state: 'accepted', executor: '', content_sha: sha(NEW), result: '' },
    { ...base, id: B41, title: 'E2E 演练：B 档自动重审', state: 'reported', executor: 'wx-e2e72000-1', content_sha: sha(B41), result: '📌 **已修改：演练。**', outcome: 'modified', pr_number: 41, acceptance_view: { state: 'lead' } },
    { ...base, id: Y17, title: 'E2E 演练：在途 PR 17', state: 'reported', executor: 'wx-e2e72000-1', content_sha: sha(Y17), result: '📌 **已修改：演练。**', outcome: 'modified', pr_number: 17, acceptance_view: { state: 'pending' } },
  ];
  const listFile = path.join(kit, 'list.json');
  fs.writeFileSync(listFile, JSON.stringify({ user: 'lintian-admin', proposals }), 'utf8');
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
  // 假合并位脚本：status 读 tasks.json；inflight 回 PR 17 正在改的红档文件；merge 第一次按 B 档退回审查，之后才合入。
  const scripts = path.join(root, 'skills', 'superran-review-merge', 'scripts'); fs.mkdirSync(scripts, { recursive: true });
  const tasksFile = path.join(scripts, 'tasks.json');
  const tasks = [
    { pr: 41, title: 'PR 41', state: 'approved', revision: 2, candidate: CAND, base: BASE, reviews: [], reviewed_trunk: BASE, rereview: '' },
    { pr: 17, title: 'PR 17', state: 'awaiting_approval', revision: 2, candidate: CAND17, base: BASE, reviews: [], reviewed_trunk: '', rereview: '' },  // 审查已过、等验收：在途但不再派审查
  ];
  fs.writeFileSync(tasksFile, j({ trunk: TRUNK, tasks }));
  const script = path.join(scripts, 'review_merge.py');
  fs.writeFileSync(script, [
    'import sys, json, pathlib, time',
    'sys.stdout.reconfigure(encoding="utf-8")',
    'store = pathlib.Path(__file__).with_name("tasks.json")',
    'calls = pathlib.Path(__file__).with_name("calls.log")',
    'data = json.loads(store.read_text(encoding="utf-8"))',
    'cmd = sys.argv[1]',
    'calls.open("a", encoding="utf-8").write(" ".join(sys.argv[1:]) + "\\n")',
    'if cmd == "status":',
    '    print(json.dumps(data, ensure_ascii=False)); sys.exit(0)',
    'if cmd == "inflight":',
    '    rows = [{"pr": t["pr"], "state": t["state"], "title": t["title"], "candidate": t["candidate"], "files": 3,',
    '             "changed": ["src/superran/channel/native.py"] if t["pr"] == 17 else [], "functions": {},',
    '             "red_files": ["src/superran/channel/native.py"] if t["pr"] == 17 else []} for t in data["tasks"] if t["state"] != "completed"]',
    '    print(json.dumps({"trunk": data["trunk"], "red": ["native.py"], "tasks": rows, "errors": []}, ensure_ascii=False)); sys.exit(0)',
    'if cmd == "merge":',
    '    pr = int(sys.argv[2]); t = next(x for x in data["tasks"] if x["pr"] == pr)',
    '    if t.get("reviewed_trunk") != data["trunk"]:',
    '        print("E2E：B 档，主干在审查后又改到 src/superran/channel/native.py（假）")',
    '        t.update(state="submitted", rereview=data["trunk"]); store.write_text(json.dumps(data), encoding="utf-8")',
    '        print(json.dumps({"pr": pr, "state": "submitted", "tier": "B", "rereview": ["src/superran/channel/native.py"], "trunk": data["trunk"]}, ensure_ascii=False, indent=2)); sys.exit(0)',
    '    print("E2E：A 档并入最新主干，完整测试闸门 39/39 通过（假）"); sys.stdout.flush(); time.sleep(2)',
    '    t["state"] = "completed"; store.write_text(json.dumps(data), encoding="utf-8")',
    '    print(json.dumps({"pr": pr, "state": "completed", "merged": "e27" + "0" * 37, "tier": "B", "merged_onto": data["trunk"]}, ensure_ascii=False, indent=2)); sys.exit(0)',
    'print(json.dumps({"note": "E2E 假脚本：" + cmd + " 不做任何事"}, ensure_ascii=False)); sys.exit(0)',
  ].join('\n'), 'utf8');
  const edit = (file, fn) => { const v = JSON.parse(fs.readFileSync(file, 'utf8')); fn(v); fs.writeFileSync(file, j(v)); };
  return { home, repo, script, tasksFile, listFile, calls: path.join(scripts, 'calls.log'),
    proposals: fn => edit(listFile, v => fn(Object.fromEntries(v.proposals.map(p => [p.id, p])))),
    tasks: fn => edit(tasksFile, v => fn(Object.fromEntries(v.tasks.map(t => [t.pr, t])))) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'wireless-v272-')), data = path.join(root, 'data');
  const out = path.resolve('artifacts/wireless-v272', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, scope: '真实隔离 Hub 界面 + 真实 Codex 会话（GPT-6 Luna · 低，确认收到提示词后停下）；协作台与合并位脚本均为本机假脚本，未接触线上协作台和真实合并机', out, checks: [] };
  const fake = fakePortal(root);
  const realRegistry = path.join(os.homedir(), '.config', 'superran', 'local-installation.json');
  const registryBefore = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
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
  const click = async selector => { await until('clickable ' + selector, () => cdp.eval('(()=>{const e=document.querySelector(' + j(selector) + ');if(!e||e.disabled)return false;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'), 20000); const p = await cdp.eval('(()=>{const r=document.querySelector(' + j(selector) + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'); for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  const text = sel => cdp.eval('(document.querySelector(' + j(sel) + ')?.innerText||"").replace(/\\s+/g," ")');
  const status = () => cdp.eval('require("electron").ipcRenderer.invoke("wireless:status")');
  const job = async pred => (await status()).jobs.find(pred);
  const check = async () => { await click('[data-wp="check"]'); await until('check done', async () => !(await status()).polling, 60000); };
  const stop = async sessionId => { await wait(4000); await cdp.eval('require("electron").ipcRenderer.send("terminal-input",{sessionId:' + j(sessionId) + ',data:"\\u001b"})'); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'wireless-v272', allowExternalState: true,
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), CLAUDE_HUB_WIRELESS_HOME: fake.home, CLAUDE_HUB_WIRELESS_REVIEW_MERGE: fake.script, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '',
        CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
        HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') } });
    cdp = await connectFirstPage(hub); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => cdp.eval('!!document.getElementById("btn-wireless") && typeof window.__wirelessHide==="function"'));
    if (await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click('#btn-toggle-navigation');
    await click('#btn-wireless'); await until('wireless page', () => cdp.eval('!!document.querySelector("#wireless-page:not([hidden])")'));
    await until('subtitle', async () => /没冲突时自动并入新主干/.test(await text('.wp-title')));
    await click('[data-wp="settings"]'); await until('settings', () => cdp.eval('!!document.querySelector(".wp-settings")'));
    for (const route of ['primary', 'fallback']) await cdp.eval('(()=>{const fs=document.querySelector(\'.wp-settings fieldset[data-route="' + route + '"]\');const k=fs.querySelector(\'[data-f="kind"]\');k.value="codex";k.dispatchEvent(new Event("change"));const m=fs.querySelector(\'[data-f="model"]\');m.value="gpt-6-luna";m.dispatchEvent(new Event("change"));fs.querySelector(\'[data-f="effort"]\').value="low";})()');
    await click('.wp-settings [data-x="save"]'); await until('saved', async () => /主力 GPT-6 Luna · 低/.test(await text('.wp-strip')));
    result.checks.push('点「无线」：副标题写明「主干前进但没冲突时自动并入新主干」；状态条「审查与合入」写明「主干前进没冲突就并入新主干，有冲突才退回返工」');

    // 1. 立即检查：PR #41 合入（合入期间暂缓派新任务）→ 假脚本按 B 档退回审查；合完后新提案派发，先做初审。
    await check();
    const back = await until('merge back to review', async () => { const t = await text('[data-sec="recent"]'); return /自动回到审查/.test(t) && t; }, 60000);
    assert.match(back, /native\.py/);
    const impl = await until('implement working', () => job(j => j.type === 'implement' && j.proposalId === NEW && j.state === 'working'), 120000);
    assert.equal(impl.phase, 'precheck', '新提案先初审');
    await shot('01-b-tier-back-to-review-and-precheck-dispatch');
    result.checks.push('点「立即检查」：已批准的 PR #41 合入时假脚本判 B 档，「最近结果」记「主干在审查后又改到 native.py，已自动回到审查：换模型重审合并结果，批准保留」（不弹通知）；合完后新提案派发，任务标「初审中」');
    await stop(impl.sessionId);

    // 2. 再检查：PR #41 自动开「审查」会话，提示词写明自动重审与 --trunk。
    await check();
    const review = await until('rereview working', () => job(j => j.type === 'review' && j.pr === 41 && j.state === 'working'), 120000);
    assert.ok(review.id.includes(TRUNK.slice(0, 12)), '重审是新一轮');
    const sessions = await cdp.eval('(async()=>(await require("electron").ipcRenderer.invoke("get-sessions")).filter(x=>x.purpose==="wireless-proposal").map(x=>({id:x.id,title:x.title})))()');
    assert.ok(sessions.some(s => s.id === review.sessionId && /^无线 · 审查 · E2E 演练：B 档/.test(s.title)));
    result.checks.push('再点「立即检查」：PR #41 自动新开「审查」会话（新一轮，不被上一轮记录挡住），人不用再点批准');
    await stop(review.sessionId);

    // 3. 假协作台：重审通过、回到已批准（审的是新主干）→ 再检查：按新一轮合入，标已合入。
    fake.tasks(t => Object.assign(t[41], { state: 'approved', reviewed_trunk: TRUNK, rereview: '' }));
    await check();
    const merged = await until('merged', async () => { const t = await text('[data-sec="recent"]'); return /已合入 develop（e2700000）/.test(t) && t; }, 60000);
    assert.ok(merged);
    await shot('02-rereview-then-merged');
    result.checks.push('假协作台回到「已批准」（审查记录写明审的是新主干）后点「立即检查」：按新一轮合入，标「已合入 develop」');

    // 4. 初审：会话写好计划（要改 native.py）后停下；PR #17 正在改 native.py（红档物理文件）→ 等待，可一键直接开始。
    fake.proposals(p => Object.assign(p[NEW], { state: 'implementing', executor: impl.slot,
      plan: '实施范围：演练\n\n### 预计改动\n- src/superran/channel/native.py: _small_scale_channel\n' }));
    await check();
    const waiting = await until('waiting', () => job(j => j.id === impl.id && j.phase === 'waiting'), 60000);
    assert.equal(waiting.waitFor.label, 'PR #17');
    const active = await text('[data-sec="active"]');
    assert.match(active, /等 PR #17/); assert.match(active, /不等了，直接开始/); assert.match(active, /初审：等 PR #17 合入或终止/);
    assert.match(fs.readFileSync(fake.calls, 'utf8'), /^inflight$/m, 'Hub 初审读了在途改动');
    await shot('03-precheck-waiting-for-pr17');
    result.checks.push('会话写好计划后停下：计划要改的 native.py 正被 PR #17 修改 → 「正在处理」里显示「等 PR #17」「初审：等 PR #17 合入或终止」和「不等了，直接开始」按钮');
    await click('[data-wp="force:' + impl.id + '"]');
    const going = await until('forced', () => job(j => j.id === impl.id && j.phase === 'implementing'), 60000);
    assert.match(going.note, /你选择不等 PR #17/);
    assert.equal(going.sessionId, impl.sessionId, '在原会话继续');
    await shot('04-forced-start');
    result.checks.push('点「不等了，直接开始」：在原会话发出放行提示，任务标「实现中」（你选择不等 PR #17，直接开始实现）');
    await stop(impl.sessionId);
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
