'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createCardMultiSelectController,
  formatSelectedMessages,
} = require('../renderer/card-multi-select.js');

// ---------------------------------------------------------------------------
// 极简 DOM 替身：只实现本控制器真正用到的那几个 API。
// 卡片视图的真实痛点是 patchTurnCardInPlace 会把卡片属性全清掉，所以替身必须
// 能模拟「class 被抹掉」这件事，否则测了个寂寞。
// ---------------------------------------------------------------------------
function createClassList(el) {
  return {
    add(name) { if (!el._classes.includes(name)) el._classes.push(name); },
    remove(name) { el._classes = el._classes.filter(item => item !== name); },
    contains(name) { return el._classes.includes(name); },
    toggle(name, force) {
      const on = force === undefined ? !el._classes.includes(name) : !!force;
      if (on) this.add(name); else this.remove(name);
      return on;
    },
  };
}

function createCard({ turnId, sessionId, role, text, time, orphan = false }) {
  const card = {
    _classes: role === 'user' ? ['turn-card', 'user'] : ['turn-card'],
    orphan,
    dataset: { turnId, sessionId },
    attrs: {},
    role,
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    querySelector(selector) {
      if (selector === '.turn-body') return { innerText: text };
      if (selector === '.turn-head .turn-meta') return { textContent: time || '' };
      return null;
    },
    closest(selector) { return selector === '.turn-card' ? card : null; },
    // 模拟 patchTurnCardInPlace：除 data-session-id 外的属性（含 class）全没了。
    simulateInPlacePatch() {
      this._classes = ['turn-card'];
      this.attrs = {};
    },
  };
  card.classList = createClassList(card);
  return card;
}

function createHarness({ sessionId = 'S1', cards = [] } = {}) {
  const listeners = new Map();
  const overlay = {
    _classes: ['msg-overlay'],
    querySelectorAll() { return cards.slice(); },
    addEventListener(type, fn, capture) { listeners.set(`${type}:${!!capture}`, fn); },
    removeEventListener(type, _fn, capture) { listeners.delete(`${type}:${!!capture}`); },
  };
  overlay.classList = createClassList(overlay);

  function button(id, label) {
    return {
      id,
      dataset: {},
      textContent: label,
      disabled: false,
      _classes: [],
      _handlers: {},
      addEventListener(type, fn) { this._handlers[type] = fn; },
      removeEventListener(type) { delete this._handlers[type]; },
      click() { return this._handlers.click && this._handlers.click(); },
      get classList() { return createClassList(this); },
    };
  }
  const bar = { id: 'card-multi-select-bar', hidden: true };
  const countEl = { id: 'card-multi-select-count', textContent: '' };
  const selectAllBtn = button('card-multi-select-all', '全选');
  const copyBtn = button('card-multi-select-copy', '一键复制');
  const exitBtn = button('card-multi-select-exit', '退出多选');
  const byId = {
    'msg-overlay': overlay,
    'card-multi-select-bar': bar,
    'card-multi-select-count': countEl,
    'card-multi-select-all': selectAllBtn,
    'card-multi-select-copy': copyBtn,
    'card-multi-select-exit': exitBtn,
  };
  const docListeners = new Map();
  const doc = {
    activeElement: null,
    getElementById: id => byId[id] || null,
    addEventListener(type, fn, capture) { docListeners.set(`${type}:${!!capture}`, fn); },
    removeEventListener(type, _fn, capture) { docListeners.delete(`${type}:${!!capture}`); },
  };
  const copied = [];
  let currentSession = sessionId;
  const controller = createCardMultiSelectController({
    document: doc,
    window: { requestAnimationFrame: fn => fn() },
    getActiveSessionId: () => currentSession,
    getTurnById: turnId => {
      const card = cards.find(item => item.dataset.turnId === turnId);
      // orphan = 乐观 user 卡片：DOM 里有，_sessionTurns 里没有。
      if (!card || card.orphan) return null;
      return { role: card.role, kind: 'claude', model: 'claude-opus-5' };
    },
    extractVisibleCardText: root => String((root && root.innerText) || '').trim(),
    copyText: async text => { copied.push(text); return { ok: true }; },
  });
  return {
    bar, cards, controller, copied, copyBtn, countEl, exitBtn, overlay, selectAllBtn,
    clickOverlay(card) { listeners.get('click:true')({ target: card, preventDefault() {}, stopPropagation() {} }); },
    pressEscape(extra = {}) {
      docListeners.get('keydown:true')({ key: 'Escape', preventDefault() {}, stopPropagation() {}, ...extra });
    },
    setActiveElement(el) { doc.activeElement = el; },
    setSession(next) { currentSession = next; },
  };
}

test('逐条转发格式：保持卡片顺序、一条一块、带发言人与时间', () => {
  const result = formatSelectedMessages([
    { role: 'user', text: '  问题一  ', time: '10:00' },
    { role: 'assistant', text: '回答一', kind: 'codex', model: 'gpt-5.6-sol', time: '10:01' },
    { role: 'assistant', text: '   ', kind: 'claude' },
    { role: 'system', text: '不该出现' },
  ]);
  assert.equal(result.copiedCount, 2, '空文本与非对话角色都不计入');
  assert.match(result.text, /^===== 转发 2 条消息 =====\n\n/);
  assert.match(result.text, /【1】我 · 10:00\n问题一/);
  assert.match(result.text, /【2】AI（Codex · gpt-5\.6-sol） · 10:01\n回答一/);
  assert.doesNotMatch(result.text, /不该出现/);
  assert.doesNotMatch(result.text, /第 1 轮/, '多选是逐条，不是按轮分组');
});

test('全空选择不产生剪贴板文本', () => {
  assert.deepEqual(formatSelectedMessages([]), { text: '', copiedCount: 0 });
  assert.equal(formatSelectedMessages([{ role: 'user', text: '   ' }]).copiedCount, 0);
});

test('没时间戳时不留下孤零零的分隔点', () => {
  const result = formatSelectedMessages([{ role: 'user', text: '问题' }]);
  assert.match(result.text, /【1】我\n问题/);
});

test('进入多选会预选起点卡片，勾选/取消都落在 turnId 集合上', () => {
  const cards = [
    createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一', time: '10:00' }),
    createCard({ turnId: 't2', sessionId: 'S1', role: 'assistant', text: '回答一', time: '10:01' }),
  ];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  assert.equal(h.controller.enter('t2'), true);
  assert.deepEqual(h.controller.selectedTurnIds(), ['t2']);
  assert.equal(h.bar.hidden, false);
  assert.equal(h.countEl.textContent, '已选 1 条');
  assert.equal(h.overlay.classList.contains('multi-select-active'), true);
  assert.equal(cards[1].classList.contains('multi-selected'), true);
  assert.equal(cards[1].attrs['aria-checked'], 'true');
  assert.equal(cards[1].attrs.role, 'checkbox', 'aria-checked 必须配 role 才有效');
  assert.equal(cards[0].attrs['aria-checked'], 'false');

  h.clickOverlay(cards[0]);
  assert.deepEqual(h.controller.selectedTurnIds().sort(), ['t1', 't2']);
  h.clickOverlay(cards[1]);
  assert.deepEqual(h.controller.selectedTurnIds(), ['t1']);
});

test('卡片被原地重渲染抹掉 class 后，勾选状态必须能重贴回去', () => {
  const cards = [
    createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' }),
    createCard({ turnId: 't2', sessionId: 'S1', role: 'assistant', text: '回答一' }),
  ];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t1');
  cards[0].simulateInPlacePatch();
  assert.equal(cards[0].classList.contains('multi-selected'), false, '重渲染确实抹掉了 class');
  h.controller.syncDom();
  assert.equal(cards[0].classList.contains('multi-selected'), true, '状态以 turnId 集合为准，DOM 只是投影');
  assert.equal(cards[0].attrs['aria-checked'], 'true');
});

test('一键复制按卡片顺序拼文本；未选中时给出可见反馈而不是静默', async () => {
  const cards = [
    createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一', time: '10:00' }),
    createCard({ turnId: 't2', sessionId: 'S1', role: 'assistant', text: '回答一', time: '10:01' }),
    createCard({ turnId: 't3', sessionId: 'S1', role: 'user', text: '问题二', time: '10:02' }),
  ];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t3');
  h.controller.toggle('t1');
  const result = await h.controller.copySelected();
  assert.equal(result.copiedCount, 2);
  assert.equal(h.copied.length, 1);
  assert.match(h.copied[0], /【1】我 · 10:00\n问题一[\s\S]*【2】我 · 10:02\n问题二/,
    '顺序按卡片先后，不按点击先后');
  assert.doesNotMatch(h.copied[0], /回答一/);
  assert.equal(h.copyBtn.textContent, '已复制 2 条');

  h.controller.clearSelection();
  assert.equal(h.copyBtn.disabled, true);
  const empty = await h.controller.copySelected();
  assert.equal(empty.copiedCount, 0);
  assert.equal(h.copyBtn.textContent, '未选中内容');
});

test('历史重载的空窗期不许把勾选静默清空', async () => {
  // loadSessionHistoryToOverlay 的非增量路径：先同步 innerHTML=''，再 await 一次
  // 真 IPC + 读盘解析，中间几百毫秒 overlay 里一张卡都没有。这条路径会被
  // session-meta-updated / Codex 历史重试 / turn-complete backfill 被动触发 ——
  // 老实现在那一帧就把整个 selected 剪没了，用户勾的 2 条无声消失。
  const saved = [
    createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一', time: '10:00' }),
    createCard({ turnId: 't2', sessionId: 'S1', role: 'assistant', text: '回答一', time: '10:01' }),
  ];
  const cards = saved.slice();
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t1');
  h.controller.toggle('t2');
  assert.equal(h.countEl.textContent, '已选 2 条');

  cards.length = 0;            // innerHTML = ''
  h.controller.syncDom();      // 空窗期里被 MutationObserver 叫醒
  assert.equal(h.countEl.textContent, '已选 0 条', '空窗期计数如实归零');
  assert.equal(h.copyBtn.disabled, true, '空窗期不许复制出半截内容');

  saved.forEach(card => { card.simulateInPlacePatch(); cards.push(card); });  // 卡片带着同样的 turnId 挂回来
  h.controller.syncDom();
  assert.equal(h.countEl.textContent, '已选 2 条', '卡片回来后勾选必须自动亮回来');
  assert.equal(saved[0].classList.contains('multi-selected'), true);
  assert.equal(saved[1].classList.contains('multi-selected'), true);
  const result = await h.controller.copySelected();
  assert.equal(result.copiedCount, 2);
});

test('Esc 要给输入法候选窗和已处理过的按键让路', () => {
  const cards = [createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' })];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);

  h.controller.enter('t1');
  h.pressEscape({ isComposing: true });
  assert.equal(h.controller.isActive(), true, '输入法候选窗里的 Esc 是取消候选，不是退出多选');

  h.pressEscape({ defaultPrevented: true });
  assert.equal(h.controller.isActive(), true, '更上层已经处理过就不再抢');

  // 反过来：不能按「焦点在输入框」让路。卡片视图下焦点默认就在浮动输入框里，
  // 那样 Esc 在最常见的情形下直接失灵。
  h.setActiveElement({ tagName: 'TEXTAREA' });
  h.pressEscape();
  assert.equal(h.controller.isActive(), false, '焦点在输入框时 Esc 仍然必须能退出多选');
});

test('乐观 user 卡片（还没进 _sessionTurns）不能被静默丢掉', async () => {
  const cards = [
    createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '已落盘的问题', time: '10:00' }),
    createCard({ turnId: 'pending-user-1', sessionId: 'S1', role: 'user', text: '刚发出去的问题', time: '10:05', orphan: true }),
  ];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t1');
  h.controller.selectAll();
  assert.equal(h.countEl.textContent, '已选 2 条');
  const result = await h.controller.copySelected();
  assert.equal(result.copiedCount, 2, '操作条说 2 条，剪贴板就必须是 2 条');
  assert.match(h.copied[0], /【2】我 · 10:05\n刚发出去的问题/);
});

test('剪贴板写入失败必须显式报错，不能假装成功', async () => {
  const cards = [createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' })];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t1');
  const broken = createCardMultiSelectController({
    document: {
      getElementById: id => ({
        'msg-overlay': h.overlay,
        'card-multi-select-bar': h.bar,
        'card-multi-select-count': h.countEl,
        'card-multi-select-all': h.selectAllBtn,
        'card-multi-select-copy': h.copyBtn,
        'card-multi-select-exit': h.exitBtn,
      })[id] || null,
      addEventListener() {},
      removeEventListener() {},
    },
    window: { requestAnimationFrame: fn => fn() },
    getActiveSessionId: () => 'S1',
    getTurnById: () => ({ role: 'user' }),
    extractVisibleCardText: root => String((root && root.innerText) || '').trim(),
    copyText: async () => ({ ok: false, reason: 'clipboard-busy' }),
  });
  broken.init();
  broken.setVisible(true);
  broken.enter('t1');
  const result = await broken.copySelected();
  assert.equal(result.error, 'clipboard-busy');
  assert.equal(h.copyBtn.textContent, '复制失败');
});

test('全选 / 取消全选 / 退出 / Esc 都把状态收干净', () => {
  const cards = [
    createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' }),
    createCard({ turnId: 't2', sessionId: 'S1', role: 'assistant', text: '回答一' }),
  ];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t1');
  assert.equal(h.controller.selectAll(), 2);
  assert.equal(h.selectAllBtn.textContent, '取消全选');
  h.selectAllBtn.click();
  assert.equal(h.controller.selectedCount(), 0);
  assert.equal(h.selectAllBtn.textContent, '全选');

  h.controller.selectAll();
  h.pressEscape();
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.controller.selectedCount(), 0);
  assert.equal(h.bar.hidden, true);
  assert.equal(h.overlay.classList.contains('multi-select-active'), false);
  assert.equal(cards[0].classList.contains('multi-selected'), false);
  assert.equal(cards[0].attrs['aria-checked'], undefined);
  assert.equal(cards[0].attrs.role, undefined, '退出多选要把 role 一起摘掉');
});

test('切走视图 / 切换会话都必须退出多选，避免把上一个会话的卡片复制出去', () => {
  const cards = [createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' })];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.controller.enter('t1');
  h.controller.setVisible(false);
  assert.equal(h.controller.isActive(), false, '离开卡片视图就退出多选');

  h.controller.setVisible(true);
  h.controller.enter('t1');
  h.setSession('S2');
  h.controller.syncDom();
  assert.equal(h.controller.isActive(), false, '会话换了，勾选集合失效');
  assert.equal(h.controller.selectedCount(), 0);
});

test('未进入多选时，点击卡片和 toggle 都不产生任何选择', () => {
  const cards = [createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' })];
  const h = createHarness({ cards });
  h.controller.init();
  h.controller.setVisible(true);
  h.clickOverlay(cards[0]);
  assert.equal(h.controller.selectedCount(), 0);
  assert.equal(h.controller.toggle('t1'), false);
});

test('卡片视图不可见时不允许进入多选', () => {
  const cards = [createCard({ turnId: 't1', sessionId: 'S1', role: 'user', text: '问题一' })];
  const h = createHarness({ cards });
  h.controller.init();
  assert.equal(h.controller.enter('t1'), false);
  assert.equal(h.bar.hidden, true);
});

// ---------------------------------------------------------------------------
// 接线契约：这些点一旦被后来的重构挪走，功能会静默失效（按钮点了没反应 /
// 关一个会话后操作条永久消失 / 剪贴板出现第二个写入方）。
// ---------------------------------------------------------------------------
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/index.html');
const renderer = read('renderer/renderer.js');
const css = read('renderer/styles/card-view.css');
const cardRenderer = read('renderer/turn-card-renderer.js');
const controllerSource = read('renderer/card-multi-select.js');

test('每条消息保留一个中文多选入口；紧凑进展放在本行更多菜单内', () => {
  const {createTurnCardRenderer}=require('../renderer/turn-card-renderer');
  const view=createTurnCardRenderer({document:{addEventListener(){}},window:{},navigator:{},
    escapeHtml:s=>String(s || ''),marked:{parse:s=>'<p>'+s+'</p>'},DOMPurify:{sanitize:s=>s},
    formatAbsoluteTime:()=>'',normalizeMarkdownPathBreaks:s=>s});
  for(const turn of [{role:'user'}, {role:'assistant',phase:'commentary'}, {role:'assistant',phase:'final_answer'}]) {
    const rendered=view.renderTurnCard({...turn,id:'message',text:'正文'});
    assert.equal((rendered.match(/data-action="multi-select"/g)||[]).length,1);
    assert.match(rendered,/card-actions-popover[\s\S]*data-action="multi-select"[^>]*>多选</);
    if(turn.phase==='commentary')assert.match(rendered,/conversation-progress-actions[\s\S]*data-action="multi-select"/);
    else assert.match(rendered,/turn-actions[\s\S]*data-action="multi-select"/);
  }
});

test('操作条节点存在且能挺过终端面板重建', () => {
  assert.match(html, /id="card-multi-select-bar"[^>]*hidden/);
  assert.match(html, /id="card-multi-select-copy"[\s\S]{0,40}>一键复制</);
  assert.match(html, /id="card-multi-select-all"[\s\S]{0,30}>全选</);
  assert.match(renderer, /document\.getElementById\('card-multi-select-bar'\)[\s\S]{0,80}preserved\.forEach/);
});

test('可见性跟着卡片视图 + 激活会话走', () => {
  assert.match(renderer, /cardMultiSelectController\.setVisible\(mode === 'card' && !!activeSessionId\)/);
  assert.match(renderer, /cardMultiSelectController\.setVisible\(currentView === 'card' && !!activeSessionId\)/);
});

test('剪贴板仍然只有一个写入方', () => {
  assert.match(renderer, /cardMultiSelectController = createCardMultiSelectController\(\{[\s\S]{0,400}clipboardController\.copyText/);
  assert.doesNotMatch(controllerSource, /navigator\.clipboard\.writeText\(text\)\s*;/,
    '正常路径不得直接写 navigator.clipboard');
});

test('小圆圈用伪元素画，勾选态另有样式', () => {
  assert.match(css, /\.msg-overlay\.multi-select-active \.turn-card::before/);
  assert.match(css, /\.msg-overlay\.multi-select-active \.turn-card\.multi-selected::before/);
  assert.match(css, /\.msg-overlay\.multi-select-active \.turn-card\.user::before \{ order: 1; \}/,
    '用户气泡是 row-reverse，不给 order 圆圈会跑到最右边');
  assert.match(css, /\.msg-overlay\.multi-select-active \.turn-actions \{ display: none; \}/);
  assert.match(css, /\.card-multi-select-bar\[hidden\] \{ display: none !important; \}/);
});
