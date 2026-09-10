'use strict';

const NAMES = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
function remainingPercent(window) {
  const used = window?.pct;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0
    ? Math.max(0, 100 - Math.min(100, used)) : null;
}

// Stable controls: polling does not replace a focused refresh button.
function createSidebarAccountUsage({ document, root, refresh, formatAge, formatBalance, freshness }) {
  const el = (tag, cls, parent, text) => {
    const node = document.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node); return node;
  };
  const quota = el('div', 'sidebar-quota', root);
  const claudeRow = el('div', 'sidebar-quota-claude', quota);
  const pair = el('div', 'sidebar-quota-pair', quota);
  const entries = {};
  for (const provider of Object.keys(NAMES)) {
    const row = el('div', 'sidebar-quota-provider', provider === 'claude' ? claudeRow : pair);
    row.dataset.provider = provider;
    el('span', 'sidebar-quota-name', row, NAMES[provider]);
    const metrics = el('div', 'sidebar-quota-metrics', row);
    const windows = provider === 'claude' ? ['5h', '7d'] : provider === 'codex' ? ['7d'] : ['balance'];
    const cells = {};
    for (const window of windows) {
      const cell = el('span', 'sidebar-quota-metric', metrics); cell.dataset.window = window;
      const line = el('span', 'sidebar-quota-reading', cell);
      el('span', 'sidebar-quota-period', line, window === 'balance' ? '' : window + (provider === 'claude' ? ' 余量' : ''));
      const value = el('b', 'sidebar-quota-value', line, '—');
      const track = window !== 'balance' ? el('span', 'sidebar-quota-track', cell) : null;
      const fill = track ? el('i', '', track) : null;
      if (track) track.setAttribute('aria-hidden', 'true');
      cells[window] = { cell, value, fill };
    }
    const button = el('button', 'sidebar-quota-refresh', row, '↻');
    button.type = 'button'; button.setAttribute('aria-label', '刷新 ' + NAMES[provider]);
    button.addEventListener('click', () => {
      // Controller retains and renders errors for every programmatic/UI caller.
      refresh(provider).catch(error => { row.title = NAMES[provider] + ' 刷新失败：' + error.message; });
    });
    entries[provider] = { row, button, cells };
  }
  const footer = el('div', 'sidebar-quota-footer', root);
  const feedback = el('span', 'sidebar-quota-feedback', footer);
  feedback.setAttribute('role', 'status');
  return {
    footer,
    render(snapshot, states) {
      const notices = [];
      for (const provider of Object.keys(entries)) {
        const { row, cells, button } = entries[provider];
        const data = snapshot[provider] || {};
        const state = states[provider] || {};
        row.dataset.freshness = freshness(data.lastSeen);
        const age = formatAge(data.lastSeen);
        const status = state.inFlight ? '刷新中…' : state.error ? '刷新失败：' + state.error
          : state.result ? state.result.fresh ? '已取得新数据' : '未取得新数据，保留旧值' : '';
        row.title = [NAMES[provider], data.profileLabel, age, status].filter(Boolean).join(' · ');
        button.title = '刷新 ' + row.title;
        button.setAttribute('aria-disabled', String(!!state.inFlight));
        button.dataset.state = state.inFlight ? 'loading' : state.error ? 'error' : 'idle';
        button.textContent = state.inFlight ? '…' : state.error ? '!' : '↻';
        if (status) notices.push({ priority: state.error ? 0 : state.inFlight ? 1 : 2, text: NAMES[provider] + ' ' + status });
        for (const [window, cell] of Object.entries(cells)) {
          if (window === 'balance') {
            cell.value.textContent = formatBalance(data);
            const raw = (data.balance || data).totalBalance;
            row.dataset.level = cell.value.textContent !== '—' && Number(raw) < 20 ? 'warn' : 'normal';
            cell.cell.title = '余额 · ' + age + ((data.balance || data).available === false ? ' · 当前不可用' : '');
          } else {
            const pct = remainingPercent(data['usage' + window]);
            cell.value.textContent = pct === null ? '—' : Math.round(pct) + '%';
            cell.fill.style.width = (pct ?? 0) + '%';
            cell.cell.dataset.level = pct !== null && pct < 15 ? 'danger' : pct !== null && pct <= 40 ? 'warn' : 'normal';
            cell.cell.title = window + ' 剩余额度 · ' + age;
          }
        }
      }
      feedback.textContent = notices.sort((a, b) => a.priority - b.priority).map(n => n.text).join('；') || '余量 · 悬停查看各家数据时间';
      feedback.title = Object.keys(entries).map(p => entries[p].row.title).join('\n');
    },
  };
}
module.exports = { createSidebarAccountUsage, remainingPercent };
