'use strict';
// Prompt 检视：还原「这个 cwd 下起一个会话时，CLI 会往 API 请求里注入什么」。
//
// 为什么是"还原"而不是"抓包"：抓真实请求体需要把 CLI 的 API 流量转发到本地代理
// （ANTHROPIC_BASE_URL / model_providers.base_url），那是在生产链路上动刀，风险独立。
// 而用户真正要判断的是「CLAUDE.md / memory 有没有正常注入」——这部分完全由本地文件
// 决定，可以确定性还原。两个 CLI 的发现算法已用抓包逐条实测确认（2026-07-28）：
//
//   Claude Code 2.1.220
//     - 只读 CLAUDE.md / CLAUDE.local.md，**从不自动读 AGENTS.md**
//     - 从 cwd 一路向上找到盘符根，**不受 git 边界限制**
//     - cwd 会被 canonicalize（junction 解析成真实路径）→ 记忆桶跟着真实路径走
//     - AGENTS.md 只能靠 CLAUDE.md 里的 `@AGENTS.md` import 进来，且 import 只支持相对路径
//   Codex CLI 0.144.0
//     - 只读 AGENTS.md，从 project root 向下收集到 cwd，**不越过 project root**
//     - project root = 向上找到第一个含 `project_root_markers` 标记的祖先（默认 [".git"]）
//     - cwd **不做** junction 解析
//
// 记忆桶 = ~/.claude/projects/<slug(realpath(cwd))>/memory，slug 规则见 projectSlug()。

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_GLOBAL_REL = ['.claude', 'CLAUDE.md'];
const CODEX_GLOBAL_REL = ['.codex', 'AGENTS.md'];
// 中文/全角字符会被 slug 规则压成短横，长度相同的中文目录名会塌缩到同一个桶。
const SLUG_COLLAPSE = /[^A-Za-z0-9]/g;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// Claude Code 的桶名算法：真实路径 → 非字母数字全部换成短横。
function projectSlug(p) {
  return path.resolve(String(p || '')).replace(SLUG_COLLAPSE, '-');
}

// junction / symlink 解析。路径不存在时退回原值（不抛）。
function realPath(p) {
  try {
    return fs.realpathSync.native(String(p || ''));
  } catch {
    return String(p || '');
  }
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function readText(file, maxBytes = 262144) {
  try {
    const buf = fs.readFileSync(file);
    return buf.slice(0, maxBytes).toString('utf8');
  } catch {
    return null;
  }
}

// cwd → 盘符根的所有祖先，从外到内（Claude 的注入顺序就是这个方向）。
function ancestorsOutsideIn(dir) {
  const out = [];
  let cur = path.resolve(dir);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return out.reverse();
}

// `@relative/path.md` 一级展开。Claude 实测只认相对路径，绝对路径原样留在 prompt 里。
function expandImports(text, baseDir) {
  const imports = [];
  if (!text) return imports;
  const re = /^@([^\s]+)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1];
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/') || spec.startsWith('\\');
    const resolved = isAbsolute ? spec : path.resolve(baseDir, spec);
    const size = statSize(resolved);
    imports.push({
      spec,
      resolved,
      absolute: isAbsolute,
      exists: size >= 0,
      bytes: size < 0 ? 0 : size,
      // 绝对路径不会被展开——这是实测结论，标出来让用户一眼看到问题
      effective: !isAbsolute && size >= 0,
    });
  }
  return imports;
}

// ---------- Claude 侧 ----------
function discoverClaudeChain(cwd) {
  const real = realPath(cwd);
  const entries = [];
  const seen = new Set();

  const pushFile = (file, source) => {
    const key = file.toLowerCase();
    if (seen.has(key)) return;
    const bytes = statSize(file);
    if (bytes < 0) return;
    seen.add(key);
    const text = readText(file);
    entries.push({
      path: file,
      source,
      bytes,
      imports: expandImports(text, path.dirname(file)),
    });
  };

  pushFile(path.join(homeDir(), ...CLAUDE_GLOBAL_REL), 'user-global');
  for (const dir of ancestorsOutsideIn(real)) {
    pushFile(path.join(dir, 'CLAUDE.md'), 'project');
    pushFile(path.join(dir, 'CLAUDE.local.md'), 'local');
  }
  return { realCwd: real, junctionResolved: path.resolve(real).toLowerCase() !== path.resolve(cwd).toLowerCase(), entries };
}

// AGENTS.md 存在但同目录既没有 CLAUDE.md、也没有任何 CLAUDE.md 用 @ 引它 → Claude 读不到。
function findOrphanAgentsMd(cwd, chain) {
  const real = realPath(cwd);
  const imported = new Set();
  for (const e of chain) {
    for (const im of e.imports) {
      if (im.effective) imported.add(im.resolved.toLowerCase());
    }
  }
  const orphans = [];
  for (const dir of ancestorsOutsideIn(real)) {
    const agents = path.join(dir, 'AGENTS.md');
    if (statSize(agents) < 0) continue;
    if (imported.has(agents.toLowerCase())) continue;
    orphans.push({ path: agents, bytes: statSize(agents) });
  }
  return orphans;
}

// ---------- Codex 侧 ----------
function readCodexRootMarkers() {
  const cfg = readText(path.join(homeDir(), '.codex', 'config.toml'), 65536) || '';
  const m = cfg.match(/^\s*project_root_markers\s*=\s*\[([^\]]*)\]/m);
  if (!m) return { markers: ['.git'], configured: false };
  const markers = m[1].split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return { markers: markers.length ? markers : ['.git'], configured: true };
}

function discoverCodexChain(cwd) {
  const { markers, configured } = readCodexRootMarkers();
  // Codex 不解析 junction —— 故意用字面 cwd
  const literal = path.resolve(cwd);
  let projectRoot = null;
  let cur = literal;
  for (;;) {
    if (markers.some(mk => statSize(path.join(cur, mk)) >= 0 || fs.existsSync(path.join(cur, mk)))) {
      projectRoot = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }

  const entries = [];
  const globalAgents = path.join(homeDir(), ...CODEX_GLOBAL_REL);
  if (statSize(globalAgents) >= 0) {
    entries.push({ path: globalAgents, source: 'user-global', bytes: statSize(globalAgents) });
  }
  // 找不到 marker 时 Codex 只看 cwd 自己
  const dirs = projectRoot
    ? ancestorsOutsideIn(literal).filter(d => d === projectRoot || d.startsWith(projectRoot + path.sep))
    : [literal];
  for (const dir of dirs) {
    const f = path.join(dir, 'AGENTS.md');
    const b = statSize(f);
    if (b >= 0) entries.push({ path: f, source: 'project', bytes: b });
  }
  return { literalCwd: literal, projectRoot, markers, markersConfigured: configured, entries };
}

// ---------- 记忆 ----------
function inspectMemory(cwd, configDirName = '.claude') {
  const real = realPath(cwd);
  const slug = projectSlug(real);
  const bucket = path.join(homeDir(), configDirName, 'projects', slug);
  const memDir = path.join(bucket, 'memory');
  const canonical = path.join(homeDir(), configDirName, 'projects', projectSlug(homeDir()), 'memory');

  const out = {
    slug,
    bucket,
    memoryDir: memDir,
    canonicalDir: canonical,
    state: 'NOBUCKET',
    isLink: false,
    linkTarget: null,
    files: 0,
    indexBytes: 0,
    indexPath: path.join(memDir, 'MEMORY.md'),
    sharesCanonical: false,
  };

  let st = null;
  try { st = fs.lstatSync(memDir); } catch { return out; }
  out.isLink = st.isSymbolicLink();
  if (out.isLink) {
    try { out.linkTarget = fs.readlinkSync(memDir); } catch { out.linkTarget = null; }
  }
  let names = [];
  try { names = fs.readdirSync(memDir).filter(n => n.toLowerCase().endsWith('.md')); } catch { names = []; }
  out.files = names.length;
  out.indexBytes = Math.max(0, statSize(out.indexPath));
  out.sharesCanonical = realPath(memDir).toLowerCase() === realPath(canonical).toLowerCase();

  if (out.isLink) out.state = 'LINKED';
  else if (out.files === 0) out.state = 'EMPTY_REAL';
  else out.state = 'PRIVATE_REAL';
  return out;
}

// ---------- 体检 ----------
function buildHealth(insp) {
  const checks = [];
  const push = (level, title, detail) => checks.push({ level, title, detail });

  const chain = insp.claude ? insp.claude.entries : [];
  if (insp.kind === 'claude' || insp.kind === 'deepseek' || insp.kind === 'kimi') {
    if (chain.length === 0) {
      push('bad', 'CLAUDE.md 一份都没读到', '这个 cwd 向上到盘符根都没有 CLAUDE.md，模型只有内置系统提示词。');
    } else {
      const total = chain.reduce((s, e) => s + e.bytes, 0);
      push('ok', `CLAUDE.md 链 ${chain.length} 份`, `共 ${total} 字节，从外到内注入。`);
    }
    const badImports = chain.flatMap(e => e.imports).filter(im => im.absolute);
    if (badImports.length) {
      push('bad', `${badImports.length} 处 @import 用了绝对路径`,
        `实测 Claude 的 @import 只认相对路径，绝对路径会原样留在 prompt 里不展开：${badImports[0].spec}`);
    }
    if (insp.orphanAgents && insp.orphanAgents.length) {
      push('warn', `${insp.orphanAgents.length} 份 AGENTS.md 读不到`,
        `Claude 从不自动读 AGENTS.md。在同目录加一个 CLAUDE.md 写 @AGENTS.md 才会生效：${insp.orphanAgents[0].path}`);
    }
  }

  if (insp.kind === 'codex') {
    const cx = insp.codex || { entries: [] };
    if (!cx.projectRoot) {
      push('warn', '没找到 project root 标记',
        `markers=[${cx.markers.join(', ')}]，向上都没命中 → Codex 只读 cwd 自己的 AGENTS.md。`);
    } else {
      push('ok', `project root = ${cx.projectRoot}`, `markers=[${cx.markers.join(', ')}]，从这一层向下收集。`);
    }
    push(cx.entries.length ? 'ok' : 'bad', `AGENTS.md ${cx.entries.length} 份`,
      cx.entries.length ? `共 ${cx.entries.reduce((s, e) => s + e.bytes, 0)} 字节。` : '一份都没读到。');
    if (insp.claude && insp.claude.junctionResolved) {
      push('warn', 'cwd 走的是 junction',
        `Codex 不解析 junction，记忆与会话会按字面路径 ${cx.literalCwd} 记账，而不是真实路径 ${insp.claude.realCwd}。`);
    }
  }

  const mem = insp.memory;
  if (mem.state === 'LINKED' || mem.sharesCanonical) {
    push('ok', '记忆已接入规范库', `${mem.files} 条 · 索引 ${mem.indexBytes} 字节`);
  } else if (mem.state === 'PRIVATE_REAL') {
    push('warn', `记忆是独立的 ${mem.files} 条`, `这个桶没链到规范库，跨项目记忆读不到。桶：${mem.slug}`);
  } else if (mem.state === 'EMPTY_REAL') {
    push('bad', '记忆目录是空的真实目录',
      'Hub 的链接逻辑遇到已存在目录会跳过 → 这个桶永远不会共享规范库。删掉空目录后重开会话即可修复。');
  } else {
    push('warn', '还没有记忆桶', '首次会话会新建一个空目录；若不经 Hub 启动就会变成上面那种「永久不共享」状态。');
  }

  if (insp.slugCollapsed) {
    push('warn', '目录名含非 ASCII，桶名已塌缩',
      `${mem.slug} —— 同一父目录下字数相同的中文名会撞进同一个桶，会话与记忆会混。`);
  }
  return checks;
}

function buildInspection(opts = {}) {
  const cwd = opts.cwd || homeDir();
  const kind = (opts.kind || 'claude').toLowerCase();
  const configDirName = kind === 'deepseek' ? '.claude-deepseek' : '.claude';

  const claude = discoverClaudeChain(cwd);
  const orphanAgents = findOrphanAgentsMd(cwd, claude.entries);
  const codex = discoverCodexChain(cwd);
  const memory = inspectMemory(cwd, configDirName);
  const slugCollapsed = /--{2,}|-{3,}/.test(memory.slug);

  const insp = { cwd, kind, claude, codex, orphanAgents, memory, slugCollapsed };
  insp.health = buildHealth(insp);

  const ruleBytes = kind === 'codex'
    ? codex.entries.reduce((s, e) => s + e.bytes, 0)
    : claude.entries.reduce((s, e) => s + e.bytes, 0);
  insp.totals = {
    ruleBytes,
    memoryIndexBytes: memory.indexBytes,
    memoryFiles: memory.files,
    // 粗估：混合中英按 3.2 字节/token，仅用于量级参考
    approxRuleTokens: Math.round(ruleBytes / 3.2),
  };
  return insp;
}

module.exports = {
  projectSlug,
  realPath,
  ancestorsOutsideIn,
  expandImports,
  discoverClaudeChain,
  discoverCodexChain,
  findOrphanAgentsMd,
  readCodexRootMarkers,
  inspectMemory,
  buildHealth,
  buildInspection,
};
