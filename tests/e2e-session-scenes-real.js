'use strict';
/**
 * 会话场景真机 E2E（2026-10-13 田哥：不同任务用不同提示词，场景按钮在输入框，场景页在「规则」里）。
 *
 * 隔离 Hub，个人规则、场景库、知识库照真实的复制一份到测试 home。按田哥的真实操作走：
 *   1. 规则 → 场景：6 个场景都在，技术讨论挂着知识库；「实际发送内容」里有「关于田哥」和知识库索引；改默认场景
 *   2. Claude（haiku）生活参谋会话 → 输入框「场景」按钮 → 选技术讨论：空会话直接换成技术讨论会话
 *      （隔离 Hub 不许把个人规则同步进真实 ~/.claude，所以 Claude 不建编程会话；「编程 → 场景」在第 5 步用 Codex 走）
 *   3. 在技术讨论会话里提问，核对 Claude 的真实启动命令与会话记录：系统提示是场景提示词，
 *      没有个人协作约定、工程规则、输出风格、技能清单、浏览器说明、编程助手系统提示
 *   4. 已经聊过的会话换到投研：先确认，再新开投研会话，输入框里放好对原会话的引用，原会话保留
 *   5. Codex 编程会话 → 场景按钮 → 技术讨论；提问后核对基础指令就是场景提示词，记录写在干净配置目录
 * 截图写到结果目录的 shots/。用法：node tests/e2e-session-scenes-real.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const REAL_AGENTS = path.join(os.homedir(), '.agents');
const REAL_CODEX = path.join(os.homedir(), '.codex');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) { if (!['_history', 'backups'].includes(e.name)) copyTree(s, d); }
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// 编程上下文的标志（技术讨论场景自己要「白话解读」，所以不把它算进来）
const CODING_MARKERS = [
  ['个人协作约定', /个人协作约定/],
  ['工程规则', /## 执行与工程|会话复盘规则/],
  ['Lintian-Plain 输出风格', /Lintian-Plain|Output Style:/],
  ['技能清单', /<skills_instructions>|Available skills|The following skills are available/],
  ['记忆说明', /## Memory\b|memory folder with guidance/],
  ['浏览器自动化说明', /Claude in Chrome browser automation|claude-in-chrome/],
  ['编程助手基础指令', /You are Codex, an agent|You are an interactive agent that helps users with software engineering/],
  ['Hub 通用规则', /以下是 AI Hub 默认带上的规则/],
];

function modelFacingText(file) {
  const out = [];
  for (const line of (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/)) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') out.push(String((p.base_instructions || {}).text || ''));
    else if (d.type === 'response_item' && p.type === 'message' && (p.role === 'developer' || p.role === 'user')) out.push(JSON.stringify(p.content || []));
    else if (d.type === 'attachment') { const a = { ...(d.attachment || {}) }; delete a.cliPrefix; out.push(JSON.stringify(a)); }
    else if (d.type === 'user' && d.message) out.push(JSON.stringify(d.message.content || ''));
  }
  return out.join('\n');
}
function lastAssistantText(file) {
  let last = '';
  for (const line of (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/)) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
      const t = d.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (t.trim()) last = t;
    }
    const p = d.payload || {};
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = (p.content || []).map(c => c.text || '').join('');
      if (t.trim()) last = t;
    }
  }
  return last;
}

async function main() {
  const root = fs.mkdtempSync(path.join(process.env.CLAUDE_HUB_E2E_ROOT || os.tmpdir(), 'hub-scenes-'));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  const shots = path.join(root, 'shots');
  const codexHome = path.join(root, 'codex-home');
  for (const p of [data, home, ws, shots, codexHome]) fs.mkdirSync(p, { recursive: true });
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.copyFileSync(path.join(REAL_AGENTS, 'USER_CONTEXT.md'), path.join(home, '.agents', 'USER_CONTEXT.md'));
  copyTree(path.join(REAL_AGENTS, 'scenes'), path.join(home, '.agents', 'scenes'));
  copyTree(path.join(REAL_AGENTS, 'knowledge'), path.join(home, '.agents', 'knowledge'));
  // 测试 home 里的知识库索引要指向测试 home 自己的正文目录
  const idx = path.join(home, '.agents', 'knowledge', 'wireless', 'INDEX.md');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').split('C:/Users/lintian/.agents/').join(home.replace(/\\/g, '/') + '/.agents/'));
  fs.copyFileSync(path.join(REAL_CODEX, 'config.toml'), path.join(codexHome, 'config.toml'));
  const realAuth = path.join(REAL_CODEX, 'auth.json');
  const authOriginal = fs.readFileSync(realAuth);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), authOriginal);
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), fs.readFileSync(path.join(home, '.agents', 'USER_CONTEXT.md')));
  const prod = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ proxy: prod.proxy }, null, 2));

  const result = { root, checks: [], passed: false };
  const check = (name, ok, detail) => { result.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
  let hub; let cdp;
  const until = async (expr, label, ms = 35000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cdp.eval(`Boolean(${expr})`)) return; await sleep(400); }
    throw new Error('timeout: ' + label);
  };
  const untilValue = async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1500); } throw new Error('timeout: ' + label); };
  const shot = async (name) => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(s.data, 'base64')); };
  const sessionsNow = () => cdp.eval('ipcRenderer.invoke("get-sessions").then(ss=>ss.map(s=>({id:s.id,kind:s.kind,purpose:s.purpose||null,title:s.title,transcriptPath:s.transcriptPath||null,lastCompletedAt:s.lastCompletedAt||0,writingContextWarning:s.writingContextWarning||null,status:s.status})))');
  const bar = id => `document.querySelector('.floating-input-bar[data-session-id="${id}"]')`;
  const sendViaComposer = async (id, text) => {
    await until(`${bar(id)} && ${bar(id)}.querySelector('.floating-input-box')`, 'composer of ' + id, 60000);
    await cdp.eval(`(()=>{const b=${bar(id)}.querySelector('.floating-input-box');b.focus();const r=document.createRange();r.selectNodeContents(b);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
    await cdp.send('Input.insertText', { text });
    await sleep(400);
    await cdp.eval(`${bar(id)}.querySelector('.floating-input-send').click()`);
  };
  const waitReply = async (id, ms) => untilValue(async () => {
    const s = (await sessionsNow()).find(x => x.id === id);
    if (!s || !s.transcriptPath) return null;
    const t = lastAssistantText(s.transcriptPath);
    return s.lastCompletedAt && t ? { s, text: t } : null;
  }, 'reply of ' + id, ms);
  const cmdline = (needle) => {
    try {
      const outp = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'claude%' or Name like 'node%' or Name like 'codex%'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true });
      return outp.split(/\r?\n/).find((l) => l.includes(needle)) || '';
    } catch { return ''; }
  };

  try {
    hub = await launchIsolatedHub({
      dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'session-scenes',
      extraEnv: { CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_ACCOUNT_FIXTURE: path.resolve(__dirname, 'fixtures', 'account-center-cli.js'), CODEX_HOME: codexHome },
    });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof window.__rulesShow === "function"', 'rules.js loaded', 60000);

    // 1. 规则 → 场景
    await cdp.eval('window.__rulesShow()');
    await until('document.querySelector(".rl-tab[data-view=scenes]")', 'scenes tab');
    await cdp.eval('document.querySelector(".rl-tab[data-view=scenes]").click()');
    await until('document.querySelectorAll(".rl-scene-item").length >= 6', 'scene list');
    const items = await cdp.eval('[...document.querySelectorAll(".rl-scene-item")].map(b=>b.innerText.replace(/\\s+/g," "))');
    check('规则 → 场景：6 个场景都在，技术讨论挂着知识库', items.length === 6 && items.some(t => /技术讨论.*知识库 \d+ 条/.test(t)), items.map(t => t.slice(0, 18)).join(' | '));
    await cdp.eval('document.querySelector(".rl-scene-item[data-scene=tech]").click()');
    await until('document.querySelector("#rl-scene-modes [data-mode=sent]")', 'mode bar');
    await shot('01-规则-场景-技术讨论');
    await cdp.eval('document.querySelector("#rl-scene-modes [data-mode=sent]").click()');
    await until('document.querySelector("#rl-scene-sent")', 'sent view');
    const sent = await cdp.eval('document.querySelector("#rl-scene-sent").textContent');
    check('实际发送内容：场景提示词 + 关于田哥 + 知识库索引，不含工程规则', sent.includes('# 场景：技术讨论') && sent.includes('## 关于田哥') && sent.includes('知识库索引（技术讨论）') && !/## 执行与工程|会话复盘规则/.test(sent), `${sent.length} 字`);
    await shot('02-规则-场景-实际发送内容');
    await cdp.eval('document.querySelector("#rl-scene-modes [data-mode=kb]").click()');
    await until('document.querySelector("#rl-scene-kb")', 'kb view');
    await shot('03-规则-场景-知识库索引');
    await cdp.eval('(()=>{const s=document.getElementById("rl-scene-default");s.value="tech";s.dispatchEvent(new Event("change"));})()');
    await until('document.querySelector(".rl-scene-item[data-scene=tech] .rl-pill:not(.ok)")', 'default tag moved');
    const def = await cdp.eval('ipcRenderer.invoke("session-scenes:snapshot").then(r=>r.data.defaultScene)');
    check('改默认场景生效', def === 'tech', def);
    await cdp.eval('(()=>{const s=document.getElementById("rl-scene-default");s.value="coding";s.dispatchEvent(new Event("change"));})()');
    await until('document.querySelector(".rl-scene-item[data-scene=coding] .rl-pill:not(.ok)")', 'default back');

    // 2. Claude 生活参谋会话 → 场景按钮 → 技术讨论
    const created = await cdp.eval(`ipcRenderer.invoke("create-session",{kind:"claude",opts:{model:"haiku",cwd:${JSON.stringify(ws)},purpose:"scene-life"}})`);
    const firstId = created.id;
    await until(`${bar(firstId)} && !${bar(firstId)}.querySelector('.composer-scene').hidden`, 'scene chip visible', 60000);
    const chipText = await cdp.eval(`${bar(firstId)}.querySelector('.composer-scene').textContent`);
    check('输入框有「场景」按钮，显示当前场景', chipText === '场景 · 生活参谋', chipText);
    await cdp.eval(`${bar(firstId)}.querySelector('.composer-scene').click()`);
    await until('document.querySelector(".composer-scene-popover:not([hidden]) [data-scene=tech]")', 'scene popover');
    await shot('04-输入框-场景弹层');
    await cdp.eval('document.querySelector(".composer-scene-popover:not([hidden]) [data-scene=tech]").click()');
    const techSession = await untilValue(async () => (await sessionsNow()).find(s => s.purpose === 'scene-tech'), 'tech session', 60000);
    const firstGone = await untilValue(async () => !(await sessionsNow()).some(s => s.id === firstId), 'empty session removed', 20000).catch(() => false);
    const sideRow = await cdp.eval(`Boolean(document.querySelector('[data-session-id="${firstId}"].session-item, .session-item[data-id="${firstId}"]'))`);
    check('空会话直接换成技术讨论：新会话标记 scene-tech，原来的空会话收起', !!techSession && firstGone && !sideRow, techSession && techSession.id);
    await until(`${bar(techSession.id)} && ${bar(techSession.id)}.querySelector('.composer-scene').textContent==='场景 · 技术讨论'`, 'tech chip label', 60000);
    check('新会话的场景按钮显示技术讨论', true);

    // 3. 技术讨论会话提问，核对启动命令与会话记录
    await sendViaComposer(techSession.id, '（这是测试）两三句话回答：单站 30% 负载的仿真里 MSG 增益很小，正常吗？');
    const techCmd = await untilValue(async () => cmdline('scene-prompts') || null, 'claude scene cmdline', 60000).catch(() => '');
    check('Claude 启动：整份换成场景提示词、关技能与浏览器扩展、不带通用规则', /--system-prompt-file/.test(techCmd) && /scene-prompts[\\/]tech-/.test(techCmd) && /--disable-slash-commands/.test(techCmd) && /--no-chrome/.test(techCmd) && /--tools/.test(techCmd) && !/--append-system-prompt-file/.test(techCmd), techCmd.slice(0, 220));
    const techReply = await waitReply(techSession.id, 4 * 60 * 1000);
    const techText = modelFacingText(techReply.s.transcriptPath);
    const techHits = CODING_MARKERS.filter(([, re]) => re.test(techText)).map(([n]) => n);
    check('技术讨论会话记录：系统提示是场景提示词 + 关于田哥 + 知识库索引', techText.includes('场景：技术讨论') && techText.includes('关于田哥') && techText.includes('知识库索引'), `${techText.length} 字`);
    check('技术讨论会话记录：没有编程上下文', techHits.length === 0, techHits.join('、') || '无');
    check('回复按场景格式以 📌 起头', /^\s*📌/.test(techReply.text), techReply.text.slice(0, 80).replace(/\n/g, ' '));
    result.techReply = techReply.text;
    const raw = fs.readFileSync(techReply.s.transcriptPath, 'utf8');
    result.readKnowledge = /knowledge[\\/]+wireless/.test(raw);
    console.log('    （回答时读了知识库正文：' + (result.readKnowledge ? '是' : '否') + '）');
    await shot('05-技术讨论会话-回答');

    // 4. 已有对话 → 换投研：确认 → 新开并引用
    await cdp.eval(`${bar(techSession.id)}.querySelector('.composer-scene').click()`);
    await until('document.querySelector(".composer-scene-popover:not([hidden]) [data-scene=invest]")', 'popover 2');
    await cdp.eval('document.querySelector(".composer-scene-popover:not([hidden]) [data-scene=invest]").click()');
    await until('document.querySelector(".composer-scene-popover:not([hidden]) .cs-go")', 'confirm');
    await shot('06-已有对话-换场景确认');
    const confirmText = await cdp.eval('document.querySelector(".composer-scene-popover .cs-confirm").innerText');
    check('已有对话换场景先说明原因再确认', /中途换不掉/.test(confirmText) && /原会话保留/.test(confirmText), confirmText.slice(0, 60).replace(/\n/g, ' '));
    await cdp.eval('document.querySelector(".composer-scene-popover .cs-go").click()');
    const investSession = await untilValue(async () => (await sessionsNow()).find(s => s.purpose === 'scene-invest'), 'invest session', 60000);
    const all = await sessionsNow();
    await until(`${bar(investSession.id)} && ${bar(investSession.id)}.querySelector('.floating-input-box').innerText.includes('【引用会话】')`, 'reference draft', 30000).catch(() => {});
    const draft = await cdp.eval(`(${bar(investSession.id)}||{querySelector:()=>null}).querySelector('.floating-input-box')?.innerText||''`);
    check('新开投研会话，输入框里放好对原会话的引用，原会话保留', /【引用会话】/.test(draft) && all.some(s => s.id === techSession.id), draft.slice(0, 70).replace(/\n/g, ' '));
    await shot('07-投研会话-引用草稿');

    // 5. Codex 编程会话 → 场景按钮 → 技术讨论
    const codexCoding = await cdp.eval(`ipcRenderer.invoke("create-session",{kind:"codex",opts:{cwd:${JSON.stringify(ws)}}})`);
    await until(`${bar(codexCoding.id)} && !${bar(codexCoding.id)}.querySelector('.composer-scene').hidden`, 'codex chip', 60000);
    const codexChip = await cdp.eval(`${bar(codexCoding.id)}.querySelector('.composer-scene').textContent`);
    check('Codex 编程会话的场景按钮显示编程开发', codexChip === '场景 · 编程开发', codexChip);
    await cdp.eval(`${bar(codexCoding.id)}.querySelector('.composer-scene').click()`);
    await until('document.querySelector(".composer-scene-popover:not([hidden]) [data-scene=tech]")', 'codex popover');
    await cdp.eval('document.querySelector(".composer-scene-popover:not([hidden]) [data-scene=tech]").click()');
    const codex = await untilValue(async () => (await sessionsNow()).find(s => s.purpose === 'scene-tech' && /codex/.test(s.kind)), 'codex tech session', 60000);
    const codexGone = await untilValue(async () => !(await sessionsNow()).some(s => s.id === codexCoding.id), 'codex empty removed', 20000).catch(() => false);
    check('Codex 空会话换成技术讨论', codexGone, codex.id);
    await sendViaComposer(codex.id, '（这是测试）只用一句话回答：你在这个会话里是什么身份？');
    const codexReply = await waitReply(codex.id, 6 * 60 * 1000);
    const codexRaw = fs.readFileSync(codexReply.s.transcriptPath, 'utf8');
    let base = '';
    try { base = ((JSON.parse(codexRaw.split('\n')[0]).payload || {}).base_instructions || {}).text || ''; } catch { /* 下面报 */ }
    const codexHits = CODING_MARKERS.filter(([, re]) => re.test(modelFacingText(codexReply.s.transcriptPath))).map(([n]) => n);
    check('Codex：基础指令就是技术讨论场景提示词', base.startsWith('# 场景：技术讨论') && base.includes('关于田哥'), base.slice(0, 30));
    check('Codex：会话记录在干净配置目录、没有编程上下文', /writing-codex-homes/.test(codexReply.s.transcriptPath) && codexHits.length === 0, `${codexHits.join('、') || '无'} · ${codexReply.s.transcriptPath}`);
    result.codexReply = codexReply.text;
    const warn = (await sessionsNow()).filter(s => s.writingContextWarning);
    check('没有场景降级提示', warn.length === 0, warn.map(s => s.writingContextWarning).join('；'));
    result.passed = result.checks.every((c) => c.ok);
  } catch (error) {
    result.error = String(error && error.stack || error);
    console.error(error);
    try { if (cdp) await shot('99-失败现场'); } catch { /* 页面已关 */ }
  } finally {
    try { if (hub && hub.log) fs.writeFileSync(path.join(root, 'hub.log'), hub.log().join('\n')); } catch { /* 无日志 */ }
    try { if (cdp) cdp.close(); } catch { /* 已断开 */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    try {
      const after = fs.readFileSync(path.join(codexHome, 'auth.json'));
      if (!after.equals(authOriginal) && fs.readFileSync(realAuth).equals(authOriginal)) { fs.writeFileSync(realAuth, after); result.authSyncedBack = true; }
    } catch { /* 读不到就不同步 */ }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`\n结果：${result.passed ? '全部通过' : '有失败'}，详情 ${path.join(root, 'result.json')}`);
    process.exitCode = result.passed ? 0 : 1;
  }
}

main();
