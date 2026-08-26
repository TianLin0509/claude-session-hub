'use strict';

const http = require('http');
const https = require('https');
const {
  formatBranchSessionTitle,
  isGenericAutoSessionTitle: isGenericAutoSessionTitleForKinds,
} = require('../core/session-title-guards.js');

function createAutoTitleManager(deps) {
  const {
    allAiKinds,
    getHubConfig,
    kindLabels,
    meetingManager,
    sendToRenderer,
    sessionManager,
    workspaceService,
  } = deps;

  const autoTitleInFlight = new Set();
  const autoMeetingTitleInFlight = new Set();
  const autoTitleBaseKinds = new Set(allAiKinds);
  const autoTitleMeetingRe = /^(?:通用|投研|开发|AI 群聊) #\d+$/;

  function fallbackSessionTitleFromPrompt(text, kind) {
    const clean = String(text || '')
      .replace(/[#*_`>\[\](){}<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const baseKind = String(kind || '').replace(/-resume$/, '');
    const prefix = kindLabels[baseKind] || '会话';
    if (!clean) return '';
    return `${prefix} · ${clean.slice(0, 18)}`;
  }

  function fallbackMeetingTitleFromPrompt(text) {
    const clean = String(text || '')
      .replace(/[#*_`>\[\](){}<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return '';
    return `群聊 · ${clean.slice(0, 18)}`;
  }

  function postJsonForAutoTitle(endpoint, payload, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const u = new URL(endpoint);
      const lib = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify(payload);
      const req = lib.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      }, res => {
        let buf = '';
        res.on('data', d => { buf += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('timeout', () => req.destroy(new Error(`auto-title timeout after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function generateSessionTitleFromPrompt(text, scope = 'session') {
    const cfg = getHubConfig();
    const prompt = String(text || '').trim().slice(0, 1200);
    if (!prompt) return '';
    if (!cfg.deepseekApiKey) return '';
    const system = scope === 'meeting'
      ? '你是房间命名器。根据用户在 AI 群聊中的第一句话生成中文短标题，8到16个汉字或等长短语，不要引号，不要解释。'
      : '你是会话命名器。根据用户第一句话生成中文短标题，8到16个汉字或等长短语，不要引号，不要解释。';
    const { status, body } = await postJsonForAutoTitle('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 40,
    }, { authorization: `Bearer ${cfg.deepseekApiKey}` }, 8000);
    if (status !== 200) throw new Error(`DeepSeek HTTP ${status}`);
    const parsed = JSON.parse(body);
    const raw = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
    return String(raw || '').replace(/["'“”‘’\r\n]/g, '').trim().slice(0, 30);
  }

  function isAutoTitleSessionKind(kind) {
    const base = String(kind || '').replace(/-resume$/, '');
    return autoTitleBaseKinds.has(base);
  }

  function isGenericAutoSessionTitle(title) {
    return isGenericAutoSessionTitleForKinds(title, kindLabels);
  }

  function isGenericAutoMeetingTitle(title) {
    return !title || autoTitleMeetingRe.test(String(title).trim());
  }

  function syncPendingBranchTitlesFromSource(sourceSessionId, sourceTitle) {
    if (!sourceSessionId || !sourceTitle || typeof sessionManager.getAllSessions !== 'function') return;
    for (const branch of sessionManager.getAllSessions()) {
      if (!branch || branch.branchSourceSessionId !== sourceSessionId) continue;
      if (!branch.branchAutoTitlePending || branch.userRenamed) continue;
      const updatedBranch = sessionManager.updateSessionMeta(branch.id, {
        title: formatBranchSessionTitle(sourceTitle, '会话', branch.branchIndex),
        autoTitleGenerated: true,
        branchAutoTitlePending: false,
      });
      if (updatedBranch) sendToRenderer('session-updated', { session: updatedBranch });
    }
  }

  function maybeAutoTitleSessionFromPrompt(ev) {
    const { hubSessionId, text } = ev || {};
    if (!hubSessionId || !text || autoTitleInFlight.has(hubSessionId)) return;
    const session = sessionManager.getSession(hubSessionId);
    if (!session || session.meetingId || session.userRenamed) return;
    if (!isAutoTitleSessionKind(session.kind)) return;
    if (session.autoTitleGenerated) return;
    if (!session.branchAutoTitlePending && !isGenericAutoSessionTitle(session.title)) return;
    autoTitleInFlight.add(hubSessionId);
    setTimeout(async () => {
      try {
        const latest = sessionManager.getSession(hubSessionId);
        if (!latest || latest.userRenamed || latest.autoTitleGenerated || latest.meetingId) return;
        if (!isAutoTitleSessionKind(latest.kind)
            || (!latest.branchAutoTitlePending && !isGenericAutoSessionTitle(latest.title))) return;
        let title = '';
        try { title = await generateSessionTitleFromPrompt(text); } catch (e) {
          console.warn('[auto-title] AI title failed:', e && e.message);
        }
        if (!title) title = fallbackSessionTitleFromPrompt(text, (latest.kind || '').replace(/-resume$/, ''));
        if (!title) return;
        const wasPendingBranch = !!latest.branchAutoTitlePending;
        const finalTitle = wasPendingBranch
          ? formatBranchSessionTitle(title, '会话', latest.branchIndex)
          : title;
        const updated = sessionManager.updateSessionMeta(hubSessionId, {
          title: finalTitle,
          autoTitleGenerated: true,
          ...(wasPendingBranch ? { branchAutoTitlePending: false } : {}),
        });
        if (updated) {
          sendToRenderer('session-updated', { session: updated });
          syncPendingBranchTitlesFromSource(hubSessionId, title);
          // A branch shares the parent's cwd. Renaming that workspace from a
          // child prompt would unexpectedly relabel the parent and siblings.
          if (workspaceService && updated.cwd && !updated.branchSourceSessionId) {
            const workspace = workspaceService.updateSuggestedName(updated.cwd, finalTitle);
            if (workspace) {
              const relabeled = sessionManager.updateSessionMeta(hubSessionId, { workspaceLabel: workspace.label });
              if (relabeled) sendToRenderer('session-updated', { session: relabeled });
              sendToRenderer('workspace-updated', { workspace });
            }
          }
        }
      } finally {
        autoTitleInFlight.delete(hubSessionId);
      }
    }, 0);
  }

  function maybeAutoTitleMeetingFromPrompt(meetingId, text) {
    if (!meetingId || !text || autoMeetingTitleInFlight.has(meetingId)) return;
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || meeting.userRenamed || meeting.autoTitleGenerated) return;
    if (!meeting.autoTitlePending && !isGenericAutoMeetingTitle(meeting.title)) return;
    autoMeetingTitleInFlight.add(meetingId);
    setTimeout(async () => {
      try {
        const latest = meetingManager.getMeeting(meetingId);
        if (!latest || latest.userRenamed || latest.autoTitleGenerated) return;
        if (!latest.autoTitlePending && !isGenericAutoMeetingTitle(latest.title)) return;
        let title = '';
        try { title = await generateSessionTitleFromPrompt(text, 'meeting'); } catch (e) {
          console.warn('[auto-title] meeting AI title failed:', e && e.message);
        }
        if (!title) title = fallbackMeetingTitleFromPrompt(text, latest);
        if (!title) return;
        const updated = meetingManager.updateMeeting(meetingId, {
          title,
          autoTitleGenerated: true,
          autoTitlePending: false,
        });
        if (updated) {
          sendToRenderer('meeting-updated', { meeting: updated });
          if (workspaceService && updated.workspace) {
            const workspace = workspaceService.updateSuggestedName(updated.workspace, title);
            if (workspace) {
              const relabeled = meetingManager.updateMeeting(meetingId, { workspaceLabel: workspace.label });
              if (relabeled) sendToRenderer('meeting-updated', { meeting: relabeled });
              sendToRenderer('workspace-updated', { workspace });
            }
          }
        }
      } finally {
        autoMeetingTitleInFlight.delete(meetingId);
      }
    }, 0);
  }

  return {
    fallbackMeetingTitleFromPrompt,
    fallbackSessionTitleFromPrompt,
    isGenericAutoMeetingTitle,
    isGenericAutoSessionTitle,
    maybeAutoTitleMeetingFromPrompt,
    maybeAutoTitleSessionFromPrompt,
  };
}

module.exports = {
  createAutoTitleManager,
};
