'use strict';
// 恢复 CodeAgent 历史会话（2026-10-13 公司真机反馈：CodeAgent 自带的 /resume 只看当前目录）：
// Hub 按提供方列出所有项目目录的记录，启动中心「恢复会话」页有 CodeAgent 一项（公司版因此不再整页裁掉）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}
function transcript(file, cwd, prompt, model) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'user', cwd, message: { role: 'user', content: prompt } },
    { type: 'assistant', cwd, message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-home-'));
  const cac = path.join(home, '.cac');
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, AI_HUB_CODEAGENT_CONFIG_DIR: process.env.AI_HUB_CODEAGENT_CONFIG_DIR };
  process.env.USERPROFILE = home; process.env.HOME = home; process.env.AI_HUB_CODEAGENT_CONFIG_DIR = cac;
  transcript(path.join(cac, 'projects', 'D--a', '11111111-1111-4111-8111-111111111111.jsonl'), 'D:\\a', '目录 a 的问题', 'GLM-5.2-WX');
  transcript(path.join(cac, 'projects', 'D--b', '22222222-2222-4222-8222-222222222222.jsonl'), 'D:\\b', '目录 b 的问题', 'MiniMax-M2.7');
  transcript(path.join(home, '.claude', 'projects', 'D--c', '33333333-3333-4333-8333-333333333333.jsonl'), 'D:\\c', 'Claude 的问题', 'claude-haiku-5-5');
  const archive = require('../core/session-archive');

  await test('provider=codeagent：只列 CodeAgent 记录，跨两个目录，每条标出目录和提供方', async () => {
    const items = await archive.listRecent(50, { provider: 'codeagent' });
    assert.deepStrictEqual(items.map(i => i.cwd).sort(), ['D:\\a', 'D:\\b']);
    assert(items.every(i => i.provider === 'codeagent'));
    assert(items.some(i => i.firstUserMessage === '目录 b 的问题' && i.model === 'MiniMax-M2.7'));
  });

  await test('provider=claude 只列 Claude；不传 provider 仍是全部（原有行为不变）', async () => {
    archive.invalidateCache();
    assert.deepStrictEqual((await archive.listRecent(50, { provider: 'claude' })).map(i => i.cwd), ['D:\\c']);
    const all = await archive.listRecent(50);
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all.find(i => i.cwd === 'D:\\c').provider, 'claude');
  });

  await test('IPC：数量限 1–500，未知提供方当作全部', async () => {
    const calls = [];
    const handlers = {};
    require('../main/ipc/archive-handlers').registerArchiveIpc({ handle: (ch, fn) => { handlers[ch] = fn; } },
      { sessionArchive: { listRecent: async (...args) => { calls.push(args); return []; } } });
    await handlers['list-past-sessions'](null, { limit: 99999, provider: 'codeagent' });
    await handlers['list-past-sessions'](null, { limit: 'x', provider: 'evil' });
    assert.deepStrictEqual(calls, [[500, { provider: 'codeagent' }], [50, undefined]]);
  });

  await test('界面接线：恢复页有 CodeAgent 一项，点它打开跨目录弹窗，选中后在原目录用 codeagent 恢复', async () => {
    const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
    assert.match(html, /data-resume-kind="codeagent-resume"/);
    assert.match(html, /id="resume-modal-title"/);
    const renderer = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8');
    assert.match(renderer, /kind === 'codeagent-resume'\s*\? openResumeModal\(\{ provider: 'codeagent' \}\)/);
    const modals = fs.readFileSync(path.join(root, 'renderer/past-session-modals.js'), 'utf8');
    assert.match(modals, /kind: 'codeagent',\s*opts: \{ resumeCCSessionId: it\.sessionId, resumeTranscriptPath: it\.path \|\| undefined, cwd: it\.cwd \|\| undefined/);
    assert.match(modals, /list-past-sessions', \{ limit: text\.limit, provider: requested \}/);
  });

  await test('公司版：CodeAgent 恢复项属于允许的类型，恢复页不再被整页裁掉', async () => {
    const { isCodeAgentKind } = require('../core/ai-kinds');
    assert(isCodeAgentKind('codeagent-resume'));
    const trim = fs.readFileSync(path.join(root, 'renderer/edition-trim.js'), 'utf8');
    assert.match(trim, /kindAllowed\(button\.dataset\.resumeKind\)/);
  });

  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('unit-codeagent-global-resume: all passed');
})();
