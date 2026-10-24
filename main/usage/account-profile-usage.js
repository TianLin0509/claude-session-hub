'use strict';

// Read existing account-scoped sources; never select a login to inspect its quota.
function createAccountProfileUsage(deps) {
  const errors = new Map();
  const checked = new Map();
  let flight = null;
  let flightKey = '';
  const pending = new Map();
  let otherError = '';
  const now = deps.now || Date.now;
  function publicRow(provider, profile, data = {}, extra = {}) {
    return { provider, profileId: profile.id, profileLabel: profile.label || profile.id,
      usage5h: data?.usage5h || null, usage7d: data?.usage7d || null,
      lastSeen: data?.observedAt || data?.lastSeen || data?.ts || 0, ...extra };
  }
  function list() {
    const claude = deps.claudeProfiles().map(profile => {
      try {
        const scope = deps.claudeScope(profile.id);
        return publicRow('claude', profile, deps.claudeCached(scope), {
          scope, selected: scope === deps.claudeScope(), error: errors.get(scope) || '',
        });
      } catch (error) { return publicRow('claude', profile, null, { error: error.message }); }
    });
    const current = deps.codexScope();
    const currentRow = publicRow('codex', { id: current.profileId, label: current.profileLabel }, deps.codexCached(),
      { scope: current.scopeKey, selected: true, apiKey: current.backend === 'api', error: errors.get(current.scopeKey) || '' });
    const order = deps.codexOrder();
    let otherRows;
    try { otherRows = deps.otherCodex(); }
    catch (error) { otherRows = order.filter(id => id !== current.profileId).map(profileId => ({ profileId, error: error.message })); }
    const others = otherRows.map(row => publicRow('codex', { id: row.profileId, label: row.profileLabel }, row,
      { scope: row.scopeKey, selected: false, apiKey: !!row.apiKey, error: row.error || otherError }));
    const rank = row => { const at = order.indexOf(row.profileId); return at < 0 ? order.length : at; };
    return { claude, codex: [currentRow, ...others].sort((a,b) => rank(a)-rank(b)) };
  }
  async function refreshOnce({ provider, profileId, force = false } = {}) {
    if (provider && !['claude', 'codex'].includes(provider)) throw new Error('不支持的账号类型');
    const rows = list();
    if (profileId && !rows[provider]?.some(row => row.profileId === profileId)) throw new Error('账号不存在，请刷新账号列表');
    const tasks = [];
    for (const row of rows.claude) {
      if (provider && provider !== 'claude' || profileId && profileId !== row.profileId || !row.scope) continue;
      if (!force && checked.has(row.scope) && now()-checked.get(row.scope)<120000) continue;
      tasks.push((async () => {
        checked.set(row.scope, now());
        try {
          const result = await deps.refreshClaude(row.scope);
          if (result?.source === 'claude-native' && (result.data?.usage5h || result.data?.usage7d)) errors.delete(row.scope);
        }
        catch (error) { errors.set(row.scope, error.message || '读取失败'); }
      })());
    }
    if (!provider || provider === 'codex') {
      const current = rows.codex.find(row => row.selected);
      if (current && !current.apiKey && (!profileId || current.profileId === profileId)
          && (force || !checked.has(current.scope) || now()-checked.get(current.scope)>=120000)) {
        tasks.push((async () => {
          checked.set(current.scope, now());
          try {
            const result = await deps.refreshCodex(force);
            if (result?.usage5h || result?.usage7d) errors.delete(current.scope);
          }
          catch (error) { errors.set(current.scope, error.message || '读取失败'); }
        })());
      }
      if (!profileId || current?.profileId !== profileId) tasks.push(Promise.resolve().then(() => deps.refreshOtherCodex({ force }))
        .then(() => { otherError = ''; }, error => { otherError = error.message || '读取失败'; }));
    }
    await Promise.all(tasks);
    return list();
  }
  function refresh(options = {}) {
    const key = `${options.provider || '*'}:${options.profileId || '*'}:${!!options.force}`;
    if (flight) {
      if (!options.force || key === flightKey) return flight;
      if (!pending.has(key)) pending.set(key, flight.catch(() => {}).then(() => { pending.delete(key); return refresh(options); }));
      return pending.get(key);
    }
    flightKey = key;
    flight = refreshOnce(options).finally(() => { flight = null; });
    return flight;
  }
  return { list, refresh };
}
module.exports = { createAccountProfileUsage };
