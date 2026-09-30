'use strict';
// core/writing/draft-runner.js
//
// 起草、审阅、访谈提问用到的模型调用。核心原则（2026-09-26 盲测结论）：
// 起草时只带「起草指南 + 田哥文风 + 范文」，不带工程规则、工具、记忆与 skill 列表，
// 否则 AI 腔和层层免责就回来了。三家的干净配方都在盲测中实测过：
//
//   Claude    -p + --system-prompt-file，关工具、关 CLAUDE.md、关记忆、关内置 skill、
//             只读 local 设置、严格 MCP（=0 个）。实测输入约 1.7k token。
//   Codex     临时 CODEX_HOME：只放订阅登录的 auth.json 和一份最小 config.toml，
//             model_instructions_file 换掉基础指令，关 shell、web、skills、memories。
//   DeepSeek  直接调 Hub 已配置的百炼兼容接口，只有 system + user 两条消息。
//
// 计费纪律：Codex 只用订阅登录（auth_mode=chatgpt）。找不到订阅就拒绝，绝不回落到 API Key。
// 临时目录里若刷新了登录令牌，结束后同步回原配置，避免把用户的订阅登录顶掉。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ANGLES = [
  { key: 'scene', label: '从场景起笔', text: '用一个具体的场景或此刻正在发生的事起笔，第一句就把读者带到现场。' },
  { key: 'question', label: '从问题起笔', text: '用读者心里正在犯嘀咕的一个问题起笔，替读者问出来，再自问自答往前推。' },
  { key: 'surprise', label: '从反直觉起笔', text: '用一个反直觉的现象或结论起笔，先让读者吃一惊，再讲清为什么。' },
];

const SCRUB_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_HUB_', 'ANTHROPIC_'];
const SCRUB_EXACT = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'];

function cleanEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.NO_COLOR = '1';
  return env;
}

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), 'hub-writing', `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无妨 */ }
}

/* ─────────────── 可用性 ─────────────── */

function resolveClaudeExe(env = process.env) {
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir.replace(/^"|"$/g, ''), 'claude.exe');
    if (fs.existsSync(f)) return f;
  }
  const local = path.join(env.USERPROFILE || os.homedir(), '.local', 'bin', 'claude.exe');
  return fs.existsSync(local) ? local : null;
}

// 以 PATH 上的 codex.cmd 为准：它可能指向托管安装（C:\DevTools\Codex\<版本>\…\codex-managed.js），
// 而 npm 全局目录里的 @openai/codex 可能是没人用的旧版本（2026-09-30 实测 0.147.0，调不动 gpt-6-astra）。
function resolveCodexJs(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dirs = [...String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean), path.join(appData, 'npm')];
  for (const dir of dirs) {
    const shim = path.join(dir.replace(/^"|"$/g, ''), 'codex.cmd');
    try {
      const m = fs.readFileSync(shim, 'utf8').match(/"([^"]+\.js)"\s+%\*/);
      if (m) {
        const target = m[1].replace(/%dp0%\\?/i, dir + path.sep);
        if (fs.existsSync(target)) return target;
      }
    } catch { /* 这个目录没有 codex.cmd */ }
  }
  const js = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(js) ? js : null;
}

// 在 ~/.codex 与 ~/.codex-profiles/* 里找 auth_mode=chatgpt 的订阅登录
function findCodexSubscription(home = os.homedir()) {
  const candidates = [path.join(home, '.codex')];
  try {
    for (const d of fs.readdirSync(path.join(home, '.codex-profiles'), { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(path.join(home, '.codex-profiles', d.name));
    }
  } catch { /* 没有多账号目录 */ }
  for (const dir of candidates) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
      if (auth.auth_mode === 'chatgpt' && auth.tokens) {
        let model = 'gpt-6-astra';
        try {
          const m = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m);
          if (m) model = m[1];
        } catch { /* 用默认模型 */ }
        return { dir, model };
      }
    } catch { /* 这一处没有可用登录 */ }
  }
  return null;
}

function readDeepseekConfig(hubDataDir, home = os.homedir()) {
  const files = [hubDataDir && path.join(hubDataDir, 'config.json'), path.join(home, '.claude-session-hub', 'config.json')].filter(Boolean);
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      if (d.acp && d.acp.apiKey) {
        return { apiKey: d.acp.apiKey, baseURL: d.acp.baseURL || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' };
      }
    } catch { /* 下一个 */ }
  }
  return null;
}

function providerStatus({ hubDataDir, env = process.env } = {}) {
  const sub = findCodexSubscription(env.CLAUDE_HUB_HOME_DIR || os.homedir());
  const codexJs = resolveCodexJs(env);
  const claude = resolveClaudeExe(env);
  const ds = readDeepseekConfig(hubDataDir, env.CLAUDE_HUB_HOME_DIR || os.homedir());
  return [
    { id: 'claude', label: 'Claude', model: env.CLAUDE_HUB_WRITING_CLAUDE_MODEL || 'opus', available: !!claude, reason: claude ? '' : '找不到 claude.exe' },
    {
      id: 'codex', label: 'Codex', model: sub ? sub.model : '', effort: env.CLAUDE_HUB_WRITING_CODEX_EFFORT || 'high',
      available: !!(sub && codexJs),
      reason: !codexJs ? '找不到 Codex CLI' : !sub ? '没有订阅登录（只用订阅，不用 API Key）' : '',
    },
    { id: 'deepseek', label: 'DeepSeek', model: env.CLAUDE_HUB_WRITING_DEEPSEEK_MODEL || 'deepseek-v4-pro', available: !!ds, reason: ds ? '' : 'Hub 里没有配置 DeepSeek（百炼）密钥' },
    { id: 'gemini', label: 'Gemini', available: false, reason: '个人免费档已不支持 Gemini CLI，本机也没有 Gemini API key' },
    { id: 'kimi', label: 'Kimi', available: false, reason: '当前 Kimi Code 订阅对 kimi-for-coding 返回 403' },
  ];
}

/* ─────────────── 进程执行 ─────────────── */

function runProcess(cmd, args, { cwd, env, stdin, timeoutMs = 20 * 60 * 1000, signal, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let out = '';
    let err = '';
    let buf = '';
    let done = false;
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ code: -1, out, err: err + '\n超时' }); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { try { child.kill(); } catch {} finish({ code: -2, out, err: '已取消' }); });
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => finish({ code: -3, out, err: e.message }));
    child.on('close', (code) => finish({ code, out, err }));
    if (stdin != null) { child.stdin.write(stdin, 'utf8'); }
    child.stdin.end();
  });
}

async function runClaude({ system, user, model, signal, onProgress, env = process.env }) {
  const exe = resolveClaudeExe(env);
  if (!exe) throw new Error('找不到 claude.exe');
  const dir = tmpDir('claude');
  const sysFile = path.join(dir, 'system.md');
  fs.writeFileSync(sysFile, system, 'utf8');
  const runEnv = cleanEnv(env);
  Object.assign(runEnv, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' });
  const args = ['-p', '--system-prompt-file', sysFile, '--exclude-dynamic-system-prompt-sections', '--tools', '',
    '--setting-sources', 'local', '--settings', '{"alwaysThinkingEnabled":true}', '--model', model,
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  let text = '';
  let chars = 0;
  const meta = {};
  const r = await runProcess(exe, args, {
    cwd: dir, env: runEnv, stdin: user, signal,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        meta.clean = { tools: (ev.tools || []).length, mcp: (ev.mcp_servers || []).length, skills: (ev.skills || []).length, model: ev.model };
      }
      if (ev.type === 'stream_event' && ev.event && ev.event.delta && ev.event.delta.type === 'text_delta') {
        chars += ev.event.delta.text.length;
        if (onProgress) onProgress({ chars });
      }
      if (ev.type === 'result') { text = ev.result || ''; meta.usage = ev.usage; meta.isError = ev.is_error; }
    },
  });
  removeDir(dir);
  if (!text) throw new Error(`Claude 没有返回正文（退出码 ${r.code}）：${(r.err || '').slice(-300)}`);
  return { text, meta: { ...meta, inputTokens: meta.usage ? meta.usage.input_tokens + (meta.usage.cache_read_input_tokens || 0) + (meta.usage.cache_creation_input_tokens || 0) : null } };
}

function codexConfigToml({ model, effort, instructionsFile }) {
  return `model = "${model}"
model_reasoning_effort = "${effort}"
approval_policy = "never"
sandbox_mode = "read-only"
model_instructions_file = "${instructionsFile.replace(/\\/g, '/')}"
project_doc_max_bytes = 0
web_search = "disabled"

[features]
memories = false
hooks = false
plugins = false
apps = false
multi_agent = false
skill_search = false
skip_host_skill_discovery = true
image_generation = false
browser_use = false
browser_use_external = false
computer_use = false
goals = false
shell_tool = false
tool_suggest = false
remote_plugin = false
in_app_browser = false
multi_agent_v2 = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false
`;
}

async function runCodex({ system, user, effort = 'high', signal, onProgress, env = process.env }) {
  const sub = findCodexSubscription(env.CLAUDE_HUB_HOME_DIR || os.homedir());
  if (!sub) throw new Error('没有找到 Codex 订阅登录，拒绝运行（只用订阅，不用 API Key）');
  const codexJs = resolveCodexJs(env);
  if (!codexJs) throw new Error('找不到 Codex CLI');
  const home = tmpDir('codex-home');
  const cwd = tmpDir('codex-cwd');
  const authSrc = path.join(sub.dir, 'auth.json');
  const authOriginal = fs.readFileSync(authSrc, 'utf8');
  fs.writeFileSync(path.join(home, 'auth.json'), authOriginal, 'utf8');
  const sysFile = path.join(home, 'instructions.md');
  fs.writeFileSync(sysFile, system, 'utf8');
  fs.writeFileSync(path.join(home, 'config.toml'), codexConfigToml({ model: sub.model, effort, instructionsFile: sysFile }), 'utf8');
  const last = path.join(home, 'last.md');
  const runEnv = cleanEnv(env);
  runEnv.CODEX_HOME = home;
  const meta = { clean: { model: sub.model, profile: path.basename(sub.dir), auth: 'chatgpt' } };
  let events = 0;
  const r = await runProcess('node', [codexJs, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, '--json', '-o', last, '-'], {
    cwd, env: runEnv, stdin: user, signal,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      events += 1;
      if (onProgress) onProgress({ events });
      if (ev.type === 'turn.completed') meta.usage = ev.usage;
      if (ev.type === 'error' || ev.type === 'turn.failed') meta.error = JSON.stringify(ev).slice(0, 400);
    },
  });
  let text = '';
  try { text = fs.readFileSync(last, 'utf8'); } catch { /* 下面报错 */ }
  // 令牌在临时目录里被刷新过、而原配置期间没被别人改 → 同步回去
  try {
    const after = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
    const originalNow = fs.readFileSync(authSrc, 'utf8');
    if (after !== authOriginal && originalNow === authOriginal) {
      fs.writeFileSync(authSrc, after, 'utf8');
      meta.authSyncedBack = true;
    }
  } catch { /* 读不到就不同步 */ }
  removeDir(home);
  removeDir(cwd);
  if (!text.trim()) throw new Error(`Codex 没有返回正文（退出码 ${r.code}）：${meta.error || (r.err || '').slice(-300)}`);
  return { text, meta: { ...meta, inputTokens: meta.usage ? meta.usage.input_tokens : null } };
}

async function runDeepseek({ system, user, model = 'deepseek-v4-pro', signal, hubDataDir, env = process.env }) {
  const cfg = readDeepseekConfig(hubDataDir, env.CLAUDE_HUB_HOME_DIR || os.homedir());
  if (!cfg) throw new Error('Hub 里没有配置 DeepSeek（百炼）密钥');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20 * 60 * 1000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort());
  try {
    const resp = await fetch(cfg.baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`DeepSeek 返回 ${resp.status}：${JSON.stringify(data).slice(0, 300)}`);
    const text = (((data.choices || [])[0] || {}).message || {}).content || '';
    if (!text.trim()) throw new Error('DeepSeek 没有返回正文');
    return { text, meta: { usage: data.usage, inputTokens: data.usage ? data.usage.prompt_tokens : null, clean: { model: data.model || model } } };
  } finally {
    clearTimeout(timer);
  }
}

// provider: claude / codex / deepseek；opts 透传 model、effort、signal、onProgress、hubDataDir
async function runModel(provider, opts) {
  const status = providerStatus({ hubDataDir: opts.hubDataDir, env: opts.env || process.env }).find((p) => p.id === provider);
  if (!status) throw new Error(`未知模型 ${provider}`);
  if (!status.available) throw new Error(`${status.label} 不可用：${status.reason}`);
  if (provider === 'claude') return runClaude({ ...opts, model: opts.model || status.model });
  if (provider === 'codex') return runCodex({ ...opts, effort: opts.effort || status.effort });
  return runDeepseek({ ...opts, model: opts.model || status.model });
}

/* ─────────────── 提示词 ─────────────── */

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

function draftSystemPrompt({ paths, voice, angle }) {
  const guide = readText(paths.draftGuide);
  const { core, exemplars } = voice.draftContext();
  return [
    '你在替田哥起草一篇中文技术文章中的一节。田哥是作者，你写的是初稿，田哥会亲手改定。',
    '',
    '# 起草指南',
    guide,
    '',
    '# 田哥的文风',
    core,
    '',
    '# 田哥的范文（照着节奏和口吻写，不照搬内容）',
    exemplars,
    '',
    '# 这一份稿的切入方式',
    angle ? `${angle.label}：${angle.text}` : '按你认为最合适的方式起笔。',
    '',
    '# 输出',
    '直接输出 Markdown 正文。不要写前言、不要写写作说明、不要列出你遵循了哪些规则。',
  ].join('\n');
}

function draftUserPrompt(meta, briefText) {
  const b = meta.brief || {};
  return [
    briefText,
    '',
    `请写「${b.section || meta.title}」这一节，约 ${b.length || '1500-2500'} 字。`,
  ].join('\n');
}

function reviewSystemPrompt({ paths, voice }) {
  const guide = readText(paths.reviewGuide);
  const { core } = voice.draftContext({ groups: [] });
  return [
    '你是这篇文章的审阅者。只写批注，不改正文，不重写段落。',
    '',
    guide,
    '',
    '# 田哥的文风（用来判断哪里不像田哥）',
    core,
    '',
    '# 输出格式',
    '只输出一个 JSON 数组，不要任何别的文字。每个元素：',
    '{"anchor": "正文中的原句片段，10 到 20 个字，必须能在正文里逐字找到", "problem": "一句话说清问题", "basis": "依据", "suggestion": "改进方向或一句示范", "level": "必改|建议|可选", "category": "事实|论证|数学|读者体验|人味"}',
    '按严重程度排序，最多 12 条。',
  ].join('\n');
}

function parseReviewItems(text) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(arr) ? arr.filter((x) => x && x.problem).map((x, i) => ({ id: `r${i + 1}`, status: 'open', ...x })) : [];
  } catch { return []; }
}

function interviewPrompt(meta, briefText) {
  return {
    system: '你在帮田哥写文章前做访谈。目的是挖出只有田哥才有的东西：卡住过的地方、意外的发现、不同意的流行说法、只有田哥想得到的例子。只输出一个 JSON 字符串数组，3 到 5 个问题，每个问题一句话、具体、好回答。',
    user: `这是目前的 brief：\n\n${briefText}\n\n请提出问题。`,
  };
}

function parseQuestions(text) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try { const arr = JSON.parse(s.slice(a, b + 1)); if (Array.isArray(arr)) return arr.map(String).filter(Boolean).slice(0, 6); } catch { /* 退回按行切 */ }
  }
  return s.split(/\r?\n/).map((l) => l.replace(/^[-*\d.、\s]+/, '').trim()).filter((l) => l.length > 4).slice(0, 5);
}

module.exports = {
  ANGLES,
  cleanEnv,
  findCodexSubscription,
  resolveCodexJs,
  providerStatus,
  runModel,
  draftSystemPrompt,
  draftUserPrompt,
  reviewSystemPrompt,
  parseReviewItems,
  interviewPrompt,
  parseQuestions,
  codexConfigToml,
};
