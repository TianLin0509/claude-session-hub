'use strict';
// Passive metadata only: no browser, prompts or credentials in the public result.
const fs = require('fs'), path = require('path');
const SITES = new Set([...require('./hub-account-catalog').COMPANIES.map(c => c.site), 'github', 'yuque']);
const SOURCES = new Set(['website', 'roundtable']);
function recordActivity(root, { identity = 'main', site, source = 'website', outcome, at = Date.now() }) {
  if (!['main', 'alt'].includes(identity) || !SITES.has(site) || !SOURCES.has(source)
      || !['opened', 'success', 'failed', 'login_required', 'verification_required'].includes(outcome) || !Number.isFinite(at)) throw Error('账号使用记录无效');
  const dir = path.join(root, 'account-activity'), file = path.join(dir, `${identity}-${site}-${source}.json`);
  fs.mkdirSync(dir, { recursive: true });
  let previous;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('账号使用记录无法读取'); }
  if (previous?.at > at) return;
  const value = { identity, site, source, outcome, at, lastSuccessAt: outcome === 'success' ? at : previous?.lastSuccessAt || 0 };
  const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8'); fs.renameSync(tmp, file);
}
function combine(rows) {
  const entries = {};
  for (const row of rows) {
    if (!row || !['main', 'alt'].includes(row.identity) || !SITES.has(row.site) || !Number.isFinite(row.at)) continue;
    const key = row.identity + ':' + row.site, previous = entries[key];
    const chosen = previous?.at > row.at ? previous : row;
    entries[key] = { identity: chosen.identity, site: chosen.site, source: chosen.source, outcome: chosen.outcome, at: chosen.at,
      lastSuccessAt: Math.max(previous?.lastSuccessAt || 0, row.lastSuccessAt || (row.outcome === 'success' ? row.at : 0)) };
  }
  return entries;
}
function imageActivity(root, env) {
  const isolated = env.CLAUDE_HUB_HOME_DIR || env.CLAUDE_HUB_DATA_DIR;
  const pool = isolated ? path.join(root, 'tool-fixtures/ChatGPTWebImagesPool') : env.CHATGPT_WEB_IMAGES_POOL || 'C:/VibeData/ChatGPTWebImagesPool';
  const database = path.join(pool, 'queue.sqlite3');
  if (!fs.existsSync(database)) return [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'tool-bindings.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const bindings = (manifest.tools || []).filter(b => b.tool === 'images' && ['main', 'alt'].includes(b.identity));
  if (!bindings.length) return [];
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=100');
    const accounts = db.prepare('SELECT id, config_dir FROM accounts').all(), rows = [];
    const latest = db.prepare("SELECT status, updated, error, result FROM jobs WHERE account_id=? AND status NOT IN ('queued','cancelled') ORDER BY updated DESC LIMIT 1");
    const successful = db.prepare("SELECT updated, result FROM jobs WHERE account_id=? AND status='complete' ORDER BY updated DESC LIMIT 1");
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    for (const account of accounts) {
      const binding = bindings.find(b => typeof b.config === 'string' && same(b.config, path.join(account.config_dir, 'settings.json')));
      if (!binding) continue;
      const config = JSON.parse(fs.readFileSync(binding.config, 'utf8'));
      if (config.cli_entry !== binding.entry) continue;
      const job = latest.get(account.id); if (!job) continue;
      const result = JSON.parse(job.result || '{}'), error = JSON.parse(job.error || 'null') || result.error;
      const outcome = ['login_required', 'credential_required', 'account_selection_required'].includes(error?.code) ? 'login_required'
        : error?.code === 'browser_challenge' ? 'verification_required' : error?.code === 'rate_limited' ? 'rate_limited'
        : job.status === 'complete' && result.files?.length ? 'success'
        : ['complete', 'failed', 'preparation_failed', 'needs_attention', 'parked', 'partial', 'count_mismatch'].includes(job.status) ? 'failed' : 'using';
      const last = successful.get(account.id);
      const lastSuccessAt = last && JSON.parse(last.result || '{}').files?.length ? last.updated * 1000 : 0;
      rows.push({ identity: binding.identity, site: 'chatgpt', source: 'images', outcome, at: job.updated * 1000, lastSuccessAt });
    }
    return rows;
  } finally { db.close(); }
}
function readActivity(root, env = process.env) {
  const rows = [], warnings = [], dir = path.join(root, 'account-activity');
  for (const identity of ['main', 'alt']) for (const site of SITES) for (const source of SOURCES) {
    try { rows.push(JSON.parse(fs.readFileSync(path.join(dir, `${identity}-${site}-${source}.json`), 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT' && !warnings.includes('部分使用记录无法读取')) warnings.push('部分使用记录无法读取'); }
  }
  try { rows.push(...imageActivity(root, env)); } catch { warnings.push('生图使用记录暂时无法读取'); }
  return { entries: combine(rows), warnings };
}
function recordWebJob(job, env = process.env) {
  const provider = job.input?.provider, site = provider === 'gemini' ? 'google' : provider;
  if (job.kind !== 'web' || !SITES.has(site) || !['succeeded', 'failed', 'needs_attention'].includes(job.state)) return;
  const { defaultRoot } = require('./hub-chrome');
  const outcome = job.state === 'succeeded' ? 'success' : job.recovery?.reason === 'login_required' ? 'login_required'
    : job.recovery?.reason === 'human_verification' ? 'verification_required' : 'failed';
  recordActivity(defaultRoot(env), { site, source: 'roundtable', outcome, at: Date.parse(job.updatedAt) });
}
module.exports = { recordActivity, readActivity, combine, imageActivity, recordWebJob };
