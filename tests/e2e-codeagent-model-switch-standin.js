'use strict';
// 真实验收（替身）：CodeAgent 选模型走它自己的 /model 菜单（2026-10-14 同事反馈：选了 MiniMax 启动后仍是 GLM，
// 输入框下方换模型也无效；公司真机确认交互模式不认 --model）。
// 替身 tests/fixtures/codeagent-standin 启动真 Claude Code，并用 CODEAGENT_STANDIN_IGNORE_MODEL=1 复现那个毛病：
// 交互模式丢掉 --model，永远从配置里的默认模型（这里设成 sonnet，相当于公司的 GLM）开局。
// 菜单里是 Claude 的模型名，用 AI_HUB_CODEAGENT_PICKER_LABELS 对应：MiniMax-M2.7 → Haiku，GLM-5.2-WX-Auto → Sonnet。
//   ① 新建会话选 MiniMax-M2.7，不等就绪马上发第一条（记暗号）：第一条要等 Hub 在菜单里选好，回答用的是 Haiku；
//   ② CLI 的默认模型没被改掉（菜单有「s 只用于本会话」时按 s）；
//   ③ 点输入框下方的模型 → 菜单写明「在 /model 菜单里替你选中」→ 选 GLM-5.2-WX-Auto：
//      不重开 CLI（会话号不变），下一条回答用的是 Sonnet，并且答出暗号（对话没断）；
//   ④ 数据目录 logs\codeagent-model.log 里有两次 event=pick ok=true。
// 凭据复制进临时目录，finally 删除。E2E_ENTRY 指向公司版导出目录时测公司版。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const SECRET = '蓝鲸-4271';

// 原生记录里每条回答实际用的模型（替身 = 真 Claude Code 落盘格式）。
function answerModels(cac) {
  const out = [];
  const root = path.join(cac, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(root, d, f), 'utf8').split('\n')) {
        try { const o = JSON.parse(line); if (o.type === 'assistant' && o.message && o.message.model && o.message.model !== '<synthetic>') out.push({ at: Date.parse(o.timestamp), model: o.message.model, file: f }); } catch {}
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-switch-'));
  const out = path.resolve(process.env.E2E_OUT || 'artifacts/20261014-codeagent-model-picker-claude1'); fs.mkdirSync(out, { recursive: true });
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), cwd = path.join(root, 'workspace');
  for (const d of [cac, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const result = { company: !!process.env.E2E_ENTRY, checks: [], passed: false };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch (_) {} await sleep(300); } throw Error('timeout: ' + label); };
  const waitFor = async (fn, label, ms = 240000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  const chip = `[...document.querySelectorAll('.composer-model')].find(e=>!e.hidden&&e.offsetParent)`;
  const settingsModel = () => { try { return JSON.parse(fs.readFileSync(path.join(cac, 'settings.json'), 'utf8')).model; } catch { return null; } };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    // CLI 自己的默认模型：sonnet（相当于公司电脑上的 GLM-5.2-WX-Auto）
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'sonnet', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }, null, 2));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'codeagent model picker',
      ...(process.env.E2E_ENTRY ? { entryPath: process.env.E2E_ENTRY } : {}), extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CODEAGENT_STANDIN_IGNORE_MODEL: '1',
        AI_HUB_CODEAGENT_PICKER_LABELS: j({ 'MiniMax-M2.7': 'Haiku', 'GLM-5.2-WX-Auto': 'Sonnet' }),
        CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES: j([{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/x.json', files: 'http://127.0.0.1:9/' }]),
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined"', 'renderer');
    result.product = await c.eval(`document.querySelector('#hub-identity strong')?.textContent || ''`);

    // ① 选 MiniMax 新建，马上发第一条
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, model: 'MiniMax-M2.7', effort: 'low', mcpProfile: 'none' } })})`);
    const sid = created.id, q = j(sid);
    await until(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`, 'row', 20000);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card')`);
    const sentAt = Date.now();
    await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: sid, text: `不要调用工具。请记住这个暗号：${SECRET}。只回答“记住了”。` })})`);
    const firstAnswer = await waitFor(() => answerModels(cac).find(a => a.at > sentAt), 'first answer');
    result.firstModel = firstAnswer.model;
    check(/haiku/i.test(firstAnswer.model), `启动时选的 MiniMax（替身里对应 Haiku）生效：第一条就是 ${firstAnswer.model}，不是 CLI 默认的 Sonnet`);
    check(settingsModel() === 'sonnet', 'CodeAgent 自己的默认模型没被改动（settings.json 仍是 sonnet）');
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed'`, 'first completed', 120000);
    const nativeId = await c.eval(`sessions.get(${q}).ccSessionId || ''`);
    await sleep(1500);
    await shot('01-first-answer');

    // ③ 输入框下方换成 GLM（替身里对应 Sonnet）
    await c.eval(`${chip}.setAttribute('data-e2e-chip','1')`);
    await click('[data-e2e-chip="1"]');
    await until(`!!document.querySelector('.model-picker-menu .model-picker-item[data-model-id="GLM-5.2-WX-Auto"]')`, 'menu', 10000);
    const note = await c.eval(`document.querySelector('.model-picker-menu .model-picker-note')?.textContent || ''`);
    check(/\/model 菜单里替你选中/.test(note), '模型菜单写明「在 CodeAgent 的 /model 菜单里替你选中，对话不中断」');
    await shot('02-menu');
    await click('.model-picker-menu .model-picker-item[data-model-id="GLM-5.2-WX-Auto"]');
    await until(`/已在 CodeAgent 里换成/.test(document.querySelector('.model-picker-menu .model-picker-note')?.textContent || '')`, 'switched', 60000);
    await shot('03-switched');
    check(await c.eval(`sessions.get(${q}).ccSessionId === ${j(nativeId)}`), '切换没有重开 CLI，会话号不变');
    check(settingsModel() === 'sonnet', '切换后 CodeAgent 的默认模型仍未被改动');

    const askedAt = Date.now();
    await click('.floating-input-box');
    await c.send('Input.insertText', { text: '不要调用工具。我刚才让你记住的暗号是什么？只回答暗号本身。' });
    await click('.floating-input-send');
    const second = await waitFor(() => answerModels(cac).find(a => a.at > askedAt), 'second answer');
    result.secondModel = second.model;
    check(/sonnet/i.test(second.model), `换模型后下一条回答用的是 ${second.model}`);
    await until(`getSessionRuntimeTruth(sessions.get(${q})).state === 'completed' && [...document.querySelectorAll('#msg-overlay .turn-card.assistant')].pop().innerText.includes('4271')`, 'recall', 120000);
    check(true, '回答里有暗号：对话接着原来的上下文');
    await sleep(1000);
    await shot('04-recall');

    // ④ 记录
    const log = fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8');
    const picks = log.split('\n').filter(l => /event=pick/.test(l));
    result.pickLog = picks;
    check(picks.filter(l => /ok=true/.test(l)).length >= 2 && picks.some(l => /reason=launch/.test(l)) && picks.some(l => /reason=switch/.test(l)),
      `codeagent-model.log 记下启动和切换两次选模型（${picks.map(l => (l.match(/mode=\S+/) || [''])[0]).join(' ')}）`);
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval('document.body.innerText.slice(-1500)'); } catch {} }
    if (hub) { try { result.hubLogTail = hub.log().slice(-60); } catch {} }
  } finally {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
