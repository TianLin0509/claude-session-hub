// Regression for 2026-05-24 bug: streaming 中 mount 多个 turn,第三个起
// container.insertBefore 撞到嵌套在 turn-card.turn-head 内的 streaming-indicator
// 抛 NotFoundError → for 循环中断 → 历史 turn 全丢。
//
// 修复: turn-card-renderer.js 把 querySelector('.streaming-indicator') 改成
// querySelector(':scope > .streaming-indicator') 只匹配 container 直接子。
//
// 这个测试用最小 DOM mock 复现 W3C 标准的 insertBefore + :scope > 行为。
// jsdom 没装 (会触发"node_modules 风险操作"), 手撸 mock 够用。

const test = require('node:test');
const assert = require('node:assert');
const { createTurnCardRenderer } = require('../renderer/turn-card-renderer.js');

// ---------------------------------------------------------------------------
// Minimal DOM mock — only what mountSessionTurnCard / mountOptimisticUserCard 用到
// ---------------------------------------------------------------------------
class DOMException extends Error {
  constructor(msg, name) { super(msg); this.name = name || 'Error'; }
}

class MockNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this._textContent = '';
    this._attributes = {};
    this._eventListeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
  }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
  set innerHTML(html) {
    // 简化:清空 children;不解析 HTML(测试不验证渲染内容)
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._innerHTML = html;
    // 给 createElement('div').innerHTML = '<div...>...</div>' 这种用法返回一个子节点
    // mountSessionTurnCard 用 tmp.innerHTML = renderTurnCard(...); tmp.firstElementChild
    // 我们靠 firstElementChild getter 在 createElement 后续设 firstElementChild 来满足
    if (html && html.trim()) {
      const fake = new MockNode('div');
      fake.parentNode = this;
      fake.dataset = {};
      fake.className = 'turn-card';
      this.children.push(fake);
    }
  }
  get innerHTML() { return this._innerHTML || ''; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n, ref) {
    // W3C 标准:ref 必须是 this 的直接子节点
    if (ref.parentNode !== this) {
      throw new DOMException(
        "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
        'NotFoundError'
      );
    }
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) { this.children.splice(i, 1); n.parentNode = null; }
    return n;
  }
  removeAttribute() {}
  setAttribute(k, v) { this._attributes[k] = v; }
  getAttribute(k) { return this._attributes[k]; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener() {}
  replaceWith(n) {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i < 0) return;
    this.parentNode.children[i] = n;
    n.parentNode = this.parentNode;
    this.parentNode = null;
  }
  // 选择器:支持 `:scope > .X`(直接子) / `.X`(递归) / `.X[data-Y="Z"]`(简化为只看 .X)
  // mountSessionTurnCard 用 `container.querySelector('.streaming-indicator')` 找 indicator,
  // 用 `container.querySelector('.turn-card[data-turn-id="..."]')` 找 existing
  // 用 `cardEl.querySelector('.turn-body')` 找 body 等(在新建 DOM 中)
  querySelector(sel) {
    // 解析:可能形如 ".cls", ":scope > .cls", ".cls[attr=val]"
    let scopeDirect = false;
    let s = sel;
    if (s.startsWith(':scope > ')) {
      scopeDirect = true;
      s = s.slice(':scope > '.length);
    }
    // 提取 class
    const clsM = s.match(/^\.([\w-]+)/);
    if (!clsM) return null;
    const cls = clsM[1];
    // 属性过滤(简化:支持 data-turn-id="X")
    const attrM = s.match(/\[data-turn-id="([^"]*)"\]/);
    const wantTurnId = attrM ? attrM[1] : null;
    const match = (n) => {
      if (!n.className) return false;
      const classes = n.className.split(/\s+/);
      if (!classes.includes(cls)) return false;
      if (wantTurnId !== null && (n.dataset && n.dataset.turnId) !== wantTurnId) return false;
      return true;
    };
    if (scopeDirect) {
      return this.children.find(match) || null;
    }
    // 递归
    const dfs = (n) => {
      for (const c of n.children) {
        if (match(c)) return c;
        const f = dfs(c);
        if (f) return f;
      }
      return null;
    };
    return dfs(this);
  }
  querySelectorAll(sel) {
    // 仅 mountSessionTurnCard 内未直接调,这里给个空实现兼容
    const out = [];
    const clsM = sel.match(/\.([\w-]+)/);
    if (!clsM) return out;
    const cls = clsM[1];
    const dfs = (n) => {
      for (const c of n.children) {
        if (c.className && c.className.split(/\s+/).includes(cls)) out.push(c);
        dfs(c);
      }
    };
    dfs(this);
    return out;
  }
}

function makeMockDoc() {
  const doc = {
    createElement(tag) {
      const n = new MockNode(tag);
      return n;
    },
    getElementById() { return null; },
    addEventListener() {},
    querySelector() { return null; },
  };
  return doc;
}

function makeRenderer(extra = {}) {
  const doc = makeMockDoc();
  const win = { _sessionTurns: new Map(), navigator: { clipboard: { writeText: () => Promise.resolve() } } };
  // marked.parse / DOMPurify.sanitize: 直通返回字符串
  const marked = { parse: (s) => String(s || '') };
  const DOMPurify = { sanitize: (s) => String(s || '') };
  return {
    doc, win,
    renderer: createTurnCardRenderer({
      document: doc,
      window: win,
      navigator: win.navigator,
      CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
      marked,
      DOMPurify,
      formatAbsoluteTime: (ms) => new Date(ms).toISOString(),
      normalizeMarkdownPathBreaks: (s) => s || '',
      escapeHtml: (s) => String(s || ''),
      wrapPathLinksInElement: () => {},
      getActiveSessionId: () => 'sid-test',
      updateStreamingIndicator: extra.updateStreamingIndicator || (() => {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// 关键 helper:模拟 renderer.js 的 _updateStreamingIndicator W15 v2 行为 ——
// 把 indicator 迁移到最后一张 assistant turn-card 的 .turn-head 内(嵌套位置)
// ---------------------------------------------------------------------------
function makeMigratingIndicatorUpdater(doc, overlay) {
  return function updateStreamingIndicator(/* sessionId */) {
    // 模拟 isRunning = true 期间的逻辑
    const allCards = overlay.querySelectorAll('.turn-card');
    // 模拟 :not(.user) 过滤
    const allAssistant = allCards.filter(c => {
      const cls = (c.className || '').split(/\s+/);
      return cls.includes('turn-card') && !cls.includes('user');
    });
    const lastAssistant = allAssistant[allAssistant.length - 1];
    // 不需要真的 querySelector .turn-head — 在 mock 里假设 turn-card 第一个 child 是 turn-head
    // 但 mountSessionTurnCard 通过 innerHTML 设置卡片,我们 mock 的 innerHTML 只创建一个空壳
    // 所以这里直接用 lastAssistant 作为嵌套容器(等价于 turn-head)
    const targetParent = lastAssistant || overlay;
    let indicator = overlay.querySelector('.streaming-indicator');
    if (!indicator) {
      indicator = doc.createElement('span');
      indicator.className = 'streaming-indicator';
      targetParent.appendChild(indicator);
    } else if (indicator.parentElement !== targetParent) {
      targetParent.appendChild(indicator);
    }
  };
}

function mkTurn(id, role) {
  return { id, role, text: `text-${id}`, ts: Date.now(), toolCalls: [] };
}

// ===========================================================================
// 测试 1 (regression): streaming 中 indicator 嵌套到 turn-card 后,
// 后续 turn mount 不应抛 NotFoundError,所有 turn 都应进 DOM
// ===========================================================================
test('streaming indicator nesting: mountSessionTurnCard does NOT throw when indicator is migrated into a turn-card', () => {
  let updater = null;
  const { doc, renderer } = makeRenderer({
    updateStreamingIndicator: (...args) => updater && updater(...args),
  });
  const overlay = doc.createElement('div');
  overlay._isOverlay = true;
  // mountSessionTurnCard 通过 doc.getElementById('msg-overlay') 拿 container,
  // 但它支持 opts.container 直接传入 → 用这个避开 mock 全局 lookup
  updater = makeMigratingIndicatorUpdater(doc, overlay);

  const turns = [
    mkTurn('u1', 'user'),
    mkTurn('a1', 'assistant'),
    mkTurn('u2', 'user'),
    mkTurn('a2', 'assistant'),
  ];

  const mounted = [];
  let threw = null;
  for (const t of turns) {
    try {
      const card = renderer.mountSessionTurnCard('sid-test', t, { container: overlay });
      if (card) {
        // mock 的 innerHTML setter 会自动创一个 'turn-card' class 的子节点 —— 这里手动
        // 把 turn 的 role 写到 className 上,让 :not(.user) 过滤生效
        const justMounted = overlay.children[overlay.children.length - 1] === card
          ? card
          : overlay.children.find(c => c.dataset && c.dataset.turnId === t.id);
        // mountSessionTurnCard 内部走 innerHTML='...' → 我们 mock 创建的壳 className 只有 'turn-card'
        // 这里手动追加 user class 反映角色
        const target = card || justMounted;
        if (target && t.role === 'user') target.className = 'turn-card user';
        else if (target) target.className = 'turn-card';
        target.dataset = { ...(target.dataset || {}), turnId: t.id };
        mounted.push(t.id);
      }
    } catch (err) {
      threw = err;
      break;
    }
  }
  assert.strictEqual(threw, null,
    `mountSessionTurnCard should not throw; got: ${threw && threw.name}: ${threw && threw.message}`);
  assert.strictEqual(mounted.length, 4, `all 4 turns should mount; got ${mounted.length}: [${mounted.join(',')}]`);
  assert.deepStrictEqual(mounted, ['u1', 'a1', 'u2', 'a2']);
});

// ===========================================================================
// 测试 2: mountOptimisticUserCard 同样不应被嵌套 indicator 撞挂
// ===========================================================================
test('streaming indicator nesting: mountOptimisticUserCard does NOT throw when indicator is migrated into a turn-card', () => {
  const { doc, renderer } = makeRenderer();
  const overlay = doc.createElement('div');
  // 这个 helper 通过 doc.getElementById('msg-overlay') 拿 container —— mock 一下
  doc.getElementById = (id) => (id === 'msg-overlay' ? overlay : null);

  // 先放一张 assistant 卡 + 嵌套 indicator(模拟 streaming 进行中)
  const aCard = doc.createElement('div');
  aCard.className = 'turn-card';
  aCard.dataset = { turnId: 'a1' };
  overlay.appendChild(aCard);
  const indicator = doc.createElement('span');
  indicator.className = 'streaming-indicator';
  aCard.appendChild(indicator);  // 嵌套位置(模拟 W15 v2 迁移后)

  let threw = null;
  try {
    renderer.mountOptimisticUserCard('sid-test', 'hello', 'claude');
  } catch (err) { threw = err; }

  assert.strictEqual(threw, null,
    `mountOptimisticUserCard should not throw; got: ${threw && threw.name}: ${threw && threw.message}`);
  // 应该 mount 上 optimistic 卡
  const userCards = overlay.children.filter(c => (c.dataset && c.dataset.optimistic) === 'true');
  assert.strictEqual(userCards.length, 1, 'optimistic card should be mounted');
});

// ===========================================================================
// 测试 3 (sanity): indicator 在 overlay 直接子位置时,insertBefore 正常工作
// ===========================================================================
test('streaming indicator at overlay direct child: insertBefore mounts new card BEFORE indicator', () => {
  let updater = null;
  const { doc, renderer } = makeRenderer({
    updateStreamingIndicator: (...args) => updater && updater(...args),
  });
  const overlay = doc.createElement('div');
  // 不迁移版本:indicator 始终在 overlay 直接子
  updater = function () {
    let indicator = overlay.querySelector('.streaming-indicator');
    if (!indicator) {
      indicator = doc.createElement('span');
      indicator.className = 'streaming-indicator';
      overlay.appendChild(indicator);
    }
  };
  const t1 = mkTurn('u1', 'user');
  const t2 = mkTurn('a1', 'assistant');
  renderer.mountSessionTurnCard('sid', t1, { container: overlay });
  renderer.mountSessionTurnCard('sid', t2, { container: overlay });
  // overlay 应至少含 2 张 turn-card + 1 indicator,且 indicator 在最后
  const tail = overlay.children[overlay.children.length - 1];
  assert.ok(tail && (tail.className || '').includes('streaming-indicator'),
    `indicator should remain at overlay tail; got className=${tail && tail.className}`);
});

test('assistant card renders both started-at and completed-at timestamps', () => {
  const { renderer } = makeRenderer();
  const html = renderer.renderTurnCard({
    id: 'a-timed',
    role: 'assistant',
    text: 'done',
    ts: 3_000,
    startedAt: 1_000,
    completedAt: 2_000,
    toolCalls: [],
  });
  assert.match(html, /开始/);
  assert.match(html, /完成/);
  assert.ok(html.includes(new Date(1_000).toISOString()));
  assert.ok(html.includes(new Date(2_000).toISOString()));
});
