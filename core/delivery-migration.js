'use strict';
// One-time move of legacy workflow rooms onto the delivery engine (2026-09-28).
// Rooms with an unfinished legacy task stay on their old engine until it ends;
// old task files are never moved or deleted, and the full previous config is
// kept under serialWorkflow.migratedFrom.
const fs = require('node:fs');
const path = require('node:path');
const S = require('./workflow-settings');
const F = require('./dev-file-workflow');

const SOLO_PROMPT = '按当前需求独立完成：先读项目 AGENTS.md 与 .agents/ 下的合同，在独立 worktree 实现并完成必要测试；在最新主干核实完整 SHA、执行项目验证与 dry-run，通过后按项目入口合并并完成后置检查。自测不冒充独立审查，项目要求的独立审查或额外审批仍须满足。';
const RELAY_PROMPT = '围绕用户目标完成本轮：先读前序成员的交付，在其基础上推进或补充，不重复已完成的内容。';
// An unfinished legacy task untouched this long is treated as abandoned.
const STALE_MS = 7 * 24 * 3600_000;
const clone = v => JSON.parse(JSON.stringify(v));
const live = st => ['running', 'paused'].includes(st?.status);
const lastTouched = m => Number(m.lastMessageTime || m.updatedAt || m.createdAt) || 0;

function protocolOf(w) {
  if (w.deliveryVersion === 1) return 'delivery';
  if (w.fileFlowVersion === 2) return w.soloDevelopment ? 'fileflow-solo' : 'fileflow';
  if (w.loop?.enabled) return 'loop';
  if (w.settingsVersion === 1 || w.enabled) return 'serial';
  return null;
}
function memberIdsOf(m) { return (m.slotSpecs || []).map((p, i) => p?.memberId || `m${i + 1}`); }
function draftFor(m, protocol) {
  const w = m.serialWorkflow, ids = memberIdsOf(m);
  const members = ids.map(memberId => ({ memberId }));
  if (protocol === 'fileflow') return S.fromConfig(w, members);
  const solo = author => ({ enabled: true, kind: 'serial', presetId: 'custom', rounds: [{ name: '独立开发', members: [author], prompt: SOLO_PROMPT, after: 'end' }] });
  if (protocol === 'fileflow-solo') return solo(w.steps?.[0]?.[0] || ids[0]);
  if (protocol === 'loop' && w.templateId === 'dev-task-solo') return solo(w.steps?.[0]?.[0] || ids[0]);
  if (protocol === 'loop' && w.templateId === 'dev-task') {
    const [a, b] = [w.steps?.[0]?.[0], w.steps?.[1]?.[0]];
    if (!a || !b || a === b) return null;
    const d = S.createPreset('development', members);
    d.rounds[0].members = [a]; d.rounds[1].members = [a]; d.rounds[2].members = [b];
    return d;
  }
  // Other legacy loops and relays become a plain serial run of the same steps.
  const d = S.fromConfig({ ...w, loop: { enabled: false }, soloDevelopment: false }, members);
  if (d.legacyProtocol) return null;
  d.rounds = d.rounds.slice(0, S.LIMIT).map(r => ({ ...r, prompt: r.prompt?.trim() ? r.prompt : RELAY_PROMPT }));
  if (d.rounds.length) d.rounds[d.rounds.length - 1].after = 'end';
  return d;
}
/** Returns { action: 'migrate', config, protocol } or { action: 'keep', reason, protocol }. */
function plan(m, dataDir, now = Date.now()) {
  const w = m?.serialWorkflow;
  if (!m?.groupChat || !w) return { action: 'keep', reason: 'not-workflow' };
  const protocol = protocolOf(w);
  if (!protocol) return { action: 'keep', reason: 'not-workflow' };
  if (protocol === 'delivery') return { action: 'keep', reason: 'already', protocol };
  // A room whose workflow the user switched off (or took over manually) is a plain chat now.
  if ((w.enabled === false && !w.loop?.enabled) || w.devWorkbenchManual) return { action: 'keep', reason: 'not-workflow', protocol };
  const recent = now - lastTouched(m) < STALE_MS;
  if (protocol === 'fileflow') {
    let s;
    try { s = F.scan(F.directory(dataDir, m.id)); } catch (error) { return { action: 'keep', reason: `task-files: ${error.message}`, protocol }; }
    if (s.error) return { action: 'keep', reason: `task-files: ${s.error}`, protocol };
    if (!s.done && s.phase !== 'discuss' && recent) return { action: 'keep', reason: `inflight ${s.key}`, protocol };
  }
  if ((live(w.loopState) || live(w.serialRunState)) && recent) return { action: 'keep', reason: 'inflight run', protocol };
  let draft;
  try { draft = draftFor(m, protocol); } catch (error) { return { action: 'keep', reason: `unmappable: ${error.message}`, protocol }; }
  if (!draft) return { action: 'keep', reason: 'unmappable', protocol };
  draft.enabled = true;
  let config;
  try { config = S.toDeliveryConfig(w, draft, memberIdsOf(m)); } catch (error) { return { action: 'keep', reason: `invalid: ${error.message}`, protocol }; }
  config.migratedFrom = { at: new Date().toISOString(), protocol, previous: clone(w) };
  return { action: 'migrate', config, protocol };
}
function migrateAll({ meetingManager, dataDir, logger = console }) {
  const summary = { migrated: [], kept: [] };
  for (const m of meetingManager.getAllMeetings()) {
    const p = plan(m, dataDir);
    if (p.action === 'keep') { if (p.reason !== 'not-workflow' && p.reason !== 'already') summary.kept.push({ id: m.id, title: m.title, protocol: p.protocol, reason: p.reason }); continue; }
    try {
      meetingManager.updateMeeting(m.id, { serialWorkflow: p.config });
      const ids = memberIdsOf(m), first = p.config.deliveryStages[0].members.map(id => ids.indexOf(id)).filter(i => i >= 0);
      if (first.length) meetingManager.setParticipants(m.id, first);
      summary.migrated.push({ id: m.id, title: m.title, protocol: p.protocol });
    } catch (error) { summary.kept.push({ id: m.id, title: m.title, protocol: p.protocol, reason: `write failed: ${error.message}` }); }
  }
  if (summary.migrated.length) {
    try { fs.appendFileSync(path.join(dataDir, 'workflow-migration.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...summary }) + '\n', 'utf8'); } catch {}
    logger.log?.(`[workflow-migration] migrated ${summary.migrated.length}, kept on legacy engine ${summary.kept.length}`);
  }
  return summary;
}

module.exports = { plan, migrateAll, protocolOf, SOLO_PROMPT, RELAY_PROMPT, STALE_MS };
