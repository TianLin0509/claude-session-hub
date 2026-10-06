'use strict';
// Local metadata only. Reading this projection never launches a worker or a website.
const fs = require('fs'), path = require('path');
function json(file) { try { if (fs.statSync(file).size > 1024 * 1024) return {}; return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } }
function poolRoot(root, env = process.env) {
  return env.CLAUDE_HUB_HOME_DIR || env.CLAUDE_HUB_DATA_DIR ? path.join(root, 'tool-fixtures/ChatGPTWebImagesPool') : env.CHATGPT_WEB_IMAGES_POOL || 'C:/VibeData/ChatGPTWebImagesPool';
}
function imageStatus(root, env = process.env, now = Date.now()) {
  const pool = poolRoot(root, env), config = json(path.join(pool, 'codex-fallback.json')), health = json(path.join(pool, 'codex-lane-health.json'));
  const recent = Number.isFinite(health.beat) && now - health.beat * 1000 >= 0 && now - health.beat * 1000 < 30000;
  let alive = false; if (Number.isInteger(health.pid)) try { process.kill(health.pid, 0); alive = true; } catch {}
  let home = config.codex_home;
  if (config.follow_hub) {
    const hub = json(config.hub_config || path.join(env.CLAUDE_HUB_DATA_DIR || require('./data-dir').getHubDataDir(), 'config.json')).providers?.codex || {};
    try { home = hub.backend && hub.backend !== 'subscription' ? null : require('./codex-global-account').resolveAccount({codexSubscriptionProfile:hub.subscription_profile || 'default',codexSubscriptionProfiles:require('./hub-config').normalizeCodexSubscriptionProfiles(hub.subscription_profiles)},env).home; }
    catch { home = null; }
  }
  const subscription = typeof home === 'string' && json(path.join(home, 'auth.json')).auth_mode === 'chatgpt';
  const codex = { ready: config.enabled === true && subscription && recent && alive && !(health.degraded_until * 1000 > now) && !fs.existsSync(path.join(pool, 'stop-codex')),
    preferred: config.prefer === 'codex', version: typeof health.version === 'string' ? health.version.slice(0, 40) : '', lastSuccessAt: 0 };
  const result = { codex, web: [], pending: 0, readError: false };
  const database = path.join(pool, 'queue.sqlite3'); if (!fs.existsSync(database)) return result;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(database, { readOnly: true }); db.exec('PRAGMA busy_timeout=100');
    const successes = db.prepare("SELECT updated,result FROM jobs WHERE account_id='codex' AND status='complete' ORDER BY updated DESC LIMIT 20").all();
    const success = successes.find(row => { try { const r=JSON.parse(row.result); return r.provider === 'codex-imagegen' && r.files?.length; } catch { return false; } });
    codex.lastSuccessAt = success ? success.updated * 1000 : 0;
    const manifest = json(path.join(root, 'tool-bindings.json'));
    const gates = json(path.join(pool, 'human-gates.json')).gates || {};
    const accounts = db.prepare('SELECT id, config_dir, login_group, pid, enabled, ready, state, heartbeat, updated FROM accounts').all();
    for (const a of accounts) {
      const binding = (manifest.tools || []).find(b => b.tool === 'images' && typeof b.config === 'string' && path.resolve(b.config).toLowerCase() === path.resolve(a.config_dir, 'settings.json').toLowerCase());
      if (!binding || !require('./hub-tool-binding').matchesBinding(binding, json(binding.config))) continue;
      const count = db.prepare("SELECT count(*) n FROM jobs WHERE account_id=? AND status IN ('parked','needs_attention') AND cancel_requested=0").get(a.id).n;
      const guard=require('./web-risk-guard'), paused=guard.blocked(root,binding.identity,'chatgpt',now) || guard.handoff(root,now);
      const group=a.login_group || a.id, cooldown=db.prepare('SELECT retry_after FROM login_cooldowns WHERE login_group=?').get(group);
      const worker=json(path.join(pool,'worker-'+a.id+'-health.json'));
      const stalled=worker.pid === a.pid && worker.tick_started > worker.tick_finished && now - worker.tick_started * 1000 > 300000;
      const occupied=db.prepare("SELECT 1 FROM jobs WHERE account_id=? AND status='needs_attention' AND cancel_requested=0 LIMIT 1").get(a.id);
      result.web.push({ identity: binding.identity, enabled: !!a.enabled, ready: !!a.enabled && !!a.ready && !paused && !gates[group] && !stalled && !occupied && !(cooldown?.retry_after * 1000 > now) && now - a.heartbeat * 1000 < 20000 && now >= a.heartbeat * 1000,
        state: String(a.state || 'not_checked').slice(0, 60), checkedAt: a.updated * 1000, pending: count });
      result.pending += count;
    }
  } catch { result.readError = true; } finally { db?.close(); }
  return result;
}
function readWebTools({ root, env = process.env, recovery, now = Date.now() }) {
  let waiting = [], recoveryError = false;
  try { waiting = recovery?.list() || []; } catch { recoveryError = true; }
  return { images: imageStatus(root, env, now), roundtable: { providers: Object.keys(require('./web-roundtable/providers').providers), waiting, recoveryError } };
}
module.exports = { poolRoot, imageStatus, readWebTools };
