'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REGISTRY_ROOT = path.join(os.homedir(), 'spirit-lens-registry');
const MAX_BUFFER = 16 * 1024 * 1024;

function registryRoot(env = process.env) {
  return path.resolve(env.SPIRIT_REGISTRY_ROOT || DEFAULT_REGISTRY_ROOT);
}

function pythonCandidates(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [...new Set([
    env.SPIRIT_PYTHON,
    env.PYTHON,
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
    'python',
  ].filter(Boolean))];
}

function runCli(command, {
  args = [], payload, env = process.env, root,
  timeoutMs = 15_000,
  spawnSyncImpl = spawnSync,
} = {}) {
  const effectiveRoot = path.resolve(root || registryRoot(env));
  const cliPath = path.join(effectiveRoot, 'cli', 'spirit.py');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`英灵注册表 CLI 不存在：${cliPath}`);
  }
  const cliArgs = [cliPath, '--registry', effectiveRoot, command, ...args];
  let lastError = null;
  for (const python of pythonCandidates(env)) {
    const result = spawnSyncImpl(python, cliArgs, {
      cwd: effectiveRoot,
      input: payload === undefined ? undefined : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...env, PYTHONUTF8: '1', SPIRIT_REGISTRY_ROOT: effectiveRoot },
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      shell: false,
      timeout: Math.max(1_000, Number(timeoutMs) || 15_000),
    });
    if (result.error && result.error.code === 'ENOENT') {
      lastError = result.error;
      continue;
    }
    if (result.error && result.error.code === 'ETIMEDOUT') {
      throw new Error(`英灵 CLI 超时（${Math.max(1_000, Number(timeoutMs) || 15_000)}ms）`);
    }
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`英灵 CLI 被信号终止：${result.signal}`);
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `英灵 CLI 退出码 ${result.status}`).trim());
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`英灵 CLI 返回非 JSON：${error.message}`);
    }
  }
  throw lastError || new Error('找不到可用的 Python 解释器。');
}

function list(options = {}) {
  return runCli('list', options);
}

function manifest(spiritId, { includeRules = true, ...options } = {}) {
  const args = ['--spirit', String(spiritId || '')];
  if (!includeRules) args.push('--summary');
  return runCli('manifest', { ...options, args });
}

function prepare(payload, options = {}) {
  return runCli('prepare', { ...options, args: ['--input', '-'], payload });
}

function validate(packet, result, options = {}) {
  return runCli('validate', {
    ...options,
    args: ['--input', '-'],
    payload: { packet, result },
  });
}

function appendAudit({ hubDataDir, meetingId, aiKind, action, packet, details = {} }) {
  if (!hubDataDir || !meetingId) return null;
  const dir = path.join(path.resolve(hubDataDir), 'arena-spirit-audit');
  fs.mkdirSync(dir, { recursive: true });
  const safeMeetingId = String(meetingId).replace(/[^A-Za-z0-9._-]/g, '_');
  const auditPath = path.join(dir, `${safeMeetingId}.jsonl`);
  const row = {
    schema_version: '1.0',
    created_at: new Date().toISOString(),
    meeting_id: String(meetingId),
    ai_kind: String(aiKind || 'unknown'),
    action: String(action || ''),
    packet_id: packet && packet.packet_id || null,
    mandate: packet && packet.mandate || null,
    spirit_ids: packet && packet.spirit_ids || [],
    manifest_hash: packet && packet.manifest_hash || null,
    evidence_snapshot_hash: packet && packet.evidence_snapshot_hash || null,
    prompt_hash: packet && packet.prompt_hash || null,
    details,
  };
  fs.appendFileSync(auditPath, JSON.stringify(row) + '\n', 'utf8');
  return auditPath;
}

module.exports = {
  DEFAULT_REGISTRY_ROOT,
  registryRoot,
  pythonCandidates,
  runCli,
  list,
  manifest,
  prepare,
  validate,
  appendAudit,
};
