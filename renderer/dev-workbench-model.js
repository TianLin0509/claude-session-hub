'use strict';
// Pure projection of already-published facts. No IO or inferred completion.
const historyKeys = new Set(['passed', 'stoppedUser', 'stopped']);
function isHistory(row) { return historyKeys.has(row.stage?.key); }
function projectKey(row) {
  const raw = typeof row.workspace === 'string' ? row.workspace.trim() : '';
  if (!raw) return 'unbound';
  return /^[a-z]:[\\/]|^\\\\/i.test(raw)
    ? raw.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() : raw.replace(/\/+$/, '') || '/';
}
function projectName(row) {
  return (typeof row.project === 'string' && row.project) || (typeof row.workspace === 'string' && row.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop()) || '未绑定项目';
}
function sortRows(rows, order = 'updated-desc') {
  const field = order.startsWith('created') ? 'createdAt' : 'activityAt', direction = order.endsWith('asc') ? 1 : -1;
  const rank = r => r.pinned ? 0 : r.bottomed ? 2 : 1;
  const time = r => Number(r[field]) || Number(r.createdAt) || 0;
  return [...rows].sort((a, b) => rank(a) - rank(b) || direction * (time(a) - time(b)) || String(a.id).localeCompare(String(b.id)));
}
function groupProjects(rows, order) {
  const groups = new Map();
  for (const row of sortRows(rows, order)) {
    const key = projectKey(row);
    if (!groups.has(key)) groups.set(key, { key, name: projectName(row), workspace: row.workspace || '', current: [], history: [], activityAt: 0, createdAt: 0 });
    const group = groups.get(key);
    group[isHistory(row) ? 'history' : 'current'].push(row);
    group.activityAt = Math.max(group.activityAt, Number(row.activityAt) || Number(row.createdAt) || 0);
    group.createdAt = Math.max(group.createdAt, Number(row.createdAt) || 0);
  }
  return sortRows([...groups.values()].map(g => ({ ...g, id: g.key })), order);
}
function flowSteps(row) {
  const flow = row.flow || {}, key = row.stage?.key;
  // '通过' only comes from the current engine state, never an older PASS message.
  const done = key === 'passed';
  const hasGoal = !!row.goal;
  let active = done ? 3 : flow.currentStep === 'reviewer' ? 2 : hasGoal ? 1 : 0;
  if (['chatting', 'recovering', 'manual', 'chatFailed'].includes(key) && flow.status === 'done') active = -1;
  return ['目标', '实现', '审核', '通过'].map((label, index) => ({ label, state: index === active ? 'current' : active >= 0 && index < active ? 'complete' : 'pending' }));
}
module.exports = { isHistory, projectKey, projectName, sortRows, groupProjects, flowSteps };
