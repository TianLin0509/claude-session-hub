'use strict';
// core/memory-inspector.js
//
// 记忆面板的只读数据源：汇总各 CLI 的记忆/规则文件现状、seed 副本健康度、
// 梦境系统的配置与运行状态。只读不写——写的路在 dream-consolidation.js。

const fs = require('fs');
const path = require('path');
const os = require('os');

const { projectSlug } = require('./claude-transcript-locator.js');
const {
  DEFAULT_CONSOLIDATION_CONFIG,
  normalizeConsolidationConfig,
  seedCopyStatus,
  DREAM_BEGIN,
} = require('./dream-consolidation.js');

function statFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    let hasDreamSection = false;
    if (/\.md$/i.test(p) && st.size < 1024 * 1024) {
      try { hasDreamSection = fs.readFileSync(p, 'utf8').includes(DREAM_BEGIN); } catch {}
    }
    return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, hasDreamSection };
  } catch {
    return { path: p, exists: false };
  }
}

// 真实总数，不受 listMdFiles 的展示上限影响。
function countMdFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}

function listMdFiles(dir, limit = 50) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name))
      .map(e => {
        const fp = path.join(dir, e.name);
        const st = fs.statSync(fp);
        return { path: fp, name: e.name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function isSymlinkOrJunction(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Claude memory 桶全景：规范库 + 各 bucket 的链接/孤岛状态。
function inspectClaudeMemory(homeDir) {
  const canonical = path.join(homeDir, '.claude', 'projects', projectSlug(homeDir), 'memory');
  const canonicalFiles = listMdFiles(canonical);
  // listMdFiles 只回最近修改的 50 个（列表要能看），但面板标题得说真实总数——
  // 实测规范库有 206 篇，标题写「50 个文件」是错的。
  const canonicalTotal = countMdFiles(canonical);
  const buckets = [];
  for (const root of ['.claude', '.claude-deepseek']) {
    const projectsDir = path.join(homeDir, root, 'projects');
    let entries = [];
    try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const memoryDir = path.join(projectsDir, entry.name, 'memory');
      // 规范库自身不是孤岛——它是所有 junction 的目标。漏掉这个判定时它会以
      // 「孤岛」身份出现在面板上，一键并入会把规范库合并进自己（2026-08-01 E2E 抓出）。
      if (path.resolve(memoryDir) === path.resolve(canonical)) {
        buckets.push({ bucket: entry.name, root, status: 'canonical', path: memoryDir });
        continue;
      }
      let st = null;
      try { st = fs.lstatSync(memoryDir); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(memoryDir); } catch {}
        buckets.push({ bucket: entry.name, root, status: 'linked', path: memoryDir, target });
      } else if (st.isDirectory()) {
        const files = listMdFiles(memoryDir, 200);
        // 真实空目录不碍事，但也如实列出（它会在下次 spawn 时被换链）。
        // files 给面板做二级展开（前 30 个），fileCount 记真实总数。
        buckets.push({
          bucket: entry.name, root, path: memoryDir,
          status: files.length ? 'island' : 'empty-dir',
          fileCount: files.length,
          files: files.slice(0, 30),
        });
      }
    }
  }
  return {
    canonical: {
      path: canonical,
      exists: canonicalFiles.length > 0 || fs.existsSync(canonical),
      files: canonicalFiles,
      totalFiles: canonicalTotal,
    },
    buckets,
    islandCount: buckets.filter(b => b.status === 'island').length,
    linkedCount: buckets.filter(b => b.status === 'linked').length,
  };
}

// seed 副本全景：scratch 下有多少副本、多少被改过（知识待沉淀）。
function inspectSeedCopies(workspaceRoot) {
  const scratchRoot = path.join(workspaceRoot, '_scratch');
  const copies = [];
  let entries = [];
  try { entries = fs.readdirSync(scratchRoot, { withFileTypes: true }); } catch { return { scratchRoot, copies: [], modifiedCount: 0 }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentsPath = path.join(scratchRoot, entry.name, 'AGENTS.md');
    const status = seedCopyStatus(agentsPath);
    if (!status) continue;
    copies.push({ cwd: path.join(scratchRoot, entry.name), path: agentsPath, status });
  }
  return { scratchRoot, copies, modifiedCount: copies.filter(c => c.status === 'modified').length };
}

function readConsolidationState(hubDataDir) {
  const dir = path.join(hubDataDir, 'consolidation');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch {}
  let changelogCount = 0;
  let lastEntries = [];
  try {
    const lines = fs.readFileSync(path.join(dir, 'changelog.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    changelogCount = lines.length;
    lastEntries = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const staging = statFile(path.join(dir, 'staging.md'));
  return {
    dir,
    state,
    changelogCount,
    lastEntries: lastEntries.reverse(),
    staging,
  };
}

function readChangelog(hubDataDir, limit = 200) {
  const file = path.join(hubDataDir, 'consolidation', 'changelog.jsonl');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

function getOverview({ homeDir = os.homedir(), workspaceRoot, flatRoot = false, hubDataDir, consolidationConfig }) {
  const claudeMemory = inspectClaudeMemory(homeDir);
  const seedCopies = inspectSeedCopies(workspaceRoot);
  const consolidation = readConsolidationState(hubDataDir);
  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    flatRoot,
    userGlobalFiles: [
      { label: 'Kimi 全局', ...statFile(path.join(homeDir, '.kimi-code', 'AGENTS.md')) },
      { label: 'Claude 全局', ...statFile(path.join(homeDir, '.claude', 'CLAUDE.md')) },
      { label: 'Codex 全局', ...statFile(path.join(homeDir, '.codex', 'AGENTS.md')) },
      { label: 'Gemini 全局', ...statFile(path.join(homeDir, '.gemini', 'GEMINI.md')) },
    ],
    // 平铺模式下这三份是被 CLI 直接读取的（cwd 就是工作根），不是播种源。
    workspaceFiles: flatRoot
      ? [
        { label: '工作根 AGENTS.md（Codex / Kimi 直接读）', ...statFile(path.join(workspaceRoot, 'AGENTS.md')) },
        { label: '工作根 CLAUDE.md（Claude 直接读）', ...statFile(path.join(workspaceRoot, 'CLAUDE.md')) },
        { label: '工作根 GEMINI.md', ...statFile(path.join(workspaceRoot, 'GEMINI.md')) },
      ]
      : [
        { label: '工作区根 AGENTS.md（seed 源）', ...statFile(path.join(workspaceRoot, 'AGENTS.md')) },
        { label: '工作区根 CLAUDE.md（Claude 向上链）', ...statFile(path.join(workspaceRoot, 'CLAUDE.md')) },
        { label: '工作区根 GEMINI.md', ...statFile(path.join(workspaceRoot, 'GEMINI.md')) },
      ],
    claudeMemory,
    seedCopies,
    consolidation: {
      ...consolidation,
      config: normalizeConsolidationConfig(consolidationConfig),
      defaultConfig: DEFAULT_CONSOLIDATION_CONFIG,
    },
  };
}

// 某个 session cwd 的记忆视角：它实际会读到哪些规则文件、memory 落在哪个桶。
// kind 用于解释 memory 桶状态——Claude/DeepSeek 有 memory 机制（spawn 时 Hub 把桶
// junction 到规范库），Kimi/Codex/PowerShell 没有 memory 机制，「未创建」对它们是
// 正常态而非异常，共享记忆走 AGENTS.md 链。
function getSessionFiles({ cwd, kind, homeDir = os.homedir(), workspaceRoot }) {
  if (!cwd) return { cwd: null, files: [], memory: null };
  const resolved = path.resolve(String(cwd));
  const baseKind = String(kind || '').replace(/-resume$/, '');
  const claudeFamily = baseKind === 'claude' || baseKind === 'deepseek';
  const files = [];

  for (const p of [
    { label: 'Kimi 全局 AGENTS.md', path: path.join(homeDir, '.kimi-code', 'AGENTS.md') },
    { label: 'Claude 全局 CLAUDE.md', path: path.join(homeDir, '.claude', 'CLAUDE.md') },
    { label: 'Codex 全局 AGENTS.md', path: path.join(homeDir, '.codex', 'AGENTS.md') },
    { label: 'Gemini 全局 GEMINI.md', path: path.join(homeDir, '.gemini', 'GEMINI.md') },
    { label: '工作区根 AGENTS.md（seed 源）', path: path.join(workspaceRoot, 'AGENTS.md') },
    { label: '工作区根 CLAUDE.md', path: path.join(workspaceRoot, 'CLAUDE.md') },
    { label: '工作区根 GEMINI.md', path: path.join(workspaceRoot, 'GEMINI.md') },
  ]) {
    files.push({ ...p, ...statFile(p.path), role: 'global' });
  }

  // cwd 自己的 AGENTS.md：区分 Hub 托管副本（synced/modified）与项目自有（own）。
  const agentsPath = path.join(resolved, 'AGENTS.md');
  const agentsStatus = seedCopyStatus(agentsPath);
  files.push({
    label: '本目录 AGENTS.md',
    path: agentsPath,
    ...statFile(agentsPath),
    role: 'cwd',
    seedStatus: agentsStatus || 'missing',
  });
  files.push({
    label: '本目录 CLAUDE.md',
    path: path.join(resolved, 'CLAUDE.md'),
    ...statFile(path.join(resolved, 'CLAUDE.md')),
    role: 'cwd',
  });

  // Claude 向上链：从 cwd 到工作区根沿途的 CLAUDE.md。
  const chain = [];
  const rootResolved = path.resolve(workspaceRoot);
  for (let cur = resolved;;) {
    const p = path.join(cur, 'CLAUDE.md');
    const st = statFile(p);
    if (st && st.exists) chain.push({ path: p, size: st.size, mtime: st.mtime });
    if (cur.toLowerCase() === rootResolved.toLowerCase()) break;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }

  // memory 桶状态（两个 root 都看）。
  const slug = projectSlug(resolved);
  const memory = [];
  for (const root of ['.claude', '.claude-deepseek']) {
    const memoryDir = path.join(homeDir, root, 'projects', slug, 'memory');
    let status = 'missing';
    let target = '';
    try {
      const st = fs.lstatSync(memoryDir);
      if (st.isSymbolicLink()) {
        status = 'linked';
        try { target = fs.readlinkSync(memoryDir); } catch {}
      } else if (st.isDirectory()) {
        status = listMdFiles(memoryDir, 200).length ? 'island' : 'empty-dir';
      }
    } catch {}
    memory.push({ root, path: memoryDir, status, target });
  }

  const memoryNote = claudeFamily
    ? 'Claude/DeepSeek 会话在 spawn 时会自动把本 cwd 的 memory 桶链接到规范库；「未创建」说明该桶还没被消费（或会话尚未真正启动）。'
    : `${baseKind || '该'} CLI 没有 memory 机制——它读不到 Claude 的全局 memory 规范库，这是正常态。它的共享记忆通道是上方的 AGENTS.md/CLAUDE.md 规则文件链（梦境系统因此把通用规则沉淀到规则文件层，而不是只进 memory 库）。`;

  return { cwd: resolved, kind: baseKind, claudeFamily, files, claudeChain: chain, memory, memoryNote };
}

module.exports = {
  getOverview,
  getSessionFiles,
  readChangelog,
  inspectClaudeMemory,
  inspectSeedCopies,
};
