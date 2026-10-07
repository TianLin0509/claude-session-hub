'use strict';
// AI 编排模式 · 自然语言实测（2026-10-06）：隔离 Hub + 真实 Claude CLI + 真实 UI 输入，不点任何编排按钮。
// 复刻田哥的原场景：3 位队员轮流自我介绍、最后一位汇总成文件；其中一位故意配了不存在的模型，必然故障。
// 看编排员能否自己开工、自己处理故障（重启 / 提醒 / 跳过 / 改计划），需要田哥时用对话问，田哥只在输入框用一句话回复。
//   node tests/e2e-orchestration-natural-live.js
// 编排员默认 Claude Opus 5.5（田哥实际用最强模型当编排员；ORCH_MODEL 可改）；队员用 Haiku。凭据复制到临时目录，结束时删除。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher'), { connectFirstPage } = require('./helpers/cdp-client');

const ORCH_MODEL = process.env.ORCH_MODEL || 'claude-opus-5-5';
const MEMBER_MODEL = 'claude-haiku-4-5-20251001';
const BROKEN_MODEL = 'claude-no-such-model-for-fault-test';
const MAX_MIN = Number(process.env.MAX_MIN || 35);
const ROOT = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'hub-orch-natural-')), DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work');
const ART = path.resolve(__dirname, '..', 'artifacts', 'orchestration-natural', new Date().toISOString().replace(/[:.]/g, '-'));
for (const p of [DATA, WORK, ART]) fs.mkdirSync(p, { recursive: true });
const secrets = [], delay = ms => new Promise(r => setTimeout(r, ms));
const report = { realModel: true, orchestratorModel: ORCH_MODEL, root: ROOT, startedAt: new Date().toISOString(), timeline: [], replies: [], checks: [], problems: [] };
const t0 = Date.now();
const log = (event, extra = {}) => { const row = { min: +((Date.now() - t0) / 60000).toFixed(1), event, ...extra }; report.timeline.push(row); console.log(`[${row.min}m] ${event}${Object.keys(extra).length ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`); fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2)); };

// 只复制 Claude 凭据与 Hub 钩子到临时目录，其他插件与状态行不带。
function profiles() {
  const env = { CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), AI_HUB_WORKSPACE_ROOT: WORK, DEEPSEEK_API_KEY: '', CODEX_HOME: path.join(ROOT, 'codex') };
  const dest = path.join(ROOT, 'claude'); fs.mkdirSync(dest, { recursive: true }); env.CLAUDE_CONFIG_DIR = dest;
  for (const name of ['.credentials.json', 'settings.json']) { const from = path.join(os.homedir(), '.claude', name), to = path.join(dest, name); if (fs.existsSync(from)) { fs.copyFileSync(from, to); secrets.push(to); } }
  const state = path.join(os.homedir(), '.claude.json'); if (fs.existsSync(state)) { const to = path.join(dest, '.claude.json'); fs.copyFileSync(state, to); secrets.push(to); }
  const settings = path.join(dest, 'settings.json');
  if (fs.existsSync(settings)) {
    const s = JSON.parse(fs.readFileSync(settings, 'utf8')), hooks = {};
    for (const [event, groups] of Object.entries(s.hooks || {})) {
      const kept = (groups || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => /session-hub-hook/.test(h.command || '')) })).filter(g => g.hooks.length);
      if (kept.length) hooks[event] = kept;
    }
    s.hooks = hooks; delete s.enabledPlugins; delete s.statusLine; fs.writeFileSync(settings, JSON.stringify(s), 'utf8');
  }
  return env;
}
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  let hub, cdp, meetingId = '';
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const ledger = () => read(path.join(DATA, 'task-docs', meetingId || '-', 'orchestration', 'ledger.json'));
  const run = () => read(path.join(DATA, 'task-docs', meetingId || '-', 'deliveries', 'run.json'));
  const invoke = (ch, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
  const shot = async name => { try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(r.data, 'base64')); } catch (e) { report.problems.push('screenshot ' + name + ': ' + e.message); } };
  const wait = async (label, pred, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await pred(); if (v) return v; } catch {} await delay(1000); } throw Error('Timeout: ' + label); };
  const send = async text => {
    const p = await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const reply = async (text, why) => { await send(text); report.replies.push({ min: +((Date.now() - t0) / 60000).toFixed(1), text, why }); log('田哥回复', { text, why }); };
  const orchestratorSays = async () => {
    const m = (await invoke('get-meetings')).find(x => x.id === meetingId);
    const tail = await invoke('debug:get-session-buffer', m.orchestration.sessionId).catch(() => '');
    return String(tail || '').slice(-1500);
  };
  try {
    const env = profiles();
    fs.writeFileSync(path.join(DATA, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
    fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label: 'orch-natural', extraEnv: env });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom && typeof selectMeeting === "function"'), 90000);
    log('isolated Hub launched', { pid: hub.pid });
    const room = await invoke('create-meeting', { mode: 'general', scene: 'general', groupChat: true, title: '编排自然语言实测', workspace: WORK,
      slots: [{ index: 0, kind: 'claude', model: ORCH_MODEL, mcpProfile: 'lean' }, { index: 1, kind: 'claude', model: MEMBER_MODEL, mcpProfile: 'lean' },
        { index: 2, kind: 'claude', model: BROKEN_MODEL, mcpProfile: 'lean' }, { index: 3, kind: 'claude', model: MEMBER_MODEL, mcpProfile: 'lean' }],
      participants: [0], orchestration: { enabled: true, settings: { roundCap: 8, timeCapMin: 60, stuckMin: 8 } } });
    if (!room?.id) throw Error('create-meeting failed: ' + JSON.stringify(room));
    meetingId = report.meetingId = room.id;
    await cdp.eval(`selectMeeting(${JSON.stringify(meetingId)})`);
    await wait('orchestration strip', () => cdp.eval("!!document.querySelector('.mr-orch-strip')"));
    await shot('00-room');
    await delay(8000);
    await send('我想测试一下编排群聊：让 3 个 AI 队员轮流用两三句话介绍自己（名字、擅长什么），最后一位把三人的介绍汇总成 summary.md 交付给我。');
    log('goal sent via input box');

    const deadline = Date.now() + MAX_MIN * 60000;
    let last = '', idleSince = Date.now(), nudges = 0, sawAwaiting = false;
    while (Date.now() < deadline) {
      const l = ledger(), r = run();
      if (!l) { await delay(3000); continue; }
      if (l.status === 'awaiting_confirm') sawAwaiting = true;
      const key = JSON.stringify([l.status, l.halt?.reason, l.plan?.version, l.segments.map(s => [s.name, s.status, s.rounds]), r?.status, r?.steps?.length, l.events.length]);
      if (key !== last) {
        last = key; idleSince = Date.now();
        log('state', { status: l.status, halt: l.halt?.reason || null, plan: l.plan?.version || 0, rounds: `${l.budget.roundsUsed}/${l.budget.roundCap}`,
          segments: l.segments.map(s => `${s.name}:${s.status}`), run: r ? `${r.status}:${r.steps?.length}:${r.error || ''}` : null, event: l.events.at(-1)?.text });
        await shot('state-' + report.timeline.length);
      }
      const view = (await invoke('orchestration:view', { meetingId }))?.view;
      if (l.status === 'finished') { log('finished'); break; }
      if (l.status === 'halted' && !view?.orchestratorBusy && Date.now() - idleSince > 20000 && report.replies.length < 4) {
        const budget = /^budget_/.test(l.halt?.reason || '');
        await reply(budget ? '可以，再给 3 轮。' : '按你推荐的办：有故障的队员直接跳过，其他人继续。', 'halted:' + l.halt?.reason);
        idleSince = Date.now();
      } else if (l.status !== 'halted' && !view?.orchestratorBusy && !(r && !['done', 'cancelled'].includes(r.status)) && Date.now() - idleSince > 150000 && nudges < 2) {
        // 编排员停下来用对话问了问题但没有暂停：田哥照常用一句话回答。
        nudges += 1;
        report.orchestratorTailBeforeNudge = await orchestratorSays();
        await reply('可以，按你推荐的来，直接继续。', 'orchestrator idle without running work');
        idleSince = Date.now();
      }
      await delay(3000);
    }
    const l = ledger();
    report.ledgerEvents = l?.events?.map(e => e.text);
    report.reports = l?.reports;
    const events = (l?.events || []).map(e => e.text).join('\n');
    const check = (label, ok) => { report.checks.push({ label, ok: !!ok }); log((ok ? 'PASS ' : 'FAIL ') + label); };
    check('从未出现「计划待确认」状态，全程没点编排按钮', !sawAwaiting);
    check('编排员自行开工（有工作段启动）', (l?.segments || []).length > 0);
    check('结项', l?.status === 'finished');
    check('故障处理：编排员用了重启/跳过/改计划之一', /重启|唤醒|跳过|提交计划 v[2-9]|已取消/.test(events));
    check('田哥只用输入框回复（次数 ≤ 3）', report.replies.length <= 3);
    const summary = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/summary\.md$/i.test(e.name) || /汇总/.test(e.name)) summary.push(p); } };
    for (const dir of [WORK, path.join(DATA, 'task-docs', meetingId)]) if (fs.existsSync(dir)) walk(dir);
    report.summaryFiles = summary;
    await shot('99-end');
  } catch (e) { report.problems.push(e.stack); console.error(e.stack); if (cdp) await shot('fatal').catch(() => {}); }
  finally {
    try { if (meetingId) fs.cpSync(path.join(DATA, 'task-docs', meetingId), path.join(ART, 'task-docs'), { recursive: true }); } catch {}
    if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(e => report.problems.push('quit: ' + e.message));
    for (const s of secrets) fs.rmSync(s, { force: true });
    report.credentialsRemoved = secrets.every(s => !fs.existsSync(s));
    report.end = new Date().toISOString();
    fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));
    console.log('ARTIFACT ' + ART);
    process.exitCode = !report.problems.length && report.checks.length && report.checks.every(c => c.ok) ? 0 : 1;
  }
})();
