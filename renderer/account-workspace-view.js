'use strict';
const { companyCards, cliChip } = require('./account-center-view');
const TABS = [{ id: 'ai', name: 'AI 网页' }, { id: 'work', name: '工作平台' }, { id: 'content', name: '内容平台' }, { id: 'cli', name: '命令行授权' }, { id: 'api', name: 'API 与服务' }];
const GROUP = { github: 'work', yuque: 'work', social: 'content', mediaPublish: 'content' };
const BINDING = { shared: '共享专属 Chrome', bound: '已连接', changed: '连接配置已变化', pending: '尚未共享登录', native: '独立授权', host: '客户端授权' };
function relativeTime(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前';
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function usage(activity, now) {
  if (!activity) return { text: '暂无使用记录', tone: 'idle', login: false };
  const labels = { opened: '打开过网页', success: activity.source === 'images' ? '生图成功' : '使用成功', using: '正在使用',
    login_required: '需要登录', verification_required: '需要验证', rate_limited: '服务限流', failed: '上次使用未完成' };
  return { text: (relativeTime(activity.at, now) + ' · ' + (labels[activity.outcome] || '使用过')).trim(),
    tone: activity.outcome === 'success' ? 'ok' : ['failed', 'login_required', 'verification_required', 'rate_limited'].includes(activity.outcome) ? 'warn' : 'idle',
    login: ['login_required', 'verification_required'].includes(activity.outcome),
    note: activity.lastSuccessAt && activity.outcome !== 'success' ? '上次成功：' + relativeTime(activity.lastSuccessAt, now) : '',
    title: new Date(activity.at).toLocaleString('zh-CN') };
}
const matches = (values, query) => !query || values.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
function usageHtml(value, esc) {
  return `<div class="ac-usage ${value.tone}" title="${esc(value.title || '')}"><span>${esc(value.text)}</span>${value.note ? `<small>${esc(value.note)}</small>` : ''}</div>`;
}
function aiHtml(state, query, esc, now = Date.now()) {
  return companyCards(state).map(card => {
    const accounts = card.accounts.filter(a => matches([card.company, card.product, a.label, a.account], query));
    if (!accounts.length) return '';
    return `<article class="ac-company" data-site="${card.site}"><header><span class="ac-company-mark" style="--ac-mark:${card.color}">${esc(card.mark)}</span><h2>${esc(card.company)}</h2><span class="ac-count">${card.accounts.length} 个账号</span><kbd title="账号页内打开默认账号">Alt+${card.shortcut}</kbd></header>
      ${accounts.map(a => {
        const activity = usage(state.activity?.entries?.[a.identity + ':' + card.site], now);
        return `<div class="ac-account" data-identity="${a.identity}"><div class="ac-account-title"><strong>${esc(card.product)}</strong><span class="ac-account-name">${esc(a.account === '账号待确认' ? a.label : a.account)}</span>${a.preferred ? '<span class="ac-default">默认</span>' : ''}</div>
          ${usageHtml(activity, esc)}<div class="ac-row-actions"><button class="ac-open" data-ac="${activity.login ? 'login' : 'open'}" data-site="${card.site}" data-identity="${a.identity}" aria-label="打开 ${esc(card.product)} ${esc(a.label)}">${activity.login ? '去登录' : '打开'} ↗</button>
          <details class="ac-more" data-details="account-${card.site}-${a.identity}"><summary aria-label="${esc(card.product)} ${esc(a.label)}更多操作">···</summary><div>${!a.preferred ? `<button data-ac="preferred" data-site="${card.site}" data-identity="${a.identity}">设为默认账号</button>` : '<span>当前默认账号</span>'}${card.accounts.length < 2 ? `<button data-ac="add" data-site="${card.site}" data-identity="alt">添加第二个账号</button>` : ''}</div></details></div></div>`;
      }).join('')}</article>`;
  }).join('') || '<p class="ac-empty">没有匹配的账号</p>';
}
function cliHtml(state, query, esc) {
  const rows = (state.clis || []).filter(c => matches([c.name, c.label, c.account], query));
  return rows.map(c => `<article class="ac-account ac-standalone"><div class="ac-account-title"><strong>${esc(c.name)}</strong><span class="ac-account-name">${esc(c.account || c.label || '默认账号')}</span></div><div class="ac-usage ${cliChip(c).tone}">${esc(({ authorized: '已有授权记录', missing: '尚未授权', expired: '需要重新授权', unreadable: '授权记录不可读', api_key: '使用 API Key' })[c.state] || '授权待确认')}</div><div class="ac-row-actions"><button class="ac-open" data-ac="authorize" data-id="${esc(c.id)}">授权 ↗</button><button class="ac-text-btn" data-ac="config" data-id="${esc(c.kind)}">配置</button></div></article>`).join('') || '<p class="ac-empty">没有匹配的命令行账号</p>';
}
function serviceHtml(service, state, esc, now) {
  const value = usage(state.activity?.entries?.['main:' + service.id], now);
  const evidence = service.credential === 'read_error' ? '授权记录读取失败' : service.credential === 'record_found' ? '已有配置记录' : '由原工具管理';
  return `<article class="ac-service" data-account-service="${esc(service.id)}"><div class="ac-account"><div class="ac-account-title"><strong>${esc(service.name)}</strong></div>${service.website ? usageHtml(value, esc) : `<div class="ac-usage idle">${esc(evidence)}</div>`}<div class="ac-row-actions">${service.website ? `<button class="ac-open" data-ac="external" data-service="${esc(service.id)}" data-operation="open">打开 ↗</button>` : ''}<details class="ac-more" data-details="service-${esc(service.id)}"><summary aria-label="${esc(service.name)}详情">···</summary><div><span>${esc(BINDING[service.status] || '')}</span><p>${esc(service.help)}</p>${service.canAuthorize ? `<button data-ac="external" data-service="${esc(service.id)}" data-operation="authorize">授权 GitHub CLI ↗</button>` : ''}${(service.consumers || []).map(c => `<span>${esc(c.name)}</span>`).join('')}</div></details></div></div></article>`;
}
function servicesHtml(data, tab, query, state, esc, error, now = Date.now()) {
  if (error) return `<p class="ac-item-error" role="alert">${esc(error)} <button class="ac-text-btn" data-ac="tool-accounts-refresh">重试</button></p>`;
  if (!data) return '<p class="ac-empty" role="status">正在读取账号…</p>';
  const services = data.services.filter(s => !['images', 'bridge', 'roundtable'].includes(s.id) && (GROUP[s.id] || 'api') === tab && matches([s.name, ...(s.consumers || []).map(c => c.name)], query));
  return services.map(s => serviceHtml(s, state, esc, now)).join('') || '<p class="ac-empty">没有匹配的账号</p>';
}
function toolConnections(data, esc) {
  if (!data) return '';
  return data.services.filter(s => ['images', 'bridge', 'roundtable'].includes(s.id)).map(s => `<div class="ac-connection"><span>${esc(s.name)}</span><span>${esc(BINDING[s.status])}</span><small>${s.identities.map(i => (i.identity === 'main' ? '账号 1' : '账号 2')).join('、')}</small></div>`).join('');
}
module.exports = { TABS, relativeTime, usage, aiHtml, cliHtml, servicesHtml, toolConnections };
