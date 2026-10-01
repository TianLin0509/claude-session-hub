'use strict';
// REAL models in an isolated Hub: Claude (Haiku by default) + Codex (low tier).
// Measures whether real agents follow the "write your answer to 回答.md" rule,
// and exercises cards, peer context, interruption + in-session rescue, and a
// real delivery workflow. Credentials are copied into a temp profile and
// deleted afterwards. Usage: node tests/e2e-group-answers-live.js [claudeModel] [codexModel]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher'), { connectFirstPage } = require('./helpers/cdp-client');
const CLAUDE_MODEL = process.argv[2] || 'claude-haiku-4-5-20251001', CODEX_MODEL = process.argv[3] || 'gpt-6-astra';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-answers-live-')), DATA = path.join(ROOT, 'data');
const ART = path.resolve(__dirname, '..', 'artifacts', 'group-answers-live', `${CLAUDE_MODEL}__${CODEX_MODEL}`.replace(/[^a-zA-Z0-9_.-]/g, '_'));
fs.mkdirSync(ART, { recursive: true });
const secrets = [], delay = ms => new Promise(r => setTimeout(r, ms));
const TERMINAL = ['completed', 'errored', 'interrupted', 'superseded', 'handed_off', 'manual_extracted', 'failed'];

function profiles() {
  const env = { CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), AI_HUB_WORKSPACE_ROOT: ROOT, DEEPSEEK_API_KEY: '' };
  for (const [key, source, names] of [['CODEX_HOME', '.codex', ['auth.json', 'config.toml', 'models_cache.json']], ['CLAUDE_CONFIG_DIR', '.claude', ['.credentials.json', 'settings.json']]]) {
    const dest = path.join(ROOT, source.slice(1)); fs.mkdirSync(dest, { recursive: true }); env[key] = dest;
    for (const name of names) { const original = path.join(os.homedir(), source, name), target = path.join(dest, name); if (fs.existsSync(original)) { fs.copyFileSync(original, target); secrets.push(target); } }
  }
  const state = path.join(os.homedir(), '.claude.json'); if (fs.existsSync(state)) { const dest = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'); fs.copyFileSync(state, dest); secrets.push(dest); }
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  if (fs.existsSync(settings)) {
    // Keep only the Hub's own hooks (turn completion etc.); drop personal guards, plugins and status line.
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
  let hub, cdp;
  const report = { realModel: true, claudeModel: CLAUDE_MODEL, codexModel: CODEX_MODEL, root: ROOT, turns: [], rescue: null, delivery: null, problems: [] };
  const invoke = (ch, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
  const wait = async (label, pred, ms = 60000, step = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = await pred(); if (r) return r; await delay(step); } throw Error('Timeout: ' + label); };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(r.data, 'base64')); };
  const send = async text => {
    const p = await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const state = id => invoke('groupchat:get-state', { meetingId: id });
  const cardText = (id, turn, memberId) => cdp.eval(`(()=>{const e=document.querySelector('article[data-gc-msg-id="a${turn}-${memberId}"]');return e?e.querySelector('.mr-gc-bubble').innerText.slice(0,300):null;})()`);
  // A turn is over when every member has a file answer, or every attempt settled + grace.
  // Never throws: a member that never hands in is recorded as non-compliant.
  async function settleTurn(id, turn, sids, maxMs = 240000) {
    let settledAt = 0;
    return wait(`turn ${turn}`, async () => {
      const s = await state(id), files = s.answerFiles?.[turn] || {};
      const answered = sids.filter(sid => s.messages.some(m => m.sid === sid && m.turnNum === turn && m.answer?.state === 'delivered'));
      if (answered.length === sids.length) return s;
      const attempts = Object.values(s.attempts || {}).filter(a => a.turnNum === turn);
      const allSettled = sids.every(sid => attempts.some(a => a.sid === sid && TERMINAL.includes(a.status)));
      if (allSettled && !settledAt) settledAt = Date.now();
      if (settledAt && Date.now() - settledAt > 25000) return s;
      void files; return null;
    }, maxMs, 2000).catch(async () => state(id));
  }
  function snapshot(s, turn, members) {
    return members.map(m => {
      const entry = s.answerFiles?.[turn]?.[m.sid], msg = s.messages.find(x => x.sid === m.sid && x.turnNum === turn && x.role === 'assistant' && !x.sourceMessage);
      const file = entry && fs.existsSync(entry.ready) ? fs.readFileSync(entry.ready, 'utf8') : null;
      const attempt = Object.values(s.attempts || {}).filter(a => a.sid === m.sid && a.turnNum === turn).at(-1);
      return { member: m.memberId, kind: m.kind, fileWritten: !!file, fileChars: file ? file.length : 0, filePreview: file ? file.slice(0, 160) : '', cardState: msg?.answer?.state || 'none',
        cardMatchesFile: !!file && msg?.content?.trim() === file.replace(/^﻿/, '').trim(), attemptStatus: attempt?.status || null };
    });
  }
  try {
    const workspace = path.join(ROOT, 'workspace'); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# 隔离测试工作区\n这是一次群聊协作测试。回答简短，不改代码，不联网，不做额外调研。\n', 'utf8');
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label: 'answers-live', extraEnv: profiles() });
    cdp = await connectFirstPage(hub); report.pid = hub.pid;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom'));

    // ---- Part 1: plain group chat, three real members, several turns.
    const slots = [
      { index: 0, memberId: 'm1', kind: 'claude', model: CLAUDE_MODEL, effort: 'low', fastMode: false, mcpProfile: 'lean' },
      // codexModel 'none' puts Claude in this seat (e.g. when Codex is unavailable).
      CODEX_MODEL === 'none' ? { index: 1, memberId: 'm2', kind: 'claude', model: CLAUDE_MODEL, effort: 'low', fastMode: false, mcpProfile: 'lean' } : { index: 1, memberId: 'm2', kind: 'codex', model: CODEX_MODEL, effort: 'low', mcpProfile: 'lean' },
      { index: 2, memberId: 'm3', kind: 'claude', model: CLAUDE_MODEL, effort: 'low', fastMode: false, mcpProfile: 'lean' },
    ];
    const room = await invoke('create-meeting', { mode: 'group', scene: 'general', groupChat: true, title: '真实模型 · 回答文件', workspace, slots });
    const id = room.id;
    let fresh = (await invoke('get-meetings')).find(x => x.id === id);
    await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`);
    await wait('composer', () => cdp.eval("!!document.querySelector('#mr-input-box')"), 120000);
    const members = slots.map((s, i) => ({ ...s, sid: fresh.subSessions[i] }));
    const sids = members.map(m => m.sid);
    const questions = [
      '每人用一两句话说一个你最推荐初学者学的编程语言，并给一个理由。',
      '看看其他成员推荐了什么语言，用一句话评价其中一位的选择，要点名是谁推荐的哪种语言。',
      '用一个 3 条的 Markdown 列表，给初学者列出学习编程的建议，每条不超过 20 个字。',
    ];
    for (let i = 0; i < questions.length; i++) {
      const turn = i + 1, started = Date.now();
      await send(questions[i]);
      const s = await settleTurn(id, turn, sids);
      const rows = snapshot(s, turn, members);
      for (const r of rows) r.cardText = await cardText(id, turn, r.member);
      report.turns.push({ turn, question: questions[i], seconds: Math.round((Date.now() - started) / 1000), members: rows });
      await shot(`turn-${turn}`);
      console.log(`turn ${turn}: ` + rows.map(r => `${r.member}(${r.kind}) file=${r.fileWritten} card=${r.cardState} match=${r.cardMatchesFile}`).join(' | '));
    }
    // Peer context: turn-2 answers should mention languages others chose in turn 1.
    const t1 = report.turns[0].members, t2 = report.turns[1].members;
    report.peerContext = t2.map(r => ({ member: r.member, mentionsPeer: t1.filter(x => x.member !== r.member && x.fileWritten).some(x => {
      const langs = (x.filePreview.match(/Python|JavaScript|Java|C\+\+|Go|Rust|Scratch|Ruby|C#|TypeScript|Lua|Swift/gi) || []);
      return langs.some(l => r.filePreview.toLowerCase().includes(l.toLowerCase()));
    }) }));

    // ---- Part 2: interrupt one member mid-answer, then rescue in its own session.
    const turn = questions.length + 1;
    await send('最后一轮：每人用一句话总结今天讨论的结论。');
    const victim = members[1];
    await wait('victim working', async () => { const s = await state(id); return Object.values(s.attempts || {}).some(a => a.sid === victim.sid && a.turnNum === turn && ['submitted', 'running', 'accepted', 'started'].includes(a.status)); }, 90000, 500).catch(() => null);
    await delay(1500);
    await cdp.eval(`require('electron').ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(victim.sid)},data:'\\u001b'})`);
    let s = await settleTurn(id, turn, sids, 240000);
    const before = snapshot(s, turn, members).find(r => r.member === victim.memberId);
    report.rescue = { member: victim.memberId, kind: victim.kind, fileBeforeRescue: before.fileWritten };
    if (!before.fileWritten) {
      const target = s.answerFiles?.[turn]?.[victim.sid]?.ready;
      await delay(5000);
      const r = await invoke('session:send-prompt', { sessionId: victim.sid, text: `你刚才在群聊里的回答没有写进文件。请把你本轮要发到群聊的一句话总结写入 ${target}（UTF-8 Markdown），写完回读确认。` });
      report.rescue.sendResult = r && (r.status || r.ok);
      const started = Date.now();
      await wait('rescued card', async () => { const card = await cardText(id, turn, victim.memberId); return card && !card.includes('还没交') ? card : null; }, 240000, 2000)
        .then(card => { report.rescue.cardUpdated = true; report.rescue.seconds = Math.round((Date.now() - started) / 1000); report.rescue.card = card; })
        .catch(() => { report.rescue.cardUpdated = false; });
    } else report.rescue.note = '中断前已写好文件，未触发补救';
    s = await state(id);
    report.turns.push({ turn, question: 'interrupt + rescue', members: snapshot(s, turn, members) });
    await shot('turn-rescue');

    // ---- Part 3: a real delivery workflow (Claude -> Codex).
    const wf = await invoke('create-meeting', { mode: 'group', scene: 'general', groupChat: true, title: '真实模型 · 交付卡片', workspace,
      slots: [slots[0], { ...slots[1], index: 1 }] });
    const draft = { kind: 'serial', presetId: 'custom', enabled: true, rounds: [
      { name: 'Claude 简答', members: ['m1'], prompt: '用两句话解释为什么 1+1=2，写进自己的草稿，回读后原子改名交付。不要调用子代理。', after: 'next' },
      { name: 'Codex 核验', members: ['m2'], prompt: '阅读上一步交付，用两句话核验是否正确，写进自己的草稿，回读后原子改名交付。', after: 'end' }] };
    const cfg = await invoke('workflow:configure', { meetingId: wf.id, draft, expectedRevision: wf.serialWorkflow?.settingsRevision || 0 });
    if (!cfg.ok) throw Error(cfg.reason);
    fresh = (await invoke('get-meetings')).find(x => x.id === wf.id);
    await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(wf.id)},${JSON.stringify(fresh)})`);
    await wait('delivery composer', () => cdp.eval("!!document.querySelector('[data-delivery=files]')"), 120000);
    const wfStart = Date.now();
    await send('简单验证一次交接：Claude 先解释 1+1=2，Codex 再核对。');
    const done = await wait('delivery done', async () => { const st = await invoke('delivery:status', { meetingId: wf.id }); if (st.paused) return { paused: st.error || 'paused' }; return st.done ? st : null; }, 420000, 3000);
    const ws = await state(wf.id);
    report.delivery = { seconds: Math.round((Date.now() - wfStart) / 1000), done: !!done.done, paused: done.paused || null,
      cards: ws.messages.filter(m => m.role === 'assistant' && !m.sourceMessage).map(m => ({ turn: m.turnNum, member: m.memberId, state: m.answer?.state || 'none', outcome: m.answer?.outcome || null, chars: (m.content || '').length })) };
    await shot('delivery');
  } catch (error) {
    report.problems.push(error.stack);
    if (cdp) { try { await shot('failure'); } catch {} }
  } finally {
    if (cdp) await cdp.close();
    if (hub) { report.quit = await gracefulQuit(hub); try { fs.writeFileSync(path.join(ART, 'hub.log'), (hub.log ? hub.log() : []).join(String.fromCharCode(10)), 'utf8'); } catch {} }
    for (const file of secrets) if (fs.existsSync(file)) fs.unlinkSync(file);
    const rows = report.turns.flatMap(t => t.members || []);
    report.compliance = { answers: rows.length, filesWritten: rows.filter(r => r.fileWritten).length, cardsMatched: rows.filter(r => r.cardMatchesFile).length,
      byKind: Object.fromEntries(['claude', 'codex'].map(k => [k, `${rows.filter(r => r.kind === k && r.fileWritten).length}/${rows.filter(r => r.kind === k).length}`])) };
    fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ compliance: report.compliance, peerContext: report.peerContext, rescue: report.rescue, delivery: report.delivery, problems: report.problems.map(p => p.split('\n')[0]) }, null, 2));
    console.log('ARTIFACTS ' + ART);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
