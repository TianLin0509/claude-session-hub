'use strict';
// 草稿目录「归档并重连」对公司 CodeAgent 放开（2026-10-16）：CodeAgent 的记录和 Claude 同格式、同样按目录分桶，
// 放在它自己的配置目录（默认 ~/.cac）projects/ 下。归档时要把记录复制到新目录的桶里，重连时带原身份 --resume，
// 上下文才接得上；以前直接报「不支持保留上下文迁移」，群里只要有一个 CodeAgent 成员整群都不能归档。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-archive-codeagent-'));
const home = path.join(tempRoot, 'home');
const saved = {};
for (const key of ['USERPROFILE', 'HOME', 'AI_HUB_CODEAGENT_CONFIG_DIR', 'CLAUDE_HUB_DATA_DIR', 'CAC_CONFIG_DIR']) saved[key] = process.env[key];
process.env.USERPROFILE = home; process.env.HOME = home;
process.env.CLAUDE_HUB_DATA_DIR = path.join(tempRoot, 'hub-data');
delete process.env.AI_HUB_CODEAGENT_CONFIG_DIR;
test.after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const { WorkspaceService } = require('../core/workspace-service.js');
const { registerWorkspaceIpc } = require('../main/ipc/workspace-handlers.js');
const { resolveCodeAgentConfig } = require('../core/codeagent-config.js');
const slug = cwd => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

function setup({ meeting = false, bound = true } = {}) {
  const workspaceRoot = path.join(tempRoot, 'Vibe' + Math.random().toString(16).slice(2, 8));
  const toolsDir = path.join(workspaceRoot, 'Tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const workspaceService = new WorkspaceService({ getHubDataDir: () => process.env.CLAUDE_HUB_DATA_DIR, isIsolatedHub: () => true,
    workspaceRoot, initGit: () => true, logger: { warn() {}, error() {} }, randomId: () => 'draft1' });
  const scratch = workspaceService.createScratchWorkspace({ label: 'CodeAgent 归档' });
  workspaceService.updateSuggestedName(scratch.path, 'CodeAgent 归档');
  const sid = '22222222-2222-4222-8222-222222222222';
  const projects = path.join(resolveCodeAgentConfig().configDir, 'projects');
  fs.mkdirSync(path.join(projects, slug(scratch.path)), { recursive: true });
  fs.writeFileSync(path.join(projects, slug(scratch.path), sid + '.jsonl'), '{"type":"user","message":{"role":"user","content":"记住 蓝鲸"}}\n');
  const member = { id: 'c1', kind: 'codeagent', title: 'CodeAgent 会话', cwd: scratch.path, ccSessionId: bound ? sid : null,
    ...(meeting ? { meetingId: 'm1' } : {}) };
  const sessions = new Map([['c1', member]]);
  const resumeMetas = [];
  const meetings = meeting ? new Map([['m1', { id: 'm1', title: '群', workspace: scratch.path, subSessions: ['c1'] }]]) : new Map();
  const handlers = new Map();
  registerWorkspaceIpc({ handle(name, fn) { handlers.set(name, fn); } }, {
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    meetingManager: { getMeeting: id => meetings.get(id) || null, getAllMeetings: () => [...meetings.values()],
      updateMeeting: (id, patch) => { const m = { ...meetings.get(id), ...patch }; meetings.set(id, m); return m; } },
    resumeSession: async meta => { resumeMetas.push(meta); const s = { id: meta.hubId, kind: meta.kind, cwd: meta.cwd, ...(meeting ? { meetingId: 'm1' } : {}) }; sessions.set(s.id, s); return s; },
    sendToRenderer() {},
    sessionManager: { getSession: id => sessions.get(id), getAllSessions: () => [...sessions.values()], closeSession(id) { sessions.delete(id); } },
    shell: { openPath: async () => '' },
    workspaceService,
  });
  return { handlers, scratch, toolsDir, sid, projects, resumeMetas };
}

test('单聊 CodeAgent：可以归档，记录复制到新目录的桶里，带原身份重连', async () => {
  const r = setup();
  const context = r.handlers.get('workspace:archive-context')(null, { scope: 'session', id: 'c1' });
  assert.equal(context.resumeReady, true, JSON.stringify(context.resumeIssues));
  const result = await r.handlers.get('workspace:archive-and-restart')(null, { scope: 'session', id: 'c1', parent: r.toolsDir, folderName: 'ca-archive' });
  assert.equal(result.ok, true);
  const target = path.join(r.projects, slug(result.workspace.path), r.sid + '.jsonl');
  assert.ok(fs.existsSync(target), '记录没有复制到新目录的桶：' + target);
  assert.equal(r.resumeMetas.length, 1);
  assert.equal(r.resumeMetas[0].ccSessionId, r.sid);
  assert.equal(r.resumeMetas[0].cwd, result.workspace.path);
  // 恢复入口会先读磁盘上的旧记录：新目录必须作为本次启动覆盖传过去，否则 CLI 在已搬走的旧目录启动。
  assert.equal(r.resumeMetas[0].launchOverrides.cwd, result.workspace.path);
  assert.deepEqual(result.warnings, []);
});

test('群聊里的 CodeAgent 成员不再挡住整群归档', async () => {
  const r = setup({ meeting: true });
  const context = r.handlers.get('workspace:archive-context')(null, { scope: 'meeting', id: 'm1' });
  assert.equal(context.resumeReady, true, JSON.stringify(context.resumeIssues));
  const result = await r.handlers.get('workspace:archive-and-restart')(null, { scope: 'meeting', id: 'm1', parent: r.toolsDir, folderName: 'ca-group' });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(r.projects, slug(result.workspace.path), r.sid + '.jsonl')));
});

test('身份还没绑定时提示稍等，说的是 CodeAgent 而不是 Claude', () => {
  const r = setup({ bound: false });
  const context = r.handlers.get('workspace:archive-context')(null, { scope: 'session', id: 'c1' });
  assert.equal(context.resumeReady, false);
  assert.match(context.resumeIssues.join('；'), /尚未绑定 CodeAgent session ID/);
});
