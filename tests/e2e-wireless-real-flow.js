'use strict';
// 无线 Tab · SuperRAN 助理「真实流程」演练（长测，约 30–70 分钟，不进单元测试闸门）。
// 隔离 Hub + 假协作台（tests/fixtures/wireless-fake-portal，命令与真实接入包一致）+ 迷你无线仓库（3 个真实 bug）
// + 真实 Codex 会话（默认配置 GPT-6 Astra · max · 标准速度）。全程不点「立即检查」，看助理自己轮询：
//   T0 只有提案 A 已推进 → 助理自动发现并开会话实现；
//   随后模拟组员在协作台推进 B、C → 下一轮自动发现：B 开会话，C 排队（同时最多 2 个）；
//   A 或 B 交付后 → C 自动接上；最后核对 3 个 PR 的代码真的修好了红灯测试且回归全过。
// 会话在 Hub 会话栏与无线页都可见。前后核对本机真实 SuperRAN 登记文件与 Codex 登录文件未被改动。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const FIX = path.join(__dirname, 'fixtures', 'wireless-fake-portal');
const PY = process.env.HUB_E2E_PYTHON || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const LIMIT_MIN = Number(process.env.WIRELESS_FLOW_MINUTES || 80);

const RED = {
  A: { id: 'a1a1a1a1a1a1a1a1', title: 'HARQ：尾包首传失败后，下一个可用下行时隙就该重传', module: 'harq',
    human: '尾包首传失败后，即使缓存里已经没有新数据，下一个可用下行时隙也应该发重传，而不是什么都不发。',
    code: 'from radio.harq import next_transmission\n\n\ndef test_tail_packet_retx_not_blocked_by_empty_buffer():\n    # 尾包首传失败：缓存已空（0 字节新数据），但有到期的 HARQ 重传\n    assert next_transmission(0, True) == "retx"\n',
    fail: 'AssertionError: assert None == \'retx\'', check: 'from radio.harq import next_transmission as f; assert f(0, True) == "retx"' },
  B: { id: 'b2b2b2b2b2b2b2b2', title: 'AMC：CQI 0 表示超出范围，不应映射到 MCS 0 去调度', module: 'amc',
    human: 'UE 上报 CQI 0（信道太差、超出范围）时不应调度，cqi_to_mcs(0) 应返回 None，而不是 MCS 0。',
    code: 'from radio.amc import cqi_to_mcs\n\n\ndef test_cqi_zero_is_out_of_range():\n    # 38.214 表 5.2.2.1-2：CQI 0 = out of range\n    assert cqi_to_mcs(0) is None\n',
    fail: 'AssertionError: assert 0 is None', check: 'from radio.amc import cqi_to_mcs as f; assert f(0) is None and f(1) == 0 and f(15) == 28' },
  C: { id: 'c3c3c3c3c3c3c3c3', title: 'MIMO：2T4R 的秩上限被截成 1，体验速率与 1T4R 相同', module: 'mimo',
    human: '同样的场景下，2T4R 的体验速率应高于 1T4R。',
    code: 'from radio.mimo import max_rank, user_rate_mbps\n\n\ndef test_2t4r_beats_1t4r():\n    assert max_rank(2, 4) == 2\n    assert user_rate_mbps(2, 4, 20) > user_rate_mbps(1, 4, 20)\n',
    fail: 'assert 1 == 2', check: 'from radio.mimo import max_rank, user_rate_mbps as r; assert max_rank(2,4) == 2 and max_rank(1,4) == 1 and r(2,4,20) > r(1,4,20)' },
};

function markdown(p) {
  return ['📌 **' + p.title + '**', '', '## 给人看：算法原理与实际影响', p.human, '', '修好后应看到的现象：' + p.human, '',
    '## 给 Agent 看：实施与验收', '- 实现位置：`src/radio/' + p.module + '.py`', '- 验收：红灯测试变绿，`python -m pytest -q` 全部通过。', '',
    '### 红灯测试', '人话：' + p.human, '', '新增测试（并入 `tests/test_physics_invariants.py`）：', '```python', p.code, '```', '',
    '运行：`python -m pytest -q tests/test_physics_invariants.py`', '', '基线失败输出：', '```text', p.fail, '```'].join('\n');
}

function setup(root) {
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'e2e0000000000000');
  const origin = path.join(root, 'origin.git'), repo = path.join(root, 'SuperRAN-sim'), seed = path.join(root, 'seed');
  fs.mkdirSync(kit, { recursive: true }); fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  for (const f of fs.readdirSync(path.join(FIX, 'kit'))) fs.copyFileSync(path.join(FIX, 'kit', f), path.join(kit, f));
  fs.writeFileSync(path.join(kit, 'superran-proposals.json'), j({ role: 'executor', note: 'E2E 假协作台' }));
  fs.writeFileSync(path.join(kit, 'superran-team.json'), j({ note: 'E2E 假协作台' }));
  fs.writeFileSync(path.join(kit, 'MEMBERS.md'), '# 成员\n\nlintian-admin（林田）\n'); fs.writeFileSync(path.join(kit, 'TASKS.md'), '# 任务\n\n（演练无任务）\n');
  fs.writeFileSync(path.join(kit, 'kit.json'), j({ user: 'lintian-admin', url: 'https://ai.lt-stockpartner.tech/superran-dev', expires: Math.floor(Date.now() / 1000) + 86400 * 25 }));
  const now = Date.now() / 1000;
  const state = { prs: [], proposals: Object.values(RED).map((p, i) => ({ id: p.id, title: p.title, author: 'member:演练组员' + (i + 1), state: i === 0 ? 'accepted' : 'submitted',
    executor: '', executor_member: '', content_revision: 1, content_sha: p.id.repeat(4), result: '', note: '', outcome: '', pr_number: null, revision: 1,
    markdown: markdown(p), spec: markdown(p), plan: '', comments: [], created: now, updated: now })) };
  fs.writeFileSync(path.join(kit, 'state.json'), j(state, null, 1));
  // 迷你仓库：origin 裸仓库 + 本机主仓（develop）。
  fs.cpSync(path.join(FIX, 'repo'), seed, { recursive: true });
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(seed, 'init', '-q', '-b', 'develop'); git(seed, 'add', '-A'); git(seed, '-c', 'user.name=e2e', '-c', 'user.email=e2e@local', 'commit', '-q', '-m', 'radio sim baseline');
  git(root, 'clone', '-q', '--bare', seed, origin); git(root, 'clone', '-q', '-b', 'develop', origin, repo);
  fs.writeFileSync(path.join(home, '.config', 'superran', 'local-installation.json'), j({ root: repo, python: PY, executor_config: path.join(kit, 'superran-proposals.json'), executor_user: 'lintian-admin', development_config: path.join(kit, 'superran-team.json') }));
  return { home, kit, origin, repo, stateFile: path.join(kit, 'state.json') };
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'wireless-flow-')), data = path.join(root, 'data');
  const out = path.resolve('artifacts/wireless-real-flow', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now(), at = () => Math.round((Date.now() - t0) / 1000) + 's';
  const timeline = [], log = (msg) => { const line = '[' + at() + '] ' + msg; timeline.push(line); console.log(line); fs.writeFileSync(path.join(out, 'timeline.txt'), timeline.join('\n')); };
  const result = { passed: false, scope: '隔离 Hub + 假协作台 + 迷你无线仓库 + 真实 Codex（GPT-6 Astra · max · 标准速度）；全程不点「立即检查」', root, out, checks: [], timeline };
  const env = setup(root);
  const realRegistry = path.join(os.homedir(), '.config', 'superran', 'local-installation.json');
  const registryBefore = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
  // Codex 登录复制进测试目录（隔离 Hub 不允许直接用真实账号目录），工作目录标为受信任。
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const prov = cfg.providers?.codex || {}, profile = (prov.subscription_profiles || []).find(p => p.id === prov.subscription_profile) || { id: 'default', label: '主账号', home: '' };
  const codexAuth = path.join(profile.home || path.join(os.homedir(), '.codex'), 'auth.json'), codexHome = path.join(root, 'codex'), workspaces = path.join(root, 'workspaces');
  const authBefore = fs.readFileSync(codexAuth);
  for (const d of [codexHome, data, workspaces]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(codexAuth, path.join(codexHome, 'auth.json'));
  const models = path.join(path.dirname(codexAuth), 'models_cache.json'); if (fs.existsSync(models)) fs.copyFileSync(models, path.join(codexHome, 'models_cache.json'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [env.repo, root, workspaces].map(p => "[projects.'" + p.toLowerCase() + "']\ntrust_level = \"trusted\"").join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'config.json'), j({ providers: { codex: { backend: 'subscription', subscription_profile: profile.id, subscription_profiles: [{ id: profile.id, label: profile.label, home: codexHome }] } } }));
  const readState = () => JSON.parse(fs.readFileSync(env.stateFile, 'utf8'));
  // 与假协作台脚本同一把锁（state.lock），模拟组员在网页上推进。
  const lockFile = path.join(env.kit, 'state.lock'), sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const writeState = fn => { let got = false; for (let i = 0; i < 200 && !got; i++) { try { fs.writeFileSync(lockFile, '', { flag: 'wx' }); got = true; } catch { sleep(50); } }
    if (!got) throw Error('假协作台一直被占用');
    try { const s = readState(); fn(s); fs.writeFileSync(env.stateFile, j(s, null, 1)); } finally { fs.unlinkSync(lockFile); } };
  let hub, cdp;
  const until = async (label, read, timeout = 30000, every = 1000) => { for (const end = Date.now() + timeout; Date.now() < end;) { const v = await read(); if (v) return v; await wait(every); } throw Error('timeout ' + label); };
  const click = async selector => { await until('clickable ' + selector, () => cdp.eval('(()=>{const e=document.querySelector(' + j(selector) + ');if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'), 20000, 300); const p = await cdp.eval('(()=>{const r=document.querySelector(' + j(selector) + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()'); for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); log('截图 ' + name + '.png'); };
  const status = () => cdp.eval('require("electron").ipcRenderer.invoke("wireless:status")');
  const jobsBy = async () => { const s = await status(); const m = {}; for (const [k, p] of Object.entries(RED)) m[k] = s.jobs.find(x => x.proposalId === p.id) || null; return { s, m }; };
  const sessions = () => cdp.eval('(async()=>(await require("electron").ipcRenderer.invoke("get-sessions")).filter(x=>x.purpose==="wireless-proposal").map(x=>({id:x.id,title:x.title,kind:x.kind,model:x.currentModel?.id||x.model||null,effort:x.effort||x.currentEffort||null,speed:x.codexSpeedTier||null,status:x.status})))()');
  const openWireless = async () => { if (!(await cdp.eval('!!document.querySelector("#wireless-page:not([hidden])")'))) { await click('#btn-wireless'); await until('wireless page', () => cdp.eval('!!document.querySelector("#wireless-page:not([hidden])")'), 10000, 300); } };
  const sidebarShot = async name => { await click('#btn-home'); await wait(1200); const titles = await cdp.eval('[...document.querySelectorAll("#session-sidebar *")].filter(e=>e.children.length===0&&/^无线 · /.test(e.textContent.trim())).map(e=>e.textContent.trim())'); await shot(name); await openWireless(); return titles; };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'wireless-real-flow', allowExternalState: true,
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'hubhome'), CLAUDE_HUB_WIRELESS_HOME: env.home, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
        HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '', CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '',
        AI_HUB_WORKSPACE_ROOT: workspaces, HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty') } });
    cdp = await connectFirstPage(hub); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => cdp.eval('typeof window.__wirelessHide==="function"'), 60000, 300);
    log('隔离 Hub 已启动；协作台上：A 已推进，B、C 待推进');
    if (await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await click('#btn-toggle-navigation');
    // 测试加速：检查间隔从 10 分钟调到 2 分钟（产品允许的最小值）。其余保持默认。
    const set = await cdp.eval('require("electron").ipcRenderer.invoke("wireless:set-settings",{pollMinutes:2})');
    assert.equal(set.ok, true); assert.deepEqual([set.settings.primary.model, set.settings.primary.effort, set.settings.primary.speed, set.settings.maxParallel], ['gpt-6-astra', 'max', 'standard', 2]);
    log('检查间隔设为 2 分钟（仅为测试加速）；主力 GPT-6 Astra · max · 标准速度，同时 2 个');
    await openWireless();
    // 1. 不点「立即检查」：助理自己首轮检查（Hub 启动约 15 秒后）发现 A 并开会话。
    const a = await until('A dispatched', async () => { const { m } = await jobsBy(); return m.A && ['working', 'dispatching'].includes(m.A.state) && m.A; }, 4 * 60000, 2000);
    log('助理自己发现已推进的 A，开会话 ' + a.sessionId.slice(0, 8) + '（' + a.model + ' · ' + a.effort + '）');
    assert.equal(a.model, 'gpt-6-astra'); assert.equal(a.effort, 'max'); assert.equal(a.kind, 'codex');
    await until('A confirmed', async () => { const { m } = await jobsBy(); return /已交给 Agent/.test(m.A.note || ''); }, 3 * 60000, 2000);
    log('A 的执行提示词已确认送达');
    await shot('01-auto-detect-A');
    result.sidebarAfterA = await sidebarShot('02-sidebar-A');
    assert.ok(result.sidebarAfterA.some(t => t.includes('HARQ')), '会话栏能看到 A 的会话');
    result.checks.push('不点任何按钮：Hub 启动后助理首轮自动检查，发现已推进的 A，新开 Codex 会话（GPT-6 Astra · max）并确认提示词送达；会话栏与无线页都能看到');
    // 2. 模拟组员在协作台推进 B、C。
    await wait(20000);
    writeState(s => { for (const p of s.proposals) if (p.id !== RED.A.id) { p.state = 'accepted'; p.decision = { actor: 'member:演练组员9', at: Date.now() / 1000, note: '推进' }; p.revision += 1; } });
    log('模拟组员在协作台推进 B、C');
    const bc = await until('B/C detected', async () => { const { m } = await jobsBy(); return m.B && m.C && [m.B, m.C]; }, 4 * 60000, 2000);
    const { m: m2, s: s2 } = await jobsBy();
    const running = Object.entries(m2).filter(([, x]) => x && ['working', 'dispatching'].includes(x.state)).map(([k]) => k);
    const queued = Object.entries(m2).filter(([, x]) => x && x.state === 'queued').map(([k]) => k);
    log('助理下一轮自动发现 B、C：正在处理 ' + running.join('、') + '，排队 ' + queued.join('、'));
    assert.equal(running.length, 2, '同时最多 2 个'); assert.equal(queued.length, 1, '第 3 个排队');
    assert.deepEqual(queued, ['C'], '同一轮发现的 B、C 按协作台列表顺序：B 先做，C 排队');
    const ui = await until('页面及时刷新', async () => { const t = await cdp.eval('document.querySelector(".wp-body")?.innerText||""'); return /正在处理（2\/2）/.test(t) && /排队（1）/.test(t) && t; }, 5000, 300);
    assert.match(ui, /MIMO/);
    result.afterBC = { running, queued, lastPoll: s2.last };
    await shot('03-two-running-one-queued');
    result.checks.push('组员推进 B、C 后，助理下一轮自动发现：' + running.join('、') + ' 同时处理，' + queued.join('、') + ' 排队（同时最多 2 个）');
    // 3. 等某个交付 → 排队的自动接上。
    const third = queued[0];
    const firstDone = await until('first delivery', async () => { const st = readState(); const d = st.proposals.find(p => p.state === 'reported'); return d && Object.keys(RED).find(k => RED[k].id === d.id); }, LIMIT_MIN * 60000, 10000);
    log('提案 ' + firstDone + ' 已在协作台回传交付报告');
    await until('third dispatched', async () => { const { m } = await jobsBy(); return ['working', 'dispatching'].includes(m[third].state); }, 6 * 60000, 3000);
    const { m: m3 } = await jobsBy();
    log('排队的 ' + third + ' 自动接上，开会话 ' + m3[third].sessionId.slice(0, 8));
    await shot('04-queued-starts');
    result.checks.push(firstDone + ' 交付后，排队的 ' + third + ' 自动开会话接上');
    // 4. 等全部交付。
    await until('all reported', async () => readState().proposals.every(p => p.state === 'reported'), LIMIT_MIN * 60000, 15000);
    log('3 份提案都已回传');
    await until('ui done', async () => { const { m } = await jobsBy(); return Object.values(m).every(x => ['done', 'released'].includes(x.state)); }, 5 * 60000, 5000);
    await shot('05-all-done');
    result.sidebarFinal = await sidebarShot('06-sidebar-final');
    result.sessions = await sessions();
    // 5. 核对代码：每个 PR 分支在干净副本里红灯变绿、回归全过。
    const st = readState(); result.prs = st.prs; result.proposals = {};
    for (const [k, p] of Object.entries(RED)) {
      const row = st.proposals.find(x => x.id === p.id), pr = st.prs.find(x => x.number === row.pr_number);
      const info = { state: row.state, outcome: row.outcome, pr: row.pr_number, executor: row.executor, reportHasRedTest: /### 红灯测试/.test(row.result || ''), reportHead: String(row.result || '').split('\n')[0] };
      if (pr) {
        const check = path.join(root, 'verify-' + k);
        execFileSync('git', ['clone', '-q', '-b', pr.branch, env.origin, check]);
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: check, encoding: 'utf8' }).trim();
        const pyenv = { ...process.env, PYTHONPATH: path.join(check, 'src'), PYTHONDONTWRITEBYTECODE: '1' };
        let red = 'pass', suite = '';
        try { execFileSync(PY, ['-c', p.check], { cwd: check, env: pyenv, stdio: 'pipe' }); } catch (e) { red = 'FAIL ' + String(e.stderr).slice(-200); }
        try { suite = execFileSync(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], { cwd: check, env: pyenv, encoding: 'utf8' }).trim().split('\n').pop(); } catch (e) { suite = 'FAIL ' + String(e.stdout).slice(-300); }
        Object.assign(info, { branch: pr.branch, head, prHeadMatches: head === pr.head, redTest: red, suite, files: execFileSync('git', ['diff', '--stat', 'origin/develop...HEAD'], { cwd: check, encoding: 'utf8' }).trim() });
      }
      result.proposals[k] = info;
      log(k + '：' + info.state + ' / ' + info.outcome + ' / PR #' + info.pr + ' / 红灯测试 ' + info.redTest + ' / 回归 ' + info.suite);
    }
    for (const [k, info] of Object.entries(result.proposals)) {
      assert.equal(info.state, 'reported', k + ' 已回传'); assert.equal(info.outcome, 'modified', k + ' 已修改');
      assert.equal(info.redTest, 'pass', k + ' 红灯测试在候选上变绿'); assert.match(info.suite, /passed/, k + ' 回归通过'); assert.doesNotMatch(info.suite, /failed|FAIL/, k + ' 回归无失败');
      assert.ok(info.reportHasRedTest, k + ' 报告有红灯测试一节');
    }
    assert.equal(result.sessions.length, 3, '3 个提案 3 个会话');
    for (const s of result.sessions) { assert.equal(s.kind, 'codex'); assert.equal(s.model, 'gpt-6-astra'); }
    assert.equal(result.sidebarFinal.length, 3, '会话栏里 3 个无线会话');
    result.checks.push('3 份提案各自一个会话，都提交了候选 PR 并回传报告；在干净副本里逐个核对：红灯测试变绿、回归全过');
    result.passed = true;
  } catch (e) { result.error = e.stack; process.exitCode = 1; if (cdp) await shot('failure').catch(() => {}); log('失败：' + e.message); }
  finally {
    if (cdp) cdp.close();
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); try { await gracefulQuit(hub); } catch (e) { result.cleanupError = e.message; } }
    try { fs.copyFileSync(env.stateFile, path.join(out, 'fake-portal-state.json')); } catch {}
    const registryAfter = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
    result.realRegistryUnchanged = registryAfter === registryBefore;
    result.realCodexAuthUnchanged = Buffer.compare(fs.readFileSync(codexAuth), authBefore) === 0;
    if (!result.realRegistryUnchanged || !result.realCodexAuthUnchanged) { result.passed = false; process.exitCode = 1; }
    result.minutes = Math.round((Date.now() - t0) / 60000);
    fs.writeFileSync(path.join(out, 'result.json'), j(result, null, 1)); console.log(j(result, null, 1));
  }
}
main();
