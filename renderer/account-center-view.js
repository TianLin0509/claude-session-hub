'use strict';
// Presentation only. The page shows each identity of the Hub Chrome (a cookie jar — one per
// account that needs its own login on the same site), the sites logged in there, and the
// command-line tools authorised from those logins. Nothing here decides anything.

// tone: ok = logged in, warn = needs you, idle = cannot tell right now.
function siteChip(site, now = Date.now(), running = false) {
  if (site.stale) return { tone: 'idle', text: `${site.name} · 上次${site.state === 'signed_in' ? '已登录' : '未确认'}`, action: '' };
  switch (site.state) {
    case 'signed_in':
      return { tone: 'ok', text: `${site.name} · 已确认`, action: '' };
    case 'cookie_present': return { tone: 'idle', text: `${site.name} · 有登录记录`, action: '' };
    case 'signed_out': return { tone: 'warn', text: `${site.name} · 需登录`, action: 'login' };
    case 'needs_attention': return { tone: 'warn', text: `${site.name} · 需人机验证`, action: 'login' };
    case 'login_open': return { tone: 'idle', text: `${site.name} · 登录窗口开着`, action: '' };
    case 'needs_browser': return { tone: 'idle', text: `${site.name} · 待检查`, action: 'check' };
    default: return { tone: 'idle', text: `${site.name} · 未确认`, action: 'check' };
  }
}
const CLI_STATE = { authorized: ' · 已配置', missing: ' · 未授权', expired: ' · 需重新授权', unreadable: ' · 凭据不可读', api_key: ' · 使用 API Key' };
function cliChip(cli) {
  const name = cli.kind === 'codex' ? `${cli.name}（${cli.label}）` : cli.name;
  const tone = cli.state === 'authorized' || cli.state === 'api_key' ? 'idle' : 'warn';
  return { tone, text: name + (CLI_STATE[cli.state] ?? ''), title: cli.account || '' };
}
function identityCards(state, now = Date.now()) {
  return (state.identities || []).map(identity => {
    const sites = identity.sites.map(s => ({ key: s.key, ...siteChip(s, now, !!state.chrome?.running) }));
    const clis = (state.clis || []).filter(c => c.identity === identity.id).map(c => ({ id: c.id, ...cliChip(c) }));
    return { id: identity.id, label: identity.label, account: identity.account || '', accountStale: !!identity.accountStale, sites, clis,
      attention: sites.filter(s => s.tone === 'warn').length + clis.filter(c => c.tone === 'warn').length };
  });
}
// Tools whose web login could not be placed yet (e.g. before the first check has learned
// which ChatGPT account each identity holds). Listed, never silently attached to one.
function unplacedClis(state) {
  return (state.clis || []).filter(c => !c.identity).map(c => ({ id: c.id, ...cliChip(c) }));
}
function attentionCount(state, now = Date.now()) {
  return identityCards(state, now).reduce((n, c) => n + c.attention, 0) + unplacedClis(state).filter(c => c.tone === 'warn').length;
}
module.exports = { siteChip, cliChip, identityCards, unplacedClis, attentionCount };
