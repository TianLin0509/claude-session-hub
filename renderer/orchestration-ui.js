'use strict';
// AI 编排模式的界面（2026-10-04）。复用群聊现有位置：输入框上方状态条、展开区（计划账本）、
// 回答卡片的标签与按钮。状态只读主进程推送的账本视图，操作都走 orchestration:* 接口。
const { ipcRenderer } = require('electron');

const views = new Map();
const expanded = new Set();
const loading = new Set();
let onChange = () => {};

const STATUS_LABELS = {
  planning: '等编排员提交计划', awaiting_confirm: '计划待确认', running: '编排中', halted: '已暂停 · 等你决定',
  finished: '已结项', ended: '编排已结束（普通群聊）',
};
const GRANT_ROUNDS = 3, GRANT_MINUTES = 60;

function init(handler) {
  if (typeof handler === 'function') onChange = handler;
}
ipcRenderer.on('orchestration:changed', (_event, payload = {}) => {
  if (!payload.meetingId) return;
  views.set(payload.meetingId, payload.view || null);
  onChange(payload.meetingId);
});

function enabled(meeting) { return !!(meeting && meeting.groupChat && meeting.orchestration && meeting.orchestration.enabled === true); }
function view(meeting) {
  if (!enabled(meeting)) return null;
  if (!views.has(meeting.id) && !loading.has(meeting.id)) {
    loading.add(meeting.id);
    ipcRenderer.invoke('orchestration:view', { meetingId: meeting.id }).then(result => {
      loading.delete(meeting.id);
      if (result && result.ok) { views.set(meeting.id, result.view || null); onChange(meeting.id); }
    }, () => loading.delete(meeting.id));
  }
  return views.get(meeting.id) || null;
}
// 编排生效中（结束编排后回到普通群聊路由）。
function active(meeting) {
  if (!enabled(meeting)) return false;
  const v = view(meeting);
  return !v || v.status !== 'ended';
}
function orchestratorMemberId(meeting) { return meeting?.orchestration?.memberId || ''; }
function orchestratorSid(meeting) {
  const sid = meeting?.orchestration?.sessionId;
  return sid && (meeting.subSessions || []).includes(sid) ? sid : '';
}
function memberIdForSid(meeting, sid) {
  const index = (meeting.subSessions || []).indexOf(sid);
  return index >= 0 ? (meeting.slotSpecs?.[index]?.memberId || `m${index + 1}`) : '';
}

// 收件人：默认只发给编排员；@成员 时直接发给被点名的成员（并抄送编排员）。
function resolveRecipients(meeting, text, titleOf = () => '') {
  const orchSid = orchestratorSid(meeting);
  const mentions = [...String(text || '').matchAll(/@([A-Za-z0-9_\-一-鿿]+)/g)].map(m => m[1].toLowerCase());
  const direct = [];
  const sids = [];
  if (mentions.length) {
    (meeting.subSessions || []).forEach((sid, index) => {
      if (sid === orchSid) return;
      const memberId = meeting.slotSpecs?.[index]?.memberId || `m${index + 1}`;
      const kind = String(meeting.slotSpecs?.[index]?.kind || '').toLowerCase();
      const title = String(titleOf(sid) || '').toLowerCase();
      const aliases = new Set([memberId.toLowerCase(), title, title.replace(/\s+/g, ''), kind && `${kind}${index + 1}`].filter(Boolean));
      if (mentions.some(m => aliases.has(m) || m === 'all' || m === '全部' || m === '所有人')) { sids.push(sid); direct.push(memberId); }
    });
  }
  if (sids.length) return { sids, direct, toOrchestrator: false };
  return { sids: orchSid ? [orchSid] : [], direct: [], toOrchestrator: true };
}

function noteUserMessage(meeting, text, direct) {
  return ipcRenderer.invoke('orchestration:user-message', { meetingId: meeting.id, text, direct }).then(result => {
    if (result && result.ok && result.view) { views.set(meeting.id, result.view); onChange(meeting.id); }
    return result;
  }, () => null);
}

async function act(meeting, action, extra = {}) {
  const result = await ipcRenderer.invoke('orchestration:action', { meetingId: meeting.id, action, ...extra });
  if (!result || !result.ok) throw new Error((result && result.error) || '操作失败');
  views.set(meeting.id, result.view || null);
  onChange(meeting.id);
  return result.view;
}

function budgetText(v) {
  if (!v) return '';
  return `${v.budget.roundsUsed}/${v.budget.roundCap} 轮 · ${v.budget.minutesUsed}/${v.budget.minutesCap} 分钟`;
}
function budgetRatio(v) {
  if (!v) return 0;
  return Math.min(1, Math.max(v.budget.roundsUsed / Math.max(1, v.budget.roundCap), v.budget.minutesUsed / Math.max(1, v.budget.minutesCap)));
}
function stripButtons(v) {
  const b = (action, label, extra = '') => `<button type="button" data-orch-action="${action}"${extra}>${label}</button>`;
  const ledgerBtn = `<button type="button" data-orch-ledger aria-expanded="${v && expanded.has(v.meetingId)}">${v && expanded.has(v.meetingId) ? '收起账本' : '计划账本'}</button>`;
  if (!v) return ledgerBtn;
  const budgetHalt = v.status === 'halted' && /^budget_/.test(v.halt?.reason || '');
  if (v.status === 'ended') return b('resume', '恢复编排');
  if (v.status === 'awaiting_confirm') return b('confirm', '确认计划', ' class="primary"') + ledgerBtn + b('end', '结束编排');
  if (budgetHalt) return b('grant-rounds', `再给 ${GRANT_ROUNDS} 轮`, ' class="primary"') + b('grant-minutes', `再给 ${GRANT_MINUTES} 分钟`) + ledgerBtn + b('end', '结束编排');
  if (v.status === 'halted') return b('resume', '恢复编排', ' class="primary"') + ledgerBtn + b('end', '结束编排');
  if (v.status === 'running') return ledgerBtn + b('pause', '暂停') + b('end', '结束编排');
  return ledgerBtn + b('end', '结束编排');
}

function ledgerPanel(v, escapeHtml) {
  if (!v) return '<div class="mr-orch-ledger"><div class="mr-orch-muted">正在读取计划账本…</div></div>';
  const rows = v.segments.length ? v.segments.map(s => `<tr>
      <td>${escapeHtml(s.name)}<div class="mr-orch-muted">${escapeHtml(s.presetLabel)}</div></td>
      <td>${escapeHtml((s.members || []).map(id => `${id}${v.roles?.[id]?.role ? ' ' + v.roles[id].role : ''}`).join(' / '))}</td>
      <td><span class="mr-orch-pill s-${escapeHtml(s.status)}">${escapeHtml(s.statusLabel)}</span>${s.error ? `<div class="mr-orch-muted">${escapeHtml(s.error)}</div>` : ''}</td>
      <td>${s.verdictPath ? `<code title="${escapeHtml(s.verdictPath)}">${escapeHtml(s.verdictPath.split(/[\\/]/).slice(-3).join('/'))}</code>` : '<span class="mr-orch-muted">—</span>'}</td>
      <td>${s.rounds}</td></tr>`).join('')
    : '<tr><td colspan="5" class="mr-orch-muted">还没有工作段</td></tr>';
  const plan = v.plan ? `<div class="mr-orch-plan"><strong>计划 v${v.plan.version}</strong>${v.plan.confirmedVersion === v.plan.version ? '<span class="mr-orch-pill s-passed">已确认</span>' : '<span class="mr-orch-pill s-paused">待确认</span>'}
      <div class="mr-orch-plan-text">${escapeHtml(v.plan.summary)}</div></div>` : '<div class="mr-orch-muted">编排员还没有提交计划。</div>';
  const report = v.lastReport ? `<div class="mr-orch-report"><strong>最近汇报</strong>（${escapeHtml(v.lastReport.kind)}）<div class="mr-orch-plan-text">${escapeHtml(v.lastReport.summary)}</div></div>` : '';
  return `<div class="mr-orch-ledger" id="mr-orch-ledger">
    <div class="mr-orch-ledger-title"><strong>计划账本</strong><span class="mr-orch-muted">由 Hub 按工作流结果更新，编排员不能直接把状态改成「通过」</span><code class="mr-orch-ledger-file" title="${escapeHtml(v.ledgerFile || '')}">orchestration/ledger.md</code></div>
    ${plan}
    <table class="mr-orch-table"><thead><tr><th>工作段</th><th>负责人</th><th>状态</th><th>审核结论</th><th>已用轮次</th></tr></thead><tbody>${rows}</tbody></table>
    ${report}
  </div>`;
}

function renderStrip(row, meeting, { escapeHtml, onError = () => {}, focusInput = () => {} } = {}) {
  const v = view(meeting);
  const status = v ? v.status : 'planning';
  const halted = status === 'halted';
  const label = halted && v.halt ? `已暂停 · ${v.halt.label}` : (STATUS_LABELS[status] || status);
  const ratio = budgetRatio(v);
  const orchSid = orchestratorSid(meeting);
  const runText = v?.run ? ` · 当前：${v.run.stage || '工作流'}${v.run.status === 'paused' ? '（已暂停）' : ''}` : '';
  row.innerHTML = `<section class="mr-orch-strip${halted ? ' is-halted' : ''}" data-orch-status="${escapeHtml(status)}" aria-label="编排进度">
      <div class="mr-orch-main">
        <strong class="mr-orch-label">编排 · ${escapeHtml(label)}</strong>
        ${v && status !== 'ended' ? `<span class="mr-orch-budget"><span class="mr-orch-bar"><i style="width:${Math.round(ratio * 100)}%"></i></span>${escapeHtml(budgetText(v))}</span>` : ''}
        <span class="mr-orch-muted">${escapeHtml(runText)}${status !== 'ended' && orchSid ? ' · 发送给编排员（@成员 可直接点名）' : ''}</span>
      </div>
      <div class="mr-orch-actions">${stripButtons(v)}</div>
    </section>${v && expanded.has(meeting.id) ? ledgerPanel(v, escapeHtml) : ''}`;
  row.querySelectorAll('[data-orch-action]').forEach(btn => btn.addEventListener('click', () => handleAction(meeting, btn.dataset.orchAction, { onError, focusInput })));
  row.querySelector('[data-orch-ledger]')?.addEventListener('click', () => {
    if (expanded.has(meeting.id)) expanded.delete(meeting.id); else expanded.add(meeting.id);
    onChange(meeting.id);
  });
}

async function handleAction(meeting, action, { onError = () => {}, focusInput = () => {} } = {}) {
  try {
    if (action === 'revise') return focusInput('计划要改：');
    if (action === 'adjust') return focusInput('调整：');
    if (action === 'grant-rounds') return await act(meeting, 'grant', { rounds: GRANT_ROUNDS });
    if (action === 'grant-minutes') return await act(meeting, 'grant', { minutes: GRANT_MINUTES });
    return await act(meeting, action);
  } catch (error) { onError(error.message); return null; }
}

// 回答卡片：角色标签；编排员最新一张卡片在需要你决定时带操作按钮。
function roleBadge(meeting, message, escapeHtml) {
  if (!enabled(meeting) || !message || message.role !== 'assistant') return '';
  const memberId = message.memberId || memberIdForSid(meeting, message.sid);
  if (memberId && memberId === orchestratorMemberId(meeting)) return '<span class="mr-gc-to-badge mr-orch-badge-lead">编排员</span>';
  const role = views.get(meeting.id)?.roles?.[memberId]?.role;
  return role ? `<span class="mr-gc-to-badge mr-orch-badge">${escapeHtml(role)}</span>` : '';
}
function isOrchestratorMessage(meeting, message) {
  const memberId = message?.memberId || memberIdForSid(meeting, message?.sid);
  return !!memberId && memberId === orchestratorMemberId(meeting);
}
function cardActions(meeting, message, latestOrchestratorId) {
  if (!active(meeting) || !message || message.id !== latestOrchestratorId) return '';
  const v = views.get(meeting.id);
  if (!v) return '';
  const b = (action, label, primary) => `<button type="button" class="${primary ? 'primary' : ''}" data-orch-card-action="${action}">${label}</button>`;
  if (v.status === 'awaiting_confirm') return `<div class="mr-orch-card-actions">${b('confirm', '确认开工', true)}${b('revise', '我要修改')}<span class="mr-orch-muted">也可以直接在输入框说要改什么</span></div>`;
  if (v.status === 'halted') {
    const budget = /^budget_/.test(v.halt?.reason || '');
    return `<div class="mr-orch-card-actions">${budget ? b('grant-rounds', `再给 ${GRANT_ROUNDS} 轮`, true) : b('resume', '恢复编排', true)}${b('adjust', '调整目标 / 标准')}${b('end', '结束编排')}</div>`;
  }
  return '';
}
function latestOrchestratorMessageId(meeting, messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'assistant' && String(m.content || '').trim() && isOrchestratorMessage(meeting, m)) return m.id;
  }
  return '';
}
// 成员卡片默认折叠成一行（编排员的卡片照常展开）。
function defaultMinimized(meeting, message) {
  return active(meeting) && message?.role === 'assistant' && !isOrchestratorMessage(meeting, message);
}
function peek(meeting, message, escapeHtml) {
  if (!defaultMinimized(meeting, message)) return '';
  const first = String(message.content || '').replace(/^#+\s*/gm, '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  return first ? `<span class="mr-orch-peek" title="${escapeHtml(first)}">${escapeHtml(first.slice(0, 80))}</span>` : '';
}
function dispatchLabel(message) {
  const kind = message?.dispatch?.kind;
  if (kind === 'orch-notice') return 'Hub → 编排员';
  if (kind === 'orchestration') return '编排员派发';
  return null;
}
function handleCardClick(event, meeting, helpers) {
  const btn = event.target.closest?.('[data-orch-card-action]');
  if (!btn) return false;
  event.preventDefault();
  void handleAction(meeting, btn.dataset.orchCardAction, helpers);
  return true;
}
function headerTag(meeting) {
  return enabled(meeting) ? '<span class="mr-gc-to-badge mr-orch-badge-lead mr-orch-title-tag" title="AI 编排模式：田哥只和编排员对话">编排</span>' : '';
}

module.exports = {
  init, enabled, active, view, resolveRecipients, noteUserMessage, renderStrip, roleBadge, cardActions,
  latestOrchestratorMessageId, defaultMinimized, peek, dispatchLabel, handleCardClick, headerTag,
  orchestratorSid, isOrchestratorMessage, STATUS_LABELS,
};
