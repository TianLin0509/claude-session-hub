'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 让 Claude Code 不再对 Hub 新建的工作区弹「Quick safety check」信任框。
//
// 2026-08-28 实测（Claude Code v2.1.251，node-pty 起真 CLI）：
//   * 空的临时目录不弹框；Hub 的 _scratch 工作区（git init + 播种的 AGENTS.md）
//     必弹 —— 用户报的「又不自动信任了」就是它。
//   * 往 ~/.claude.json 写 projects["<正斜杠 cwd>"].hasTrustDialogAccepted = true
//     之后，同一目录再起 CLI 直接进提示符，框完全不出现。
//
// 这是唯一无竞态的路径（PTY 探测那条只能在框已经画出来之后补救，且新版默认高亮
// 项是 "No, exit"）。代价是要碰共享的 ~/.claude.json，所以这里刻意写得很窄：
//   - 只补 projects[key].hasTrustDialogAccepted，不动 settings.json、不动
//     hasCompletedOnboarding / bypassPermissionsModeAccepted 等全局字段；
//   - 已经是 true 就直接返回，不产生写入；
//   - 解析不了就放弃，绝不用一份空对象覆盖用户配置；
//   - 文件不存在且用的是共享 home 配置时不凭空创建（那说明 CLI 还没初始化过）。

function toClaudeProjectKey(projectDir) {
  return path.resolve(projectDir || os.homedir()).replace(/\\/g, '/');
}

function claudeStatePathFor(configDir) {
  return configDir
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

function ensureClaudeProjectTrusted(projectDir, options = {}) {
  const {
    configDir = null,
    fsImpl = fs,
    logger = console,
  } = options;
  const statePath = claudeStatePathFor(configDir);
  const projectKey = toClaudeProjectKey(projectDir);

  try {
    let raw = null;
    try { raw = fsImpl.readFileSync(statePath, 'utf8'); } catch { raw = null; }
    if (raw === null && !configDir) {
      return { ok: false, changed: false, reason: 'state-missing', statePath, projectKey };
    }

    let state = {};
    if (raw !== null) {
      try { state = JSON.parse(raw); } catch {
        // 半截 / 损坏的 .claude.json 交给 CLI 自己修，Hub 覆盖只会放大事故。
        return { ok: false, changed: false, reason: 'unparsable-state', statePath, projectKey };
      }
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { ok: false, changed: false, reason: 'unexpected-state', statePath, projectKey };
    }
    if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) {
      state.projects = {};
    }

    const existing = state.projects[projectKey];
    if (existing && typeof existing === 'object' && existing.hasTrustDialogAccepted === true) {
      return { ok: true, changed: false, reason: 'already-trusted', statePath, projectKey };
    }

    state.projects[projectKey] = {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
      hasTrustDialogAccepted: true,
    };

    // 原子写。~/.claude.json 有 600KB+，直接就地写会让并发启动的 claude CLI 读到
    // 半截 JSON；tmp + rename 至少保证读到的永远是完整的一版。
    const tmpPath = `${statePath}.hub-${process.pid}-${Date.now()}.tmp`;
    fsImpl.mkdirSync(path.dirname(statePath), { recursive: true });
    fsImpl.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fsImpl.renameSync(tmpPath, statePath);
    return { ok: true, changed: true, statePath, projectKey };
  } catch (err) {
    logger.warn?.('[hub] ensureClaudeProjectTrusted failed:', err && err.message);
    return { ok: false, changed: false, reason: (err && err.message) || 'unknown', statePath, projectKey };
  }
}

module.exports = {
  claudeStatePathFor,
  ensureClaudeProjectTrusted,
  toClaudeProjectKey,
};
