'use strict';

const path = require('path');
const os = require('os');

function expandHomePath(value, homeDir = os.homedir()) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
  return raw;
}

function normalizePath(value) {
  if (!value) return '';
  try {
    return path.resolve(value);
  } catch {
    return String(value);
  }
}

function normalizeKey(value) {
  return normalizePath(value).toLowerCase();
}

function resolveSubscriptionProfile(config, homeDir) {
  const profiles = Array.isArray(config.codexSubscriptionProfiles)
    ? config.codexSubscriptionProfiles
    : [];
  const fallback = profiles.find(p => p && p.id === 'default')
    || { id: 'default', label: 'Main account', home: '' };
  const wanted = String(config.codexSubscriptionProfile || fallback.id || 'default').trim();
  const selected = profiles.find(p => p && p.id === wanted) || fallback;
  const home = normalizePath(expandHomePath(selected.home, homeDir));
  return {
    id: selected.id || 'default',
    label: selected.label || selected.name || selected.id || 'Codex',
    home,
  };
}

function resolveCodexUsageScope(config = {}, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const hubDataDir = opts.hubDataDir || path.join(homeDir, '.claude-session-hub');
  const backend = config.codexBackend === 'api' && config.codexApiKey ? 'api' : 'subscription';

  if (backend === 'api') {
    const home = normalizePath(path.join(hubDataDir, 'codex-api-profile'));
    const sessionsRoot = path.join(home, 'sessions');
    return {
      provider: 'codex',
      backend,
      profileId: 'api',
      profileLabel: 'API',
      home,
      sessionsRoot,
      scopeKey: `api:${normalizeKey(sessionsRoot)}`,
    };
  }

  const profile = resolveSubscriptionProfile(config, homeDir);
  const home = profile.home || path.join(homeDir, '.codex');
  const sessionsRoot = path.join(home, 'sessions');
  return {
    provider: 'codex',
    backend,
    profileId: profile.id,
    profileLabel: profile.label,
    home,
    sessionsRoot,
    scopeKey: `subscription:${profile.id}:${normalizeKey(sessionsRoot)}`,
  };
}

function sameCodexUsageScope(entry, scope) {
  if (!entry || !scope) return false;
  if (entry.scopeKey) return entry.scopeKey === scope.scopeKey;
  if (entry.codexScopeKey) return entry.codexScopeKey === scope.scopeKey;
  if (entry.sessionsRoot) return normalizeKey(entry.sessionsRoot) === normalizeKey(scope.sessionsRoot);
  // Legacy cache had no scope. It can only be trusted for the default account.
  return scope.backend === 'subscription' && scope.profileId === 'default';
}

function attachCodexUsageScope(data, scope) {
  return {
    ...(data || {}),
    provider: 'codex',
    backend: scope.backend,
    profileId: scope.profileId,
    profileLabel: scope.profileLabel,
    sessionsRoot: scope.sessionsRoot,
    scopeKey: scope.scopeKey,
  };
}

function filterUsageCacheForCodexScope(cache, scope) {
  const out = { ...(cache || {}) };
  if (out.codex && !sameCodexUsageScope(out.codex, scope)) {
    delete out.codex;
  }
  return out;
}

module.exports = {
  expandHomePath,
  resolveCodexUsageScope,
  sameCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
};
