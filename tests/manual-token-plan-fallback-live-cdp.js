'use strict';
// Token Plan 额度用完 → DeepSeek API 改道的真机验收：隔离 Hub + 真实 Token Plan Key（需处于额度用完状态）
// + 真实 DeepSeek Key（flash 档，花费几分钱）。不进单测运行器，按需手动跑：
//
//   node tests/manual-token-plan-fallback-live-cdp.js [--steps 02,03]
//
// 只读取生产 config.json 里的 acp 与 DeepSeek Key 写进隔离数据目录，不改生产文件。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const onlySteps = arg('--steps') ? new Set(arg('--steps').split(',')) : null;
const root = fs.mkdtempSync(path.join(process.env.AI_HUB_E2E_ROOT || os.tmpdir(), 'tp-fallback-live-'));
const out = path.join(root, 'report');
const dataDir = path.join(root, 'data');
const stateFile = path.join(dataDir, 'token-plan-fallback.json');
const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const report = { startedAt: new Date().toISOString(), root, steps: [] };
const ctx = {};
let hub = null, c = null;
const PROMPT = '用工具读取当前目录下的 secret.txt，只回复其中的数字，不要别的。';

async function step(id, title, fn, needs = []) {
  const entry = { id, title, status: 'running', evidence: [] };
  report.steps.push(entry);
  if (onlySteps && !onlySteps.has(id)) { entry.status = 'skipped'; return print(entry); }
  const missing = needs.filter(n => !ctx[n]);
  if (missing.length) { entry.status = 'skipped'; entry.evidence.push('前置未满足：' + missing.join(',')); return print(entry); }
  const t0 = Date.now();
  try { await fn(note => entry.evidence.push(String(note))); entry.status = 'pass'; }
  catch (error) { entry.status = 'fail'; entry.error = String(error && error.stack || error).slice(0, 2000); }
  entry.seconds = Math.round((Date.now() - t0) / 100) / 10;
  try { if (c) fs.writeFileSync(path.join(out, id + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch {}
  print(entry);
  for (const line of entry.evidence) console.log('    ' + line.replace(/\n/g, '\n    '));
}
function print(e) { console.log(`[${e.status}] ${e.id} ${e.title}${e.seconds != null ? ` (${e.seconds}s)` : ''}${e.error ? ' — ' + e.error.split('\n')[0] : ''}`); }
async function until(expr, label, ms = 120000) {
  const end = Date.now() + ms; let last = null;
  while (Date.now() < end) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e; } await sleep(500); }
  throw new Error('超时：' + label + (last ? '（' + last.message + '）' : ''));
}
let invokeSeq = 0;
async function invokeLong(channel, payload, ms = 240000) {
  const key = '__tpInvoke' + (++invokeSeq);
  await c.eval(`(() => { window[${j(key)}] = null; ipcRenderer.invoke(${j(channel)}, ${j(payload)}).then(r => { window[${j(key)}] = { r }; }, e => { window[${j(key)}] = { e: e.message }; }); return true; })()`);
  const box = await until(`window[${j(key)}]`, channel, ms);
  if (box.e) throw new Error(channel + ' 抛错：' + box.e);
  return box.r;
}
const info = sid => c.eval(`(() => { const s = sessions.get(${j(sid)}); return s && { kind: s.kind, profile: s.acpProfileId || null, model: s.currentModel && s.currentModel.id, notice: s.nativeActionError || null, status: s.status }; })()`);
function workdir(name, secret) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.txt'), `The magic number is ${secret}.\n`);
  return dir;
}
async function createViaIpc(kind, cwd) {
  const before = await c.eval(`[...sessions.keys()]`);
  const created = await invokeLong('create-session', { kind, opts: { cwd } }, 90000);
  const sid = created && (created.id || created.hubId);
  if (!sid) throw new Error('创建失败：' + j(created));
  await until(`sessions.has(${j(sid)}) && !${j(before)}.includes(${j(sid)})`, '会话出现在侧栏', 30000);
  return sid;
}
// 发一条读文件的题，等卡片里出现数字，并核对会话已挂在 DeepSeek 路线上。
async function askAndExpect(sid, secret, label, note) {
  await c.eval(`selectSession(${j(sid)})`); await sleep(300); await c.eval(`applyViewMode('card')`);
  const before = await info(sid);
  note(`${label} 发送前：${j(before)}`);
  const t0 = Date.now();
  const result = await invokeLong('session:send-prompt', { sessionId: sid, text: PROMPT, clientSubmissionId: 'tp-' + Date.now() });
  note(`${label} 发送回执：${j({ ok: result && result.ok, status: result && result.sendStatus, message: result && result.message })}`);
  if (!result || result.ok === false) throw new Error(label + '：发送失败 ' + j(result));
  // 记录卡片提示的变化过程，便于核对改道提示有没有被别的消息盖掉。
  const seen = [];
  const watch = setInterval(async () => { try { const v = (await info(sid))?.notice || null; if (seen.at(-1) !== v) seen.push(v); } catch {} }, 300);
  try {
    await until(`(() => { const s = sessions.get(${j(sid)}); return s && String(s.acpProfileId || '').startsWith('deepseek-api:'); })()`, label + ' 改道到 DeepSeek', 420000); // ZCode 撞 429 会自己重试约 5 分钟才报失败
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes(${j(String(secret))})`, label + ' 卡片出现正确答案', 240000);
    await sleep(1500);
  } finally { clearInterval(watch); }
  const after = await info(sid);
  const mainSide = await c.eval(`ipcRenderer.invoke('get-sessions').then(list => (list.find(s => s.id === ${j(sid)}) || {}).nativeActionError || null)`);
  note(`${label} 用时 ${Math.round((Date.now() - t0) / 1000)} s；之后：${j(after)}；主进程提示：${mainSide}；提示变化：${j(seen)}`);
  return after;
}
function clearState(note) { try { fs.unlinkSync(stateFile); note('已删除用完状态文件，让新会话先挂在套餐上'); } catch {} }

async function main() {
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const prod = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub', 'config.json'), 'utf8').replace(/^﻿/, ''));
  const dsKey = prod.providers && prod.providers.deepseek && prod.providers.deepseek.api_key;
  if (!prod.acp || !prod.acp.apiKey || !dsKey) throw new Error('生产配置缺少 Token Plan 或 DeepSeek Key');
  const acp = JSON.parse(JSON.stringify(prod.acp));
  // 低档：千问 flash → DeepSeek flash；DSH flash → DeepSeek flash；GLM 只有 5.2 → DeepSeek pro。
  acp.providers.qwen.model = 'qwen3.8-flash';
  acp.providers['deepseek-acp'].model = 'deepseek-v4-flash-0731';
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ acp, providers: { deepseek: { api_key: dsKey } } }, null, 2));

  await step('01', '启动隔离 Hub', async note => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'tp-fallback-live',
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && typeof selectSession === "function" && window.WorkspaceController', 'Hub 界面', 60000);
    note('窗口标题：' + await c.eval('document.title'));
    ctx.hub = true;
  });

  await step('02', '千问会话（新建面板创建、挂在套餐上）撞额度墙：自动改道 DeepSeek 并重发，卡片拿到答案', async note => {
    clearState(note);
    const dir = workdir('work-qwen', 4817);
    await c.eval(`window.WorkspaceController.openNewSessionModal({ kind: 'qwen', workspace: { path: ${j(dir)}, name: 'work-qwen' } })`);
    await until(`document.querySelector('#new-session-submit')?.getBoundingClientRect().width > 0`, '新建会话面板', 20000);
    await c.eval(`document.querySelector('.new-session-option[data-kind="qwen"]').click()`);
    const before = await c.eval(`[...sessions.keys()]`);
    await c.eval(`document.querySelector('#new-session-submit').click()`);
    const sid = await until(`(() => { const ids = [...sessions.keys()].filter(id => !${j(before)}.includes(id) && /^qwen/.test(sessions.get(id).kind)); return ids[0] || null; })()`, '会话出现在侧栏', 60000);
    await until(`String(sessions.get(${j(sid)})?.acpProfileId || '').length > 0`, '会话绑定路线', 60000);
    const first = await info(sid);
    if (first.profile !== 'aliyun-token-plan:qwen') throw new Error('新会话应先挂在套餐上：' + j(first));
    const after = await askAndExpect(sid, 4817, '千问', note);
    if (!/^deepseek-v4-(pro|flash)$/.test(after.model || '')) throw new Error('应换成 DeepSeek 模型：' + after.model);
    note('终端末尾：' + String(await c.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${j(sid)})`) || '').replace(/[[0-9;?]*[ -/]*[@-~]/g, '').slice(-600).replace(/s+/g, ' '));
    if (!/暂用 DeepSeek API ·/.test(after.notice || '')) throw new Error('卡片缺少改道提示：' + after.notice);
    const overlay = await c.eval(`document.querySelector('#msg-overlay')?.innerText || ''`);
    note('卡片末尾：' + overlay.slice(-400).replace(/\s+/g, ' '));
    note('用完状态文件：' + fs.readFileSync(stateFile, 'utf8').replace(/\s+/g, ' '));
    ctx.qwen = sid;
  }, ['hub']);

  await step('03', '已知用完时新建 GLM 会话：直接挂在 DeepSeek 上，不再先撞套餐', async note => {
    if (!fs.existsSync(stateFile)) throw new Error('缺少用完状态（步骤 02 应已写入）');
    const sid = await createViaIpc('glm', workdir('work-glm-direct', 3306));
    await until(`String(sessions.get(${j(sid)})?.acpProfileId || '').length > 0`, '会话绑定路线', 60000);
    const first = await info(sid);
    note('创建后：' + j(first));
    if (first.profile !== 'deepseek-api:glm') throw new Error('应直接挂在 DeepSeek 上');
    const after = await askAndExpect(sid, 3306, 'GLM（直达）', note);
    if (!/暂用 DeepSeek API ·/.test(after.notice || '')) throw new Error('直达 DeepSeek 的会话卡片缺少说明：' + after.notice);
  }, ['hub']);

  await step('04', 'DeepSeek 旧 Harness 会话（挂在套餐上）撞墙报错：自动改道并重发', async note => {
    clearState(note);
    const sid = await createViaIpc('deepseek-acp', workdir('work-dsh', 5521));
    await until(`String(sessions.get(${j(sid)})?.acpProfileId || '').length > 0`, '会话绑定路线', 60000);
    if ((await info(sid)).profile !== 'aliyun-token-plan:deepseek-acp') throw new Error('应先挂在套餐上');
    const after = await askAndExpect(sid, 5521, 'DSH', note);
    // 同一线路上再重启一次（相当于 Hub 重启后恢复）：仍能按 DeepSeek 模型继续答。
    const restarted = await invokeLong('restart-session', sid, 120000);
    note('同线路重启：' + JSON.stringify({ ok: restarted && restarted.ok !== false, message: restarted && restarted.message }));
    await c.eval(`applyViewMode('card')`);
    const again = await invokeLong('session:send-prompt', { sessionId: sid, text: '再读一次 secret.txt，只回复数字加上 AGAIN。', clientSubmissionId: 'tp-again-' + Date.now() });
    if (!again || again.ok === false) throw new Error('重启后发送失败：' + JSON.stringify(again));
    await until(`(document.querySelector('#msg-overlay')?.innerText || '').includes('AGAIN')`, '同线路重启后再答', 180000);
    if (!/暂用 DeepSeek API ·/.test(after.notice || '')) throw new Error('卡片缺少改道提示：' + after.notice);
  }, ['hub']);

  await step('05', 'GLM 会话（挂在套餐上）撞墙报错：自动改道并重发', async note => {
    clearState(note);
    const sid = await createViaIpc('glm', workdir('work-glm', 6634));
    await until(`String(sessions.get(${j(sid)})?.acpProfileId || '').length > 0`, '会话绑定路线', 60000);
    if ((await info(sid)).profile !== 'aliyun-token-plan:glm') throw new Error('应先挂在套餐上');
    const after = await askAndExpect(sid, 6634, 'GLM', note);
    if (!/暂用 DeepSeek API ·/.test(after.notice || '')) throw new Error('卡片缺少改道提示：' + after.notice);
  }, ['hub']);

  await step('06', '群聊：第一轮成员撞墙按失败收尾并改道，第二轮两名成员都经 DeepSeek 回答', async note => {
    clearState(note);
    const workGroup = workdir('work-group', 7788);
    const slots = [{ kind: 'qwen' }, { kind: 'deepseek-acp' }];
    const group = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({ title: 'Token Plan 改道验收群聊', scene: 'general', workspace: workGroup, slots })})`);
    if (!group || !group.id) throw new Error('建群失败：' + j(group));
    await c.eval(`window.MeetingRoom.openMeeting(${j(group.id)}, ${j(group)})`);
    await until('document.getElementById("mr-input-box")', '群聊输入框', 30000);
    const stateExpr = `ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(group.id)} })`;
    const sendGroup = async text => {
      await c.eval(`(() => { const box = document.getElementById('mr-input-box'); box.focus(); const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); })()`);
      await c.send('Input.insertText', { text });
      await sleep(500);
      await c.eval(`document.getElementById('mr-send-btn').click()`);
    };
    await sendGroup('第一轮：请用一句话回复 ROUND1-OK。');
    // 至少一名成员撞墙后改道；DSH 偶发启动失败（自身 EBUSY）的成员留在套餐上，第二轮发送前由 beforeSend 改道。
    await until(`(async () => { const ids = ${j(group.subSessions)}; return ids.some(id => String(sessions.get(id)?.acpProfileId || '').startsWith('deepseek-api:')); })()`, '成员撞墙后改道到 DeepSeek', 240000);
    await until(`!/本轮\\s*进行中/.test(document.body.innerText)`, '第一轮收尾', 180000);
    for (const sid of group.subSessions) note('第一轮后成员 ' + sid.slice(0, 8) + '：' + j(await info(sid)));
    const s1 = await c.eval(stateExpr);
    note('第一轮成员结果：' + (s1.messages || []).filter(m => m.role !== 'user').map(m => `${m.role}:${String(m.content || m.text || '').slice(0, 60)}`).join(' | '));
    await sendGroup('第二轮：请读取当前目录下的 secret.txt，只回复 GROUP-OK 加上其中的数字。');
    const t0 = Date.now();
    await until(`(async () => { const s = await ${stateExpr}; return (s?.messages || []).filter(m => m.role === 'assistant' && /GROUP-OK\\D{0,5}7788/.test(String(m.content || ''))).length >= 2; })()`, '第二轮两名成员都答对', 300000);
    const s2 = await c.eval(stateExpr);
    note(`第二轮用时 ${Math.round((Date.now() - t0) / 1000)} s；回答：` + (s2.messages || []).filter(m => m.role === 'assistant').slice(-2).map(m => String(m.content).slice(0, 80)).join(' | '));
    for (const sid of group.subSessions) note('成员 ' + sid.slice(0, 8) + '：' + j(await info(sid)));
  }, ['hub']);
}

main().catch(error => { report.fatal = String(error && error.stack || error); console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (c) { try { c.close(); } catch {} }
    if (hub) { try { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'), 'utf8'); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { report.quitError = e.message; } }
    report.finishedAt = new Date().toISOString();
    if (report.steps.some(s => s.status === 'fail')) process.exitCode = 1;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('report: ' + path.join(out, 'report.json'));
  });
