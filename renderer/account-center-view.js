'use strict';
// Presentation only. The page shows each identity of the Hub Chrome (a cookie jar — one per
// account that needs its own login on the same site), the sites logged in there, and the
// command-line tools authorised from those logins. Nothing here decides anything.

function day(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
// tone: ok = logged in, warn = needs you, idle = cannot tell right now.
function siteChip(site, now = Date.now(), running = false) {
  const soon = site.expiresAt && site.expiresAt - now < 7 * 86400000;
  switch (site.state) {
    case 'signed_in':
      return { tone: soon ? 'warn' : 'ok', text: site.name + (site.expiresAt ? ` · 至 ${day(site.expiresAt)}` : ''), action: soon ? 'login' : '' };
    case 'signed_out': return { tone: 'warn', text: `${site.name} · 需登录`, action: 'login' };
    case 'needs_attention': return { tone: 'warn', text: `${site.name} · 需人机验证`, action: 'login' };
    case 'login_open': return { tone: 'idle', text: `${site.name} · 登录窗口开着`, action: '' };
    case 'needs_browser': return { tone: 'idle', text: `${site.name} · ${running ? '点「检查登录」确认' : '浏览器开着时可确认'}`, action: 'login' };
    default: return { tone: 'idle', text: `${site.name} · 未确认`, action: 'login' };
  }
}
const CLI_STATE = { authorized: '', missing: ' · 未授权', expired: ' · 需重新授权', unreadable: ' · 凭据不可读', api_key: ' · 使用 API Key' };
function cliChip(cli) {
  const name = cli.kind === 'codex' ? `${cli.name}（${cli.label}）` : cli.name;
  const tone = cli.state === 'authorized' || cli.state === 'api_key' ? 'ok' : 'warn';
  return { tone, text: name + (CLI_STATE[cli.state] ?? ''), title: cli.account || '' };
}
function identityCards(state, now = Date.now()) {
  return (state.identities || []).map(identity => {
    const sites = identity.sites.map(s => ({ key: s.key, ...siteChip(s, now, !!state.chrome?.running) }));
    const clis = (state.clis || []).filter(c => c.identity === identity.id).map(c => ({ id: c.id, ...cliChip(c) }));
    return { id: identity.id, label: identity.label, account: identity.account || '', sites, clis,
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
