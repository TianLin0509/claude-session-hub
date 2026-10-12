'use strict';
// Antigravity 真机验收：隔离 Hub + 本机官方 agy + 用户自己的 Google 订阅（低档模型），逐项验证
// 新建、卡片、多行中文、原地换模型、原生分支、休眠唤醒、群聊。不进单测运行器，按需手动跑：
//
//   node tests/manual-antigravity-hub-live-cdp.js --agy-template <已完成首启引导的 .gemini 目录> [--steps 01,02]
//
// 模板目录只复制 antigravity-cli 的设置与引导状态（不含对话）；登录在系统钥匙串里，隔离 home 也能用。
// Hub 进程故意不带代理变量，复现「桌面快捷方式启动」的真实环境。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const template = arg('--agy-template');
const onlySteps = arg('--steps') ? new Set(arg('--steps').split(',')) : null;
const agy = process.env.AI_HUB_ANTIGRAVITY_COMMAND || 'D:/DevTools/AntigravityCLI/bin/agy.exe';
const MODEL = 'gemini-3.8-flash-low';
const root = fs.mkdtempSync(path.join(process.env.AI_HUB_E2E_ROOT || os.tmpdir(), 'agy-live-'));
const out = path.join(root, 'report');
const home = path.join(root, 'home');
const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const report = { startedAt: new Date().toISOString(), root, model: MODEL, steps: [] };
const ctx = {};
let hub = null, c = null;

async function step(id, title, fn, needs = []) {
  const entry = { id, title, status: 'running', evidence: [] };
  report.steps.push(entry);
  if (onlySteps && !onlySteps.has(id)) { entry.status = 'skipped'; return print(entry); }
  const missing = needs.filter(n => !ctx[n]);
  if (missing.length) { entry.status = 'skipped'; entry.evidence.push('前置未满足：' + missing.join(',')); return print(entry); }
  const t0 = Date.now();
  try { await fn(note => entry.evidence.push(String(note))); entry.status = 'pass'; }
  catch (error) {
    entry.status = 'fail'; entry.error = String(error && error.stack || error).slice(0, 2000);
    try { if (ctx.focus) entry.evidence.push('失败时终端：\n' + await screenTail(ctx.focus, 25)); } catch {}
  }
  entry.seconds = Math.round((Date.now() - t0) / 100) / 10;
  try { if (c) fs.writeFileSync(path.join(out, id + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch {}
  print(entry);
}
function print(e) { console.log(`[${e.status}] ${e.id} ${e.title}${e.seconds != null ? ` (${e.seconds}s)` : ''}${e.error ? ' — ' + e.error.split('\n')[0] : ''}`); }
async function until(expr, label, ms = 120000) {
  const end = Date.now() + ms; let last = null;
  while (Date.now() < end) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e; } await sleep(400); }
  throw new Error('超时：' + label + (last ? '（' + last.message + '）' : ''));
}
async function screenTail(sid, n = 20) {
  const raw = String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(sid)})`) || '');
  return raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[(\d*)C/g, ' ').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\r/g, '\n').split('\n').filter(l => l.trim()).slice(-n).join('\n');
}
// IPC calls that may legitimately exceed CDP's 30 s evaluate limit.
let invokeSeq = 0;
async function invokeLong(channel, payload, ms = 240000) {
  const key = '__agyInvoke' + (++invokeSeq);
  await c.eval(`(() => { window[${j(key)}] = null; ipcRenderer.invoke(${j(channel)}, ${j(payload)}).then(r => { window[${j(key)}] = { r }; }, e => { window[${j(key)}] = { e: e.message }; }); return true; })()`);
  const box = await until(`window[${j(key)}]`, channel, ms);
  if (box.e) throw new Error(channel + ' 抛错：' + box.e);
  return box.r;
}
const overlay = () => c.eval(`document.querySelector('#msg-overlay')?.innerText || ''`);
async function waitReady(sid, label) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const tail = await screenTail(sid, 40);
    if (/trust the contents of this project|Choose your color scheme|Select login method/i.test(tail)) throw new Error(label + '：agy 停在弹窗上：\n' + tail);
    if (/\? for shortcuts/.test(tail.split('\n').slice(-4).join('\n'))) return;
    await sleep(500);
  }
  throw new Error(label + '：90 秒内没有出现 agy 输入框');
}
async function send(sid, text, expect, label, ms = 180000) {
  await c.eval(`selectSession(${j(sid)})`); await sleep(300); await c.eval(`applyViewMode('card')`);
  const t0 = Date.now();
  const result = await invokeLong('session:send-prompt', { sessionId: sid, text });
  if (!result || result.ok === false || result.sendStatus === 'stuck') throw new Error(label + '：发送未确认 ' + j(result));
  await until(`getSessionRuntimeTruth(sessions.get(${j(sid)})).state === 'completed'`, label + ' 完成状态', ms);
  await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes(${j(expect)})`, label + ' 卡片出现回答', 30000);
  return { seconds: Math.round((Date.now() - t0) / 1000), ack: result.acknowledgementSource, enterAttempts: result.enterAttempts };
}
const info = sid => c.eval(`(() => { const s = sessions.get(${j(sid)}); return s && { kind: s.kind, status: s.status, chat: s.geminiChatId || null, hash: s.geminiProjectHash || null, transcript: s.transcriptPath || null, model: s.currentModel && s.currentModel.id, title: s.title }; })()`);

async function main() {
  if (!template || !fs.existsSync(path.join(template, 'antigravity-cli'))) throw new Error('--agy-template 需指向含 antigravity-cli 的 .gemini 目录');
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['settings.json', 'jetski_state.pbtxt', 'installation_id']) {
    const f = path.join(template, 'antigravity-cli', name); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(target, name));
  }
  // cache/onboarding.json marks the first-run onboarding as done (the user's real home has it).
  const onboarding = path.join(template, 'antigravity-cli', 'cache', 'onboarding.json');
  if (fs.existsSync(onboarding)) { fs.mkdirSync(path.join(target, 'cache'), { recursive: true }); fs.copyFileSync(onboarding, path.join(target, 'cache', 'onboarding.json')); }
  const implicit = path.join(template, 'antigravity-cli', 'implicit');
  if (fs.existsSync(implicit)) fs.cpSync(implicit, path.join(target, 'implicit'), { recursive: true });
  const workA = path.join(root, 'work-a'), workGroup = path.join(root, 'work-group');
  for (const d of [workA, workGroup]) fs.mkdirSync(d, { recursive: true });
  for (const key of Object.keys(process.env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete process.env[key];

  await step('01', '启动隔离 Hub（无代理变量，模拟桌面快捷方式）', async note => {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'background', label: 'agy-live',
      extraEnv: { AI_HUB_ANTIGRAVITY_COMMAND: agy, CLAUDE_HUB_HOME_DIR: home, CLAUDE_PROXY: 'http://127.0.0.1:7890', DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && typeof selectSession === "function" && window.WorkspaceController', 'Hub 界面', 60000);
    note('窗口标题：' + await c.eval('document.title'));
    ctx.hub = true;
  });

  await step('02', '新建会话面板选 Antigravity 点创建：不再卡住', async note => {
    await c.eval(`window.WorkspaceController.openNewSessionModal({ kind: 'gemini', workspace: { path: ${j(workA)}, name: 'work-a' } })`);
    await until(`document.querySelector('#new-session-submit')?.getBoundingClientRect().width > 0`, '新建会话面板', 20000);
    await c.eval(`document.querySelector('.new-session-option[data-kind="gemini"]').click()`);
    // 像用户一样在下拉里挑低档模型（清单由 agy models 异步补全）。
    await until(`[...document.querySelectorAll('#new-session-model option')].some(o => o.value === ${j(MODEL)})`, '模型下拉出现账号模型', 40000);
    await c.eval(`(() => { const s = document.getElementById('new-session-model'); s.value = ${j(MODEL)}; s.dispatchEvent(new Event('change')); })()`);
    const before = await c.eval(`[...sessions.keys()]`);
    const t0 = Date.now();
    await c.eval(`document.querySelector('#new-session-submit').click()`);
    const sid = await until(`(() => { const ids = [...sessions.keys()].filter(id => !${j(before)}.includes(id) && /^gemini/.test(sessions.get(id).kind)); return ids[0] || null; })()`, '会话出现在侧栏', 30000);
    const ms = Date.now() - t0;
    note(`点击创建到会话出现：${ms} ms`);
    if (ms > 8000) throw new Error('创建仍然过慢：' + ms + ' ms');
    ctx.a = ctx.focus = sid;
    await waitReady(sid, '新会话');
    note('就绪后终端末尾：\n' + await screenTail(sid, 6));
    const trusted = JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).trustedWorkspaces || [];
    note('预信任包含工作目录：' + trusted.some(p => p.toLowerCase() === workA.toLowerCase()));
  }, ['hub']);

  await step('03', '模型清单走代理拿到账号模型', async note => {
    const r = await c.eval(`ipcRenderer.invoke('antigravity:model-catalog')`);
    note(j({ ok: r.ok, n: r.models && r.models.length, first: r.models && r.models.slice(0, 3).map(m => m.id), error: r.error }));
    if (!r.ok || !r.models.length) throw new Error('模型清单失败');
  }, ['hub']);

  await step('04', '卡片视图发消息：回答出现在卡片，状态为完成', async note => {
    note('会话模型：' + (await info(ctx.a)).model);
    const r = await send(ctx.a, '只回复 AGY-ONE，不要调用任何工具。', 'AGY-ONE', '第一条');
    note(j(r)); note(j(await info(ctx.a)));
    const meta = await info(ctx.a);
    if (!meta.chat || meta.hash !== 'antigravity') throw new Error('没有绑定原生会话 ID');
    ctx.one = true;
  }, ['a']);

  await step('05', '多行中文一次提交，回答完整', async note => {
    const r = await send(ctx.a, '第一行：这是多行测试\n第二行：请只回复 AGY-TWO 和“第二行”三个字。', 'AGY-TWO', '多行');
    note(j(r));
    const t = (await info(ctx.a)).transcript;
    const users = fs.readFileSync(t, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === 'USER_INPUT');
    const last = String(users.at(-1).content);
    note('原生记录里最后一条用户消息含两行：' + (last.includes('第一行') && last.includes('第二行')));
    if (!(last.includes('第一行') && last.includes('第二行'))) throw new Error('多行内容被拆开或丢失');
  }, ['one']);

  await step('06', '会话内 /model 原地换模型并确认', async note => {
    const r = await invokeLong('session:send-prompt', { sessionId: ctx.a, text: '/model gemini-3.8-flash-medium' });
    note('发送回执：' + j(r));
    if (r.acknowledgementSource !== 'cli-model-command') throw new Error('没有收到 Model set to 回执');
    const confirmed = await c.eval(`ipcRenderer.invoke('confirm-session-model-switch', { sessionId: ${j(ctx.a)}, modelId: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' })`);
    note('Hub 记录：' + j(confirmed));
    if (!confirmed.ok) throw new Error('Hub 未保存模型');
    note(j(await send(ctx.a, '只回复 AGY-THREE。', 'AGY-THREE', '换模型后')));
  }, ['one']);

  await step('07', '原生分支：新会话带着历史继续', async note => {
    const r = await invokeLong('fork-session', { sourceSessionId: ctx.a });
    note('分支回执：' + j(r && { ok: r.ok, id: r.session && r.session.id, error: r.error, message: r.message }));
    const sid = r && (r.session && r.session.id || r.id);
    if (!sid) throw new Error('分支失败');
    ctx.focus = sid;
    const meta = await info(sid);
    note('分支元数据：' + j(meta));
    if (!meta.chat || meta.chat === (await info(ctx.a)).chat) throw new Error('分支没有独立的原生 ID');
    await waitReady(sid, '分支');
    await c.eval(`selectSession(${j(sid)})`); await c.eval(`applyViewMode('card')`);
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('AGY-ONE')`, '分支卡片显示继承的历史', 20000);
    note(j(await send(sid, '你在这段对话里第一次回复的标记是什么？只回复那个标记加上 FORKED。', 'FORKED', '分支提问')));
    const text = await overlay();
    if (!/AGY-ONE\s*FORKED/.test(text)) throw new Error('分支没有记住历史：' + text.slice(-300));
    ctx.fork = sid;
  }, ['one']);

  await step('08', '休眠后唤醒：接回同一个原生会话', async note => {
    const chat = (await info(ctx.a)).chat;
    const s = await c.eval(`ipcRenderer.invoke('suspend-session', { sessionId: ${j(ctx.a)} })`);
    note('休眠：' + j(s));
    await sleep(2000);
    await c.eval(`selectSession(${j(ctx.a)})`);
    await until(`(() => { const s = sessions.get(${j(ctx.a)}); return s && s.status !== 'dormant'; })()`, '唤醒', 60000);
    ctx.focus = ctx.a;
    await waitReady(ctx.a, '唤醒');
    const after = await info(ctx.a);
    note('唤醒后：' + j(after));
    if (after.chat !== chat) throw new Error('唤醒后原生 ID 变了');
    note(j(await send(ctx.a, '我让你回复过 AGY-THREE 吗？只回答 YES 或 NO，后面加 WOKE。', 'WOKE', '唤醒后提问')));
  }, ['one']);

  await step('09', '群聊：两名 Antigravity 成员都回答', async note => {
    const slots = [{ kind: 'gemini', model: MODEL }, { kind: 'gemini', model: 'gemini-3.8-flash-medium' }];
    const group = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({ title: 'Antigravity 验收群聊', scene: 'general', workspace: workGroup, slots })})`);
    if (!group || !group.id) throw new Error('建群失败：' + j(group));
    note(`群聊 ${group.id}，成员 ${group.subSessions.length}`);
    ctx.focus = group.subSessions[0];
    await c.eval(`window.MeetingRoom.openMeeting(${j(group.id)}, ${j(group)})`);
    await until('document.getElementById("mr-input-box")', '群聊输入框', 30000);
    await c.eval(`(() => { const box = document.getElementById('mr-input-box'); box.focus(); const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
    await c.send('Input.insertText', { text: '请用一句话回复：GROUP-OK 加上你的群聊角色名字。' });
    await sleep(500);
    await c.eval(`document.getElementById('mr-send-btn').click()`);
    const stateExpr = `ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(group.id)} })`;
    const t0 = Date.now();
    try {
      await until(`(async () => { const s = await ${stateExpr}; return (s?.messages || []).filter(m => m.role === 'assistant' && String(m.content || '').includes('GROUP-OK')).length >= 2; })()`, '两名成员都回答', 300000);
    } catch (error) {
      for (const sid of group.subSessions) note(`成员 ${sid.slice(0, 8)} 终端：\n` + await screenTail(sid, 15));
      throw error;
    }
    // 回答到齐之后，本轮还要随原生 Stop 收尾：顶部「进行中 / 停止」应自行消失。
    await until(`!/本轮\\s*进行中/.test(document.body.innerText)`, '群聊本轮收尾', 120000);
    note('收尾后状态栏：' + await c.eval(`(document.querySelector('.mr-gc-round-status, [class*="round"]')?.innerText || document.body.innerText.match(/本轮[^\\n]{0,20}/)?.[0] || '').slice(0, 80)`));
    const state = await c.eval(stateExpr);
    note(`用时 ${Math.round((Date.now() - t0) / 1000)} s；回答：` + (state.messages || []).filter(m => m.role === 'assistant').map(m => String(m.content).slice(0, 80)).join(' | '));
  }, ['hub']);
}

main().catch(error => { report.fatal = String(error && error.stack || error); console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { report.quitError = e.message; } }
    report.finishedAt = new Date().toISOString();
    if (report.steps.some(s => s.status === 'fail')) process.exitCode = 1;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('report: ' + path.join(out, 'report.json'));
  });
