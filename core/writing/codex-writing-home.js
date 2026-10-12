'use strict';
// core/writing/codex-writing-home.js
//
// 写作成员专用的 Codex 配置目录（2026-10-11 田哥要求：写作成员是写文章的，不带任何编程上下文）。
//
// Codex 会无条件读取 CODEX_HOME 下的全局 AGENTS.md（田哥的个人协作约定：回复格式、工程验证……），
// 0.159 没有关掉它的开关；记忆、技能清单、插件也都挂在 CODEX_HOME 上。所以写作成员换一个只为写作
// 准备的配置目录：
//   - 不放 AGENTS.md（Hub 的个人规则同步对写作成员只同步守卫 hooks，不写规则正文）
//   - config.toml 只留模型与接口（model / model_provider / model_providers.* 等），再关掉记忆、技能说明、
//     插件与项目文档；信任目录与 hook 信任仍由 Hub 照常写进来
//   - auth.json 用硬链接指向当前账号的同一个文件：Codex 刷新令牌是原地改写，硬链接两边始终是同一份，
//     与多个 Codex 会话共用一个账号目录的现状等价，不会出现两份令牌互相顶掉。链接若被别的程序换掉
//     （改名覆盖），下次启动时同一账号按 last_refresh 保留较新的一份；换了账号就直接链到新账号。
// 每个订阅账号各一个写作目录（codex-<账号目录名>-<哈希>）：几个账号共用一个的话，切换账号后旧账号仍在跑的
// 写作会话一刷新令牌，就会写进新账号的登录文件。换账号后恢复旧写作会话，由 Hub 现成的跨账号恢复
// （-c sqlite_home 指向原历史所在目录）接上。DeepSeek 用 key 不用登录，单独一个（deepseek）。
// 会话记录写在这个目录的 sessions/ 下，Hub 按 codexSessionsRoot 照常绑定。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scanTomlStatements } = require('../toml-statements');

const ROOT_DIR = 'writing-codex-homes';
// 写作成员要的只是模型与接口；这些表从原配置原样带过来
const KEEP_TABLES = new Set(['model_providers', 'windows', 'notice', 'tui']);
// Hub 在写作目录里自己维护的表（信任目录、hook 信任），重建配置时保留
const HUB_TABLES = new Set(['projects', 'hooks']);
// 根级键里这些不带：指令由 Hub 用 model_instructions_file 指定；功能开关由下面的写作设置给出（点号写法的
// features.x 与 [features] 表同时出现会让配置非法）；通知、插件、MCP、记忆是编程场景的东西
const DROP_ROOT = new Set(['developer_instructions', 'instructions', 'model_instructions_file', 'experimental_instructions_file',
  'compact_prompt', 'experimental_compact_prompt_file', 'notify', 'project_doc_max_bytes', 'project_doc_fallback_filenames',
  'include_permissions_instructions', 'include_collaboration_mode_instructions', 'include_apps_instructions',
  'features', 'skills', 'memories', 'mcp_servers', 'plugins', 'marketplaces', 'apps', 'agents']);

const WRITING_SETTINGS = `
project_doc_max_bytes = 0
include_permissions_instructions = false
include_collaboration_mode_instructions = false
include_apps_instructions = false

[features]
memories = false
apps = false
plugins = false
multi_agent = false
multi_agent_v2 = false
skill_search = false
skip_host_skill_discovery = true
image_generation = false
browser_use = false
browser_use_external = false
computer_use = false
goals = false
tool_suggest = false
remote_plugin = false
in_app_browser = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false
`;

function readText(file) { try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch { return ''; } }

// 按 TOML 语句挑出要留的块：根级键值整条保留（含多行数组、多行字符串）；表从表头起到下一个表头前整段保留。
function pickBlocks(text, keepRoot, keepTable) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const lines = src.split('\n');
  const statements = scanTomlStatements(src).statements;
  const headers = statements.filter((s) => s.kind !== 'kv');
  const blocks = [];
  for (const st of statements) {
    if (st.kind === 'kv' && st.table.length === 0 && keepRoot(st.path)) blocks.push(lines.slice(st.startLine, st.endLine + 1).join('\n'));
  }
  headers.forEach((h, i) => {
    if (!keepTable(h.path)) return;
    const end = i + 1 < headers.length ? headers[i + 1].startLine : lines.length;
    blocks.push(lines.slice(h.startLine, end).join('\n').trim());
  });
  return blocks;
}

function buildWritingConfig(sourceText, existingText) {
  const root = pickBlocks(sourceText, (p) => !DROP_ROOT.has(p[0]), () => false);
  const kept = pickBlocks(sourceText, () => false, (p) => KEEP_TABLES.has(p[0]));
  const hub = pickBlocks(existingText, () => false, (p) => HUB_TABLES.has(p[0]));
  return [
    '# 写作成员专用配置：由 Hub 按原账号配置生成（core/writing/codex-writing-home.js），每次启动刷新。',
    root.join('\n'),
    WRITING_SETTINGS.trim(),
    ...kept,
    ...hub,
  ].filter(Boolean).join('\n\n') + '\n';
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0n;
  } catch { return false; }
}

function accountOf(file) {
  try {
    const auth = JSON.parse(readText(file));
    return (auth.tokens && auth.tokens.account_id) || null;
  } catch { return null; }
}

function refreshedAt(file) {
  try {
    const value = JSON.parse(readText(file)).last_refresh;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  } catch { /* 退回文件时间 */ }
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 让写作目录的 auth.json 与原账号共用同一个文件。返回 linked / copied / none。 */
function linkAuth(sourceHome, home, logger = console) {
  const src = path.join(sourceHome, 'auth.json');
  const dst = path.join(home, 'auth.json');
  if (!fs.existsSync(src)) return 'none';
  if (fs.existsSync(dst) && sameFile(src, dst)) return 'linked';
  if (fs.existsSync(dst)) {
    // 链接被断开过：同一账号、写作这边刷新得更晚时，先把它写回原账号（原地写，不破坏原账号目录里的其他链接）。
    // 账号不同（田哥切换了账号）就不回写，直接改链到新账号。
    const account = accountOf(src);
    if (account && account === accountOf(dst) && refreshedAt(dst) > refreshedAt(src)) fs.writeFileSync(src, fs.readFileSync(dst));
    fs.unlinkSync(dst);
  }
  try {
    fs.linkSync(src, dst);
    return 'linked';
  } catch (error) {
    logger.warn('[writing] 登录文件没能硬链接，改为复制（令牌刷新后需要下次启动才同步）：', error.message);
    fs.copyFileSync(src, dst);
    return 'copied';
  }
}

/** 写作目录的位置：DeepSeek 一个；订阅账号按账号目录各一个。 */
function writingHomePath(family, hubDataDir, sourceHome) {
  const root = path.join(hubDataDir, ROOT_DIR);
  if (family === 'deepseek' || !sourceHome) return path.join(root, family === 'deepseek' ? 'deepseek' : 'codex');
  const resolved = path.resolve(sourceHome);
  const tag = crypto.createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 8);
  const name = path.basename(resolved).replace(/^\.+/, '').replace(/[^A-Za-z0-9_-]+/g, '-') || 'codex';
  return path.join(root, `codex-${name}-${tag}`);
}

/** 这个目录是不是某个写作目录（恢复写作会话时，原历史可能在另一个账号的写作目录里）。 */
function isWritingHome(dir, hubDataDir) {
  if (!dir || !hubDataDir) return false;
  const rel = path.relative(path.join(hubDataDir, ROOT_DIR), path.resolve(dir));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/** 写作目录里有没有这条会话的记录（升级前建的写作会话记录还在原账号目录，恢复时要回原目录找）。 */
function hasRollout(home, sid) {
  const id = String(sid || '').trim();
  if (!id) return false;
  const stack = [path.join(home, 'sessions')];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.name.endsWith('.jsonl') && entry.name.includes(id)) return true;
    }
  }
  return false;
}

/**
 * 按当前账号目录准备写作专用目录，返回它的路径。
 * @param sourceHome  原本要用的 CODEX_HOME（默认 ~/.codex、某个订阅账号目录或 DeepSeek 目录）
 * @param hubDataDir  Hub 数据目录
 * @param family      codex（订阅账号，按账号各一个）/ deepseek
 */
function prepareWritingCodexHome({ sourceHome, hubDataDir, family = 'codex', logger = console }) {
  if (!sourceHome || !hubDataDir) throw new Error('写作配置目录缺少原账号目录或 Hub 数据目录');
  const home = writingHomePath(family, hubDataDir, sourceHome);
  fs.mkdirSync(home, { recursive: true });
  const configFile = path.join(home, 'config.toml');
  const next = buildWritingConfig(readText(path.join(sourceHome, 'config.toml')), readText(configFile));
  if (readText(configFile) !== next) fs.writeFileSync(configFile, next, 'utf8');
  // 这个目录只给写作用：任何来源写进来的规则文件都不留
  for (const name of ['AGENTS.md', 'AGENTS.override.md', '.hub-user-context.json']) {
    try { fs.unlinkSync(path.join(home, name)); } catch { /* 不存在 */ }
  }
  // 模型清单缓存带过来：Hub 按它给上下文窗口定上限，首次启动没有它就按默认值算
  try {
    const cache = path.join(sourceHome, 'models_cache.json');
    if (fs.existsSync(cache)) fs.copyFileSync(cache, path.join(home, 'models_cache.json'));
  } catch { /* 只是缓存 */ }
  const auth = linkAuth(sourceHome, home, logger);
  return { home, auth };
}

module.exports = { prepareWritingCodexHome, buildWritingConfig, linkAuth, writingHomePath, isWritingHome, hasRollout, pickBlocks };
