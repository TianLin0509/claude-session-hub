'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getHubDataDir } = require('./data-dir.js');
const modelCatalog = require('./deepseek-codex-model-catalog.json');

const DEEPSEEK_CODEX_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_CODEX_BASE_URL = 'https://api.deepseek.com/';
const DEEPSEEK_CODEX_MIN_VERSION = '0.144.0';

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function toTomlPath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function getDeepSeekCodexHome(dataDir = getHubDataDir()) {
  return path.join(dataDir, 'deepseek-codex-profile');
}

function ensureDeepSeekCodexProfile(projectDir, opts = {}) {
  const codexHome = path.resolve(opts.codexHome || getDeepSeekCodexHome(opts.dataDir));
  const projectKey = path.resolve(projectDir || os.homedir());
  const catalogPath = path.join(codexHome, 'models.json');
  const configPath = path.join(codexHome, 'config.toml');
  const trustedProjectsPath = path.join(codexHome, 'trusted-projects.json');

  const flash = Array.isArray(modelCatalog.models)
    ? modelCatalog.models.find(item => item && item.slug === DEEPSEEK_CODEX_MODEL)
    : null;
  if (!flash) throw new Error(`DeepSeek Codex catalog missing ${DEEPSEEK_CODEX_MODEL}`);
  if (flash.minimal_client_version !== DEEPSEEK_CODEX_MIN_VERSION) {
    throw new Error(`DeepSeek Codex catalog requires unexpected client ${flash.minimal_client_version || '(missing)'}`);
  }

  fs.mkdirSync(codexHome, { recursive: true });
  let trustedProjects = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedProjectsPath, 'utf8'));
    if (Array.isArray(parsed)) trustedProjects = parsed.filter(item => typeof item === 'string' && item.trim());
  } catch {}
  const trustedByKey = new Map(trustedProjects.map(item => [path.resolve(item).toLowerCase(), path.resolve(item)]));
  trustedByKey.set(projectKey.toLowerCase(), projectKey);
  trustedProjects = [...trustedByKey.values()].sort((a, b) => a.localeCompare(b));

  fs.writeFileSync(catalogPath, `${JSON.stringify(modelCatalog, null, 2)}\n`, 'utf8');
  fs.writeFileSync(trustedProjectsPath, `${JSON.stringify(trustedProjects, null, 2)}\n`, 'utf8');
  const configLines = [
    'disable_response_storage = true',
    `model = ${tomlString(DEEPSEEK_CODEX_MODEL)}`,
    'model_provider = "deepseek"',
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    'model_reasoning_effort = "max"',
    `model_catalog_json = ${tomlString(toTomlPath(catalogPath))}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'project_root_markers = [".git", ".vibe-root"]',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    `base_url = ${tomlString(DEEPSEEK_CODEX_BASE_URL)}`,
    'env_key = "DEEPSEEK_API_KEY"',
    'wire_api = "responses"',
    '',
  ];
  for (const trustedProject of trustedProjects) {
    configLines.push(`[projects.${tomlString(trustedProject)}]`, 'trust_level = "trusted"', '');
  }
  fs.writeFileSync(configPath, configLines.join('\n'), 'utf8');

  return { codexHome, catalogPath, configPath, trustedProjectsPath, model: DEEPSEEK_CODEX_MODEL };
}

module.exports = {
  DEEPSEEK_CODEX_BASE_URL,
  DEEPSEEK_CODEX_MIN_VERSION,
  DEEPSEEK_CODEX_MODEL,
  ensureDeepSeekCodexProfile,
  getDeepSeekCodexHome,
};
