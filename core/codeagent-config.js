'use strict';
// 公司内部 Code Agent CLI 的启动配置。
//
// 这个 CLI 的界面、配置文件、会话记录与 hook 都是 Claude Code 形态（2026-10-08 两轮公司实测），
// Hub 按 Claude 家族接入，只在这里集中描述它与 Claude 不同的地方：
//   - 命令名默认 `codeagent`（安装目录里的 .bat 包装，负责企业证书与代理环境）；
//   - 配置目录由 CODEAGENT3_CONFIG_DIR 指定，默认 ~/.cac（相当于 CLAUDE_CONFIG_DIR / ~/.claude）；Hub 启动会话时显式写这个变量，
//     个人账号目录本身不从 Hub 继承来的这个变量取（见 resolveCodeAgentConfig），
//     状态文件是 .cac.json（相当于 .claude.json）；
//   - 不认 --session-id 与 --settings：会话身份只能等第一个 hook 上报后绑定，Hub 的 hook
//     只能写进配置目录的 settings.json；
//   - 必须带 --disable-update，否则启动时弹出阻塞的「版本更新提醒」。
//
// 命令名、配置目录变量名和配置目录都可覆盖（AI_HUB_CODEAGENT_* 环境变量优先，其次 config.json 的
// providers.codeagent），没有这个 CLI 的电脑可以指向测试替身
// tests/fixtures/codeagent-standin/codeagent.cmd（内部启动真 Claude Code）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_COMMAND = 'codeagent';
const DEFAULT_CONFIG_ENV = 'CODEAGENT3_CONFIG_DIR';
const STATE_FILE = '.cac.json';
// 已知模型；公司内部还有 deepseek… 等名字，按字符校验放行（见 core/codeagent-models.js）。
const codeAgentModels = require('./codeagent-models');
const MODELS = Object.freeze(codeAgentModels.KNOWN.map(option => option.id));
const DEFAULT_MODEL = codeAgentModels.DEFAULT_MODEL;
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
// 实测能从 settings.json 触发的事件（公司探测第一轮 P5 与 CodeTeam 现有登记的并集）。
// 只登记这些，避免未知事件名让整份 settings.json 校验失败——这份文件同事的其他工具也在用。
const HOOK_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification']);

function hubProviderConfig() {
  try {
    const config = require('./hub-config').getConfig();
    const value = config && config.providers && config.providers.codeagent;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function configDirEnvName(env = process.env, provider = hubProviderConfig()) {
  const name = cleanString(env.AI_HUB_CODEAGENT_CONFIG_ENV) || cleanString(provider.configDirEnv) || DEFAULT_CONFIG_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`CodeAgent 配置目录变量名无效：${name}`);
  return name;
}

// 个人账号的配置目录只认三个来源（2026-10-19 公司真机事故后收紧）：AI_HUB_CODEAGENT_CONFIG_DIR、Hub 设置
// providers.codeagent.configDir、默认 ~/.cac。Hub 进程从启动它的环境里继承来的 CODEAGENT3_CONFIG_DIR 不再当个人目录——
// 公司 Hub 曾带着号池号 1 的目录启动（从某个 CodeAgent 会话的进程树里启动、之后的远程重启 / 更新又原样带下去），
// 结果「个人账号」会话全开在号 1 的目录里、号池同步又把号 1 的模型写回「个人」settings.json。
// 变量名本身照旧用：启动 CodeAgent 时由 Hub 把真正的配置目录显式写进这个变量。想用自定义个人目录就显式指定上面两项。
function resolveCodeAgentConfig(env = process.env, provider = hubProviderConfig()) {
  const command = cleanString(env.AI_HUB_CODEAGENT_COMMAND) || cleanString(provider.command) || DEFAULT_COMMAND;
  const configDirEnv = configDirEnvName(env, provider);
  if (/[\r\n"`$;&|<>]/.test(command)) throw new Error('CodeAgent 命令包含不允许的字符');
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const configDir = path.resolve(cleanString(env.AI_HUB_CODEAGENT_CONFIG_DIR) || cleanString(provider.configDir) || path.join(home, '.cac'));
  return { command, configDirEnv, configDir, stateFile: STATE_FILE };
}

// 比较两个目录是否同一个 / 互相包含：先 realpath（解开 junction、符号链接和 8.3 短名；目录还不存在时解开它最近的已存在上级），
// Windows 上再统一分隔符、转小写。只用于判定，不用于拼路径。
function canonicalDir(dir, { fsModule = fs, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let abs = p.resolve(String(dir || ''));
  const tail = [];
  for (let cur = abs; ;) {
    let real = null;
    try { real = (fsModule.realpathSync && (fsModule.realpathSync.native || fsModule.realpathSync))(cur); } catch { real = null; }
    if (typeof real === 'string' && real) { abs = tail.length ? p.join(real, ...tail.slice().reverse()) : real; break; }
    const parent = p.dirname(cur);
    if (parent === cur) break;
    tail.push(p.basename(cur));
    cur = parent;
  }
  if (platform === 'win32') abs = abs.replace(/\//g, '\\').replace(/^\\\\\?\\/, '').toLowerCase();
  const sep = platform === 'win32' ? '\\' : '/';
  while (abs.length > 1 && abs.endsWith(sep) && !/^[a-z]:\\$/i.test(abs)) abs = abs.slice(0, -1);
  return abs;
}
function sameDir(a, b, opts = {}) {
  if (!a || !b) return false;
  return canonicalDir(a, opts) === canonicalDir(b, opts);
}
// 相同，或一个在另一个里面
function dirsOverlap(a, b, opts = {}) {
  if (!a || !b) return false;
  const x = canonicalDir(a, opts), y = canonicalDir(b, opts);
  if (x === y) return true;
  const sep = (opts.platform || process.platform) === 'win32' ? '\\' : '/';
  const under = (child, parent) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  return under(x, y) || under(y, x);
}

// Hub 进程继承来的配置目录变量（已不再当个人目录）：没有返回 ''。
function inheritedConfigDir(env = process.env, provider = hubProviderConfig()) {
  let name;
  try { name = configDirEnvName(env, provider); } catch { return ''; }
  const value = cleanString(env[name]);
  return value ? path.resolve(value) : '';
}

// 个人账号配置目录从哪来（直查用，不带路径）：hub-env = AI_HUB_CODEAGENT_CONFIG_DIR；hub-config = config.json 的 providers.codeagent.configDir；
// default = ~/.cac；ignored-inherited-env = 默认 ~/.cac，并且 Hub 进程继承了一个指向别处的 CODEAGENT3_CONFIG_DIR（已忽略）。
// 2.1.14 以前继承来的值会被当成个人目录（当时这里报 codeagent-env）。
function configDirSource(env = process.env, provider = hubProviderConfig()) {
  if (cleanString(env.AI_HUB_CODEAGENT_CONFIG_DIR)) return 'hub-env';
  if (cleanString(provider.configDir)) return 'hub-config';
  const inherited = inheritedConfigDir(env, provider);
  if (inherited) {
    let personal = '';
    try { personal = resolveCodeAgentConfig(env, provider).configDir; } catch { personal = ''; }
    if (!sameDir(inherited, personal)) return 'ignored-inherited-env';
  }
  return 'default';
}

const INHERITED_NOTE = 'Hub 进程继承了一个指向别处的 CodeAgent 配置目录，已忽略';
// 继承来的配置目录和真正的个人目录不一样时给出说明（不带路径）；inPoolAccount：它落在哪个号池号的目录里（号的编号，调用方换成代称）。
// 一样或没有继承时返回 null。
function inheritedConfigDirInfo(env = process.env, provider = hubProviderConfig(), { dataDir = null } = {}) {
  const inherited = inheritedConfigDir(env, provider);
  if (!inherited) return null;
  let personal = '';
  try { personal = resolveCodeAgentConfig(env, provider).configDir; } catch { personal = ''; }
  if (personal && sameDir(inherited, personal)) return null;
  let variable = DEFAULT_CONFIG_ENV;
  try { variable = configDirEnvName(env, provider); } catch { /* 用默认名 */ }
  const out = { ignored: true, variable, note: INHERITED_NOTE, inPool: false, inPoolAccount: null };
  if (dataDir) {
    try {
      const match = require('./codeagent-pool').poolDirMatch(dataDir, inherited);
      out.inPool = !!match;
      out.inPoolAccount = match && match.id ? match.id : null;
    } catch { /* 读不了号池：只报已忽略 */ }
  }
  return out;
}

// PowerShell 里键入的命令头：普通命令名原样；带路径或空格的用调用运算符。
function commandHead(command) {
  if (/^[A-Za-z0-9_.-]+$/.test(command)) return command;
  return `& '${command.replace(/'/g, "''")}'`;
}

// 只查文件、不启动进程：命令是完整路径就看文件在不在；否则按 PATH + Windows 可执行扩展名找。
// 用于界面默认选中 CodeAgent（公司电脑），不作为能否登录或调用模型的证据。
function isCodeAgentInstalled(env = process.env, provider = hubProviderConfig()) {
  const fs = require('fs');
  let command;
  try { ({ command } = resolveCodeAgentConfig(env, provider)); } catch { return false; }
  const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (path.isAbsolute(command)) return exists(command);
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const dirs = String(env[pathKey] || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  return dirs.some(dir => exts.some(ext => exists(path.join(dir.replace(/^"|"$/g, ''), command + ext))));
}

function normalizeCodeAgentModel(model) {
  return codeAgentModels.normalizeModel(model);
}

// 模型菜单：已知模型 + 本机 CodeAgent 配置目录里的模型 + 回答里见过的模型（core/codeagent-models.js）。
function localModelOptions(dataDir, env = process.env) {
  let configDir = null;
  try { configDir = resolveCodeAgentConfig(env).configDir; } catch { configDir = null; }
  return codeAgentModels.modelOptions(dataDir, { configDir });
}

module.exports = {
  DEFAULT_COMMAND,
  DEFAULT_CONFIG_ENV,
  STATE_FILE,
  MODELS,
  DEFAULT_MODEL,
  EFFORTS,
  HOOK_EVENTS,
  resolveCodeAgentConfig,
  configDirEnvName,
  configDirSource,
  inheritedConfigDir,
  inheritedConfigDirInfo,
  INHERITED_NOTE,
  canonicalDir,
  sameDir,
  dirsOverlap,
  commandHead,
  normalizeCodeAgentModel,
  localModelOptions,
  isCodeAgentInstalled,
};
