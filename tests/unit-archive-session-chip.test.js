'use strict';
// P1-2：独立会话的归档建议必须有 UI 承载。
//
// 断链现场：maybePromptSessionArchive → maybePromptArchive('session', id) →
// archiveSuggestions.set + 派发 workspace-archive-suggestion，而唯一的监听者
// （meeting-room.js）第一行就是 `if (detail.scope !== 'meeting') return;`。
// 建议进了没人读的 Map，用户永远不会再被提示归档。
//
// 这个测试刻意不做源码文本断言（SRC.includes(...) 锁得住代码长什么样、锁不住
// 行为对不对，P1-2 就是被那类测试放过去的）。这里把 workspace-controller.js
// 整个丢进 vm 真跑一遍，用假 DOM 观察它的实际行为。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------- 假 DOM ----

const createdNodes = [];

function makeNode(tag = 'div') {
  const classes = new Set();
  const listeners = {};
  const queryCache = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    title: '',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    __listeners: listeners,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener() {},
    appendChild(child) { node.children.push(child); return child; },
    // 同一个选择器稳定返回同一个节点，这样测试能拿到控件本体去点它。
    querySelector(selector) {
      if (!queryCache.has(selector)) queryCache.set(selector, makeNode('div'));
      return queryCache.get(selector);
    },
    querySelectorAll() { return []; },
    focus() { fakeDocument.activeElement = node; },
    setAttribute() {},
    getAttribute() { return null; },
  };
  createdNodes.push(node);
  return node;
}

const fakeDocument = {
  activeElement: null,
  body: { contains: () => true, appendChild: () => {} },
  createElement: tag => makeNode(tag),
  getElementById: () => null,
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

const windowListeners = {};
const fakeWindow = {
  addEventListener(type, fn) { (windowListeners[type] || (windowListeners[type] = [])).push(fn); },
  removeEventListener() {},
  dispatchEvent(event) {
    (windowListeners[event.type] || []).slice().forEach(fn => fn(event));
    return true;
  },
};

async function fire(node, type, event = {}) {
  for (const fn of (node.__listeners[type] || []).slice()) await fn(event);
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(rounds = 6) { for (let i = 0; i < rounds; i += 1) await tick(); }

// --------------------------------------------------------------- 假 IPC ----

const ipcListeners = new Map();
const invokeLog = [];

// 测试通过这两个开关控制 main 侧的回答。
let contextReady = true;
let archiveResult = { ok: true };

function emitToRenderer(channel, payload) {
  (ipcListeners.get(channel) || []).slice().forEach(fn => fn({}, payload));
}

const fakeIpcRenderer = {
  on(channel, fn) {
    if (!ipcListeners.has(channel)) ipcListeners.set(channel, []);
    ipcListeners.get(channel).push(fn);
  },
  removeListener() {},
  async invoke(channel, args) {
    invokeLog.push([channel, args]);
    if (channel === 'workspace:archive-context') {
      return {
        required: true,
        scope: args.scope,
        id: args.id,
        title: `任务 ${args.id}`,
        label: `任务 ${args.id}`,
        source: 'C:\\Vibe\\_scratch\\inbox-demo',
        categories: [],
        resumeReady: contextReady,
        resumeIssues: contextReady ? [] : ['当前会话未在运行'],
        workspace: { suggestedName: contextReady ? 'demo-project' : '' },
      };
    }
    if (channel === 'workspace:pick-archive-parent') return { path: 'C:\\Vibe\\AI' };
    if (channel === 'workspace:dismiss-archive') return null;
    if (channel === 'workspace:archive-and-restart') {
      // main 在归档过程中会先推送降级，再返回结果 —— 两条腿都要被 renderer 收到。
      emitToRenderer('workspace-archive-warning', {
        scope: args.scope, id: args.id, stage: 'codex',
        target: 'Codex 成员', message: '未找到 codex rollout: abc',
      });
      return archiveResult;
    }
    return null;
  },
};

// ------------------------------------------------------- 真跑 controller ----

const rendererDir = nodePath.join(__dirname, '..', 'renderer');
const source = fs.readFileSync(nodePath.join(rendererDir, 'workspace-controller.js'), 'utf8');

const sandbox = {
  window: fakeWindow,
  document: fakeDocument,
  console: { warn() {}, error() {}, log() {} },
  // 同步 setTimeout：把 maybePromptArchive 的 20×400ms 轮询压成瞬时，
  // 测的是分支逻辑而不是等待时长。
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout: () => {},
  CustomEvent: class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  },
  require: (id) => {
    if (id === 'electron') return { ipcRenderer: fakeIpcRenderer };
    if (id === 'path') return nodePath;
    return require(nodePath.resolve(rendererDir, id));
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'workspace-controller.js' });

const wc = sandbox.window.WorkspaceController;

// ------------------------------------------------------------------ 断言 ----

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  OK ${name}`); }
  catch (error) { failed += 1; console.error(`  FAIL ${name}\n    ${(error && error.stack) || error}`); }
}

function findModal() {
  return createdNodes.find(node => node.id === 'workspace-archive-modal') || null;
}

(async () => {
  console.log('Running session archive chip behaviour tests...');

  assert.ok(wc, 'workspace-controller 必须挂出 WorkspaceController');

  const suggestionEvents = [];
  fakeWindow.addEventListener('workspace-archive-suggestion', e => suggestionEvents.push(e.detail));

  await test('session scope 的建议能被 hasArchiveSuggestion 查到（P1-2 断链点）', async () => {
    contextReady = true;
    const surfaced = await wc.maybePromptSessionArchive('sess-1');
    assert.equal(surfaced, true);
    assert.equal(wc.hasArchiveSuggestion('session', 'sess-1'), true,
      '独立会话的建议必须可查 —— 以前它只进了没人读的 Map');
    assert.equal(wc.getArchiveSuggestion('session', 'sess-1').scope, 'session');
    assert.equal(suggestionEvents.length, 1);
    assert.equal(suggestionEvents[0].scope, 'session');
    assert.equal(suggestionEvents[0].id, 'sess-1');
  });

  const copied = [];
  const chip = makeNode('span');

  await test('attachArchiveHint 给会话 header 点亮提示态', async () => {
    const attached = wc.attachArchiveHint(chip, 'session', 'sess-1', {
      hintTitle: '这个任务还在临时区 · 点击归档到正式项目目录',
      idleTitle: 'Click to copy · C:\\Vibe\\_scratch\\inbox-demo',
      onFallback: () => copied.push('sess-1'),
    });
    assert.equal(attached, true);
    assert.equal(chip.classList.contains('has-archive-hint'), true, 'chip 必须进入提示态');
    assert.match(chip.title, /点击归档/, 'title 要告诉用户点了会发生什么');
  });

  await test('点击有提示的 chip 打开归档框，而不是复制路径', async () => {
    await fire(chip, 'click');
    await settle();
    assert.deepEqual(copied, [], '有建议时点击不该退化成复制路径');
    const modal = findModal();
    assert.ok(modal, '必须真的建出归档框');
    assert.equal(modal.style.display, 'flex', '归档框要显示出来');
    assert.equal(chip.classList.contains('has-archive-hint'), false, '点开后提示态收起');
  });

  await test('没有建议的会话保持原来的「点击复制路径」行为', async () => {
    const plain = makeNode('span');
    wc.attachArchiveHint(plain, 'session', 'sess-none', {
      idleTitle: 'Click to copy · C:\\tmp',
      onFallback: () => copied.push('sess-none'),
    });
    assert.equal(plain.classList.contains('has-archive-hint'), false);
    assert.equal(plain.title, 'Click to copy · C:\\tmp');
    await fire(plain, 'click');
    assert.deepEqual(copied, ['sess-none']);
  });

  await test('AI 群聊与独立会话共用同一个 attachArchiveHint（防止只改一边）', async () => {
    contextReady = true;
    await wc.maybePromptMeetingArchive('meet-1');
    const meetingChip = makeNode('button');
    const meetingCopied = [];
    wc.attachArchiveHint(meetingChip, 'meeting', 'meet-1', {
      hintTitle: '这个任务还在临时区 · 点击归档到正式项目目录',
      onFallback: () => meetingCopied.push(1),
    });
    assert.equal(meetingChip.classList.contains('has-archive-hint'), true,
      '同一个函数必须对 meeting scope 一样生效');
    assert.deepEqual(meetingCopied, []);
  });

  await test('main 推来的降级信息会被 renderer 收下（不再只落 console）', async () => {
    emitToRenderer('workspace-archive-warning', {
      scope: 'session', id: 'sess-1', stage: 'transcript',
      target: 'cc-sid', message: '没找到对应的 Claude 对话记录',
    });
    const warnings = wc.getArchiveWarnings('session', 'sess-1');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].stage, 'transcript');
  });

  await test('归档成功但有降级时，归档框不静默关闭而是把降级摆出来', async () => {
    const modal = findModal();
    // 选父目录（走「完全新建路径」分支，因为假 context 没给 categories）。
    await fire(modal.querySelector('#workspace-archive-custom-parent'), 'click');
    await settle();
    modal.querySelector('#workspace-archive-folder-name').value = 'demo-project';

    archiveResult = {
      ok: true,
      warnings: [{
        scope: 'session', id: 'sess-1', stage: 'codex',
        target: 'Codex 成员', message: '未找到 codex rollout: abc',
      }],
    };
    const completed = [];
    fakeWindow.addEventListener('workspace-archive-completed', e => completed.push(e.detail));

    await fire(modal.querySelector('#workspace-archive-submit'), 'click');
    await settle(10);

    assert.ok(invokeLog.some(([channel]) => channel === 'workspace:archive-and-restart'),
      '归档 IPC 要真的被调用');
    assert.equal(modal.style.display, 'flex', '有降级时不许直接关掉框——那正是用户看不见的原因');
    const submit = modal.querySelector('#workspace-archive-submit');
    assert.equal(submit.textContent, '知道了', '按钮要变成确认键');
    const box = modal.querySelector('#workspace-archive-warnings');
    assert.equal(box.hidden, false, '降级区必须可见');
    assert.match(box.innerHTML, /未找到 codex rollout/, '降级原文必须出现在 UI 上');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].warnings.length, 1,
      '事件里也带 warnings，推送与返回值合并去重后只剩一条');
  });

  await test('按「知道了」才关闭，关闭后建议随之落下', async () => {
    const modal = findModal();
    await fire(modal.querySelector('#workspace-archive-submit'), 'click');
    await settle();
    assert.equal(modal.style.display, 'none');
    assert.equal(wc.hasArchiveSuggestion('session', 'sess-1'), false,
      '处理完的建议要清掉，否则下次重绘 header 又把提示点亮');
  });

  await test('用户已经处理过的建议不再重复打扰（暂留 _scratch 的决定要生效）', async () => {
    contextReady = true;
    const again = await wc.maybePromptSessionArchive('sess-1');
    assert.equal(again, false, '关闭归档框 = 已决定，本次运行不再问');
  });

  await test('半成品建议不落「已问过」标记，下一轮能刷新（archivePromptedKeys 历史状态）', async () => {
    contextReady = false;
    const first = await wc.maybePromptSessionArchive('sess-2');
    assert.equal(first, true, '半成品也要先把 chip 点亮，让用户至少知道有这回事');
    assert.equal(wc.getArchiveSuggestion('session', 'sess-2').resumeReady, false);

    contextReady = true;
    const second = await wc.maybePromptSessionArchive('sess-2');
    assert.equal(second, true, '没就绪过的 key 必须放行重试，不能被永久钉死');
    assert.equal(wc.getArchiveSuggestion('session', 'sess-2').resumeReady, true,
      '重试后 context 要被刷新成可用的那份');

    const third = await wc.maybePromptSessionArchive('sess-2');
    assert.equal(third, false, '真正呈现过之后就不再重复了');
  });

  if (failed > 0) {
    console.error(`unit-archive-session-chip: ${failed} FAILED`);
    process.exitCode = 1;
  } else {
    console.log('unit-archive-session-chip: PASS');
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
