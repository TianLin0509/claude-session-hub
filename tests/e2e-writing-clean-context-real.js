'use strict';
/**
 * 写作成员上下文干净度真机 E2E（2026-10-11 田哥要求：写作成员完全为写作而生，不带编程上下文）。
 *
 * 隔离 Hub + 写作 Tab 真实操作：写中心思想、点「开始写」，后台建三人写作群（Claude haiku、Codex、DeepSeek），
 * 各交一份短稿。然后翻每位成员的原生记录与启动命令，逐项核对：
 *   Claude   启动带 --system-prompt-file（文章目录 AGENTS.md）、--disable-slash-commands、--tools；
 *            会话记录里没有 Lintian-Plain 输出风格、技能清单、浏览器说明、个人协作约定
 *   Codex /  会话记录写在 Hub 数据目录的 writing-codex-homes 下；基础指令是「写作须知」；
 *   DeepSeek 没有个人协作约定（全局 AGENTS.md）、记忆说明、技能清单、权限与协作模式说明
 *   三位     都按格式交了稿（drafts/<成员>-v1.md）
 *
 * 数据：文风 skill、个人规则复制到临时目录；Codex 登录文件复制一份给测试账号目录（临时目录在 D 盘，
 * 硬链接不能跨盘），写作目录再硬链接到这份；结束时若令牌被刷新过、真实账号期间没变，就原地写回。
 * DeepSeek key 与代理从生产配置只读取这两项写进测试配置。账号检查用测试夹具，不打开真实登录页。
 * 用法：node tests/e2e-writing-clean-context-real.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const REAL_SKILLS = path.join(os.homedir(), '.codex', 'skills');
const REAL_CODEX = path.join(os.homedir(), '.codex');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) { if (e.name !== 'backups') copyTree(s, d); }
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// 编程上下文的标志：出现任何一个就算没洗干净
const CODING_MARKERS = [
  ['个人协作约定', /个人协作约定/],
  ['白话解读规则', /白话解读/],
  ['Lintian-Plain 输出风格', /Lintian-Plain|Output Style:/],
  ['技能清单', /<skills_instructions>|Available skills|The following skills are available/],
  ['记忆说明', /## Memory\b|memory folder with guidance/],
  ['浏览器自动化说明', /Claude in Chrome browser automation|claude-in-chrome/],
  ['编程助手基础指令', /You are Codex, an agent|You are an interactive agent that helps users with software engineering/],
  ['权限说明', /<permissions instructions>/],
  ['协作模式说明', /<collaboration_mode>/],
];

// 只查真正发给模型的内容：Codex 是基础指令与 developer / user 消息（turn_context 里的元数据不发给模型）；
// Claude 是 prompt_snapshot 里的系统提示和各类附件。Claude Code 订阅登录必带的一行身份声明（cliPrefix）不算。
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

function scanTranscript(file) {
  const text = modelFacingText(file);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { size: text.length, hits: CODING_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name), text: raw };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-writing-clean-'));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const writingRoot = path.join(root, 'writing');
  const codexHome = path.join(root, 'codex-home');
  for (const p of [data, home, writingRoot, codexHome, path.join(writingRoot, '田哥材料', '文章')]) fs.mkdirSync(p, { recursive: true });
  const skills = path.join(home, '.codex', 'skills');
  copyTree(path.join(REAL_SKILLS, 'tiange-voice'), path.join(skills, 'tiange-voice'));
  copyTree(path.join(REAL_SKILLS, 'chinese-tech-writing', 'references'), path.join(skills, 'chinese-tech-writing', 'references'));
  // 个人规则照真实的放一份：非写作会话会同步它，写作成员必须看不到
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.agents', 'USER_CONTEXT.md'), path.join(home, '.agents', 'USER_CONTEXT.md'));
  // 测试用 Codex 账号目录：配置复制，登录文件硬链接（只有一份令牌）
  fs.copyFileSync(path.join(REAL_CODEX, 'config.toml'), path.join(codexHome, 'config.toml'));
  const realAuth = path.join(REAL_CODEX, 'auth.json');
  const authOriginal = fs.readFileSync(realAuth);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), authOriginal);
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), fs.readFileSync(path.join(home, '.agents', 'USER_CONTEXT.md')));
  const prod = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub', 'config.json'), 'utf8').replace(/^﻿/, ''));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ proxy: prod.proxy, providers: { deepseek: (prod.providers || {}).deepseek } }, null, 2));
  const piecesRoot = path.join(writingRoot, '写作台');

  const result = { root, checks: [], passed: false };
  const check = (name, ok, detail) => { result.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
  let hub; let cdp;
  const until = async (expr, label, ms = 35000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cdp.eval(`Boolean(${expr})`)) return; await sleep(500); }
    throw new Error('timeout: ' + label);
  };
  const untilFs = async (fn, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(2000); } throw new Error('timeout: ' + label); };
  const pieceDir = () => { try { return fs.readdirSync(piecesRoot).map((n) => path.join(piecesRoot, n)).find((d) => fs.existsSync(path.join(d, 'piece.json'))); } catch { return null; } };

  try {
    hub = await launchIsolatedHub({
      dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'writing-clean',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_ACCOUNT_FIXTURE: path.resolve(__dirname, 'fixtures', 'account-center-cli.js'),
        CLAUDE_HUB_WRITING_ROOT: writingRoot, CODEX_HOME: codexHome,
        CLAUDE_HUB_WRITING_MEMBERS: 'claude:haiku,codex,deepseek', CLAUDE_HUB_WRITING_EVOLVE_MODEL: 'haiku',
      },
    });
    cdp = await connectFirstPage(hub);
    await until('typeof window.__writingShow === "function"', 'writing.js loaded', 60000);
    await cdp.eval('document.getElementById("btn-writing").click()');
    await until('document.querySelector("#wr-view-studio.active .wb-compose-text")', 'composer', 30000);
    await cdp.eval('document.querySelector(".wb-compose-text").focus()');
    await cdp.send('Input.insertText', { text: '中心思想：同一个模型换进不同的命令行外壳，表现会差很多，原因常常不在模型本身，而在外壳替它定下的输出上限和思考强度。读者是天天用 AI 写代码的工程师。这次是测试，写 200 字左右的短文就好。' });
    await sleep(300);
    await cdp.eval('[...document.querySelectorAll("#writing-panel button")].find(b=>b.textContent.trim()==="开始写"&&!b.disabled).click()');
    await until('document.querySelector(".wb .wb-title")', 'workbench mounted', 120000);
    const meeting = await cdp.eval('ipcRenderer.invoke("get-meetings").then(ms=>ms.find(m=>m.scene==="writing"))');
    check('写作 Tab 建好三人写作群', !!meeting && (meeting.subSessions || []).length === 3, meeting && `${meeting.id}，${(meeting.subSessions || []).length} 位成员`);
    if (!meeting || (meeting.subSessions || []).length !== 3) throw new Error('写作群成员不足三位');
    const dir = pieceDir();
    const pack = path.join(dir, 'AGENTS.md');
    const packText = fs.readFileSync(pack, 'utf8');
    check('写作须知以「你是谁」开头，不含个人协作约定', packText.startsWith('# 写作须知') && packText.includes('## 你是谁') && !/个人协作约定|白话解读/.test(packText));

    // Claude 的真实启动命令
    const claudeCmd = await untilFs(() => {
      try {
        const outp = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'claude%' or Name like 'node%'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true });
        return outp.split(/\r?\n/).find((l) => l.includes('--system-prompt-file') && l.includes(path.basename(dir))) || null;
      } catch { return null; }
    }, 'claude cmdline', 90000).catch(() => '');
    check('Claude 启动：整份换成写作须知、关技能和浏览器扩展、只留写作工具', /--system-prompt-file/.test(claudeCmd) && /--disable-slash-commands/.test(claudeCmd) && /--no-chrome/.test(claudeCmd)
      && /--tools/.test(claudeCmd) && !/--append-system-prompt-file/.test(claudeCmd), claudeCmd.slice(0, 200));

    // 三份稿
    const names = ['Claude-1', 'Codex-2', 'DeepSeek-3'];
    const drafts = await untilFs(() => {
      const ok = names.map((n) => path.join(dir, 'drafts', `${n}-v1.md`)).filter((f) => fs.existsSync(f));
      return ok.length === names.length ? ok : null;
    }, 'three drafts', 20 * 60 * 1000).catch(() => names.map((n) => path.join(dir, 'drafts', `${n}-v1.md`)).filter((f) => fs.existsSync(f)));
    check('三位都交了稿', drafts.length === 3, drafts.map((f) => path.basename(f)).join('、'));
    result.drafts = drafts.map((f) => ({ file: f, head: fs.readFileSync(f, 'utf8').slice(0, 300) }));

    const sessions = await cdp.eval(`ipcRenderer.invoke("get-sessions").then(ss=>ss.filter(s=>s.meetingId===${JSON.stringify(meeting.id)}).map(s=>({title:s.title,kind:s.kind,purpose:s.purpose,transcriptPath:s.transcriptPath,mcpProfile:s.mcpProfile})))`);
    result.sessions = sessions;
    for (const s of sessions) {
      const scan = scanTranscript(s.transcriptPath || '');
      check(`${s.title}：会话记录里没有编程上下文`, scan.size > 0 && scan.hits.length === 0, scan.hits.length ? `混进来：${scan.hits.join('、')}` : `${scan.size} 字记录已查`);
      if (s.kind !== 'claude') {
        check(`${s.title}：会话记录在写作专用目录`, /writing-codex-homes/.test(s.transcriptPath || ''), s.transcriptPath);
        const meta = (scan.text.split('\n')[0] || '{}');
        let base = '';
        try { base = ((JSON.parse(meta).payload || {}).base_instructions || {}).text || ''; } catch { /* 下面报 */ }
        check(`${s.title}：基础指令就是写作须知`, base.startsWith('# 写作须知'), base.slice(0, 40));
      }
      check(`${s.title}：标记为写作成员、不带 MCP`, s.purpose === 'writing' && (s.kind === 'claude' || s.mcpProfile === 'none'), `${s.purpose}/${s.mcpProfile}`);
    }
    const codexWritingHome = (fs.readdirSync(path.join(data, 'writing-codex-homes')).find((n) => n.startsWith('codex-')) || 'codex');
    const linked = path.join(data, 'writing-codex-homes', codexWritingHome, 'auth.json');
    const same = (() => { try { const a = fs.statSync(linked, { bigint: true }); const b = fs.statSync(path.join(codexHome, 'auth.json'), { bigint: true }); return a.ino === b.ino; } catch { return false; } })();
    check('写作目录的 Codex 登录文件与账号目录是同一个文件（硬链接）', same);
    check('写作目录里没有全局规则文件', !fs.existsSync(path.join(data, 'writing-codex-homes', codexWritingHome, 'AGENTS.md')) && !fs.existsSync(path.join(data, 'writing-codex-homes', 'deepseek', 'AGENTS.md')));
    result.passed = result.checks.every((c) => c.ok);
  } catch (error) {
    result.error = String(error && error.stack || error);
    console.error(error);
  } finally {
    try { if (cdp && !result.passed) result.uiText = await cdp.eval('(document.getElementById("writing-panel")||document.body).innerText.slice(0,1500)'); } catch { /* 页面已关 */ }
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
