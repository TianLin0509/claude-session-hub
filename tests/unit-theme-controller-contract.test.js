const assert = require('assert');
const path = require('path');

const {
  XTERM_THEMES,
  resolveXtermTheme,
  forceStyleRecalc,
  buildPickerMarkup,
  createThemeController,
} = require(path.join(__dirname, '..', 'renderer', 'theme-controller.js'));
const {
  THEMES,
  THEME_IDS,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  normalizeTheme,
  nextTheme,
  getTheme,
  isLightTheme,
} = require(path.join(__dirname, '..', 'core', 'theme-config.js'));

function makeElement() {
  const listeners = {};
  const classes = new Set();
  return {
    style: { display: 'none' },
    dataset: {},
    textContent: '',
    innerHTML: '',
    attributes: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      toggle(cls, on) { if (on) classes.add(cls); else classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    contains() { return false; },
    querySelectorAll() { return []; },
    _classes: classes,
    _listeners: listeners,
  };
}

function makeLocalStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    _data: data,
  };
}

function makeHarness({ stored } = {}) {
  const elements = new Map([
    ['btn-options', makeElement()],
    ['options-menu', makeElement()],
    ['options-theme-picker', makeElement()],
    ['options-settings', makeElement()],
  ]);
  const documentElement = makeElement();
  documentElement._displayWrites = [];
  Object.defineProperty(documentElement.style, 'display', {
    get() { return this._v === undefined ? '' : this._v; },
    set(v) { this._v = v; documentElement._displayWrites.push(v); },
    configurable: true,
  });
  Object.defineProperty(documentElement, 'offsetHeight', {
    get() { documentElement._flushed = (documentElement._flushed || 0) + 1; return 0; },
    configurable: true,
  });
  const terminal = { options: {} };
  const localStorage = makeLocalStorage(stored ? { [THEME_STORAGE_KEY]: stored } : {});
  let settingsOpened = 0;

  const controller = createThemeController({
    document: {
      body: makeElement(),
      documentElement,
      getElementById(id) { return elements.get(id) || null; },
      addEventListener() {},
    },
    localStorage,
    terminalCache: new Map([['s1', { terminal }]]),
    openConfigModal() { settingsOpened += 1; },
  });

  return { controller, elements, documentElement, terminal, localStorage, settingsOpened: () => settingsOpened };
}

async function main() {
  // --- 皮肤清单 ---
  assert.deepStrictEqual(THEME_IDS.slice(), ['dark', 'claude', 'codex', 'hub', 'slate']);
  assert.strictEqual(DEFAULT_THEME, 'dark');
  for (const t of THEMES) {
    assert.ok(t.id && t.label && t.hint, 'every theme needs id/label/hint');
    assert.strictEqual(t.swatch.length, 3, t.id + ' 需要 3 个色板方块');
  }
  assert.strictEqual(isLightTheme('dark'), false);
  assert.strictEqual(isLightTheme('codex'), true);
  assert.strictEqual(getTheme('claude').label, 'Claude 暖米');
  assert.strictEqual(getTheme('banana').id, DEFAULT_THEME);

  assert.strictEqual(normalizeTheme('CODEX'), 'codex');
  assert.strictEqual(normalizeTheme('banana'), DEFAULT_THEME);
  assert.strictEqual(normalizeTheme(null), DEFAULT_THEME);
  // 循环要走完一圈回到原点
  let ring = 'dark';
  for (let i = 0; i < THEME_IDS.length; i++) ring = nextTheme(ring);
  assert.strictEqual(ring, 'dark');

  // --- 菜单是照清单生成的：加皮肤不该再动 controller ---
  const markup = buildPickerMarkup();
  for (const t of THEMES) {
    assert.ok(markup.includes('data-theme-id="' + t.id + '"'), t.id + ' 应出现在菜单里');
    assert.ok(markup.includes(t.label));
  }

  // --- T1：所有主题共用同一套深色终端调色板 ---
  // 这条是故意的。将来真给浅色配了 light ANSI，必须逐个 CLI 实测过再来改这里。
  assert.deepStrictEqual(Object.keys(XTERM_THEMES), THEME_IDS.slice());
  for (const id of THEME_IDS) assert.strictEqual(XTERM_THEMES[id], XTERM_THEMES.dark);
  assert.strictEqual(resolveXtermTheme('codex'), XTERM_THEMES.dark);
  assert.strictEqual(resolveXtermTheme('banana'), XTERM_THEMES[DEFAULT_THEME]);
  assert.strictEqual(resolveXtermTheme(null), XTERM_THEMES[DEFAULT_THEME]);
  assert.strictEqual(XTERM_THEMES.dark.background, '#0d1117');

  // --- 默认：没存过就是深色 ---
  {
    const h = makeHarness();
    assert.strictEqual(h.controller.getTheme(), 'dark');
    assert.strictEqual(h.documentElement.getAttribute('data-theme'), 'dark');
    assert.strictEqual(h.terminal.options.theme, XTERM_THEMES.dark);
    assert.ok(h.elements.get('options-theme-picker').innerHTML.includes('data-theme-id="codex"'));
  }

  // --- 启动时读回已存皮肤 ---
  for (const id of THEME_IDS) {
    const h = makeHarness({ stored: id });
    assert.strictEqual(h.controller.getTheme(), id);
    assert.strictEqual(h.documentElement.getAttribute('data-theme'), id);
  }

  // --- 存的是脏值时回落深色，不该抛 ---
  {
    const h = makeHarness({ stored: 'banana' });
    assert.strictEqual(h.controller.getTheme(), DEFAULT_THEME);
  }

  // --- setTheme：落 DOM + 落盘 ---
  {
    const h = makeHarness();
    assert.strictEqual(h.controller.setTheme('claude'), 'claude');
    assert.strictEqual(h.documentElement.getAttribute('data-theme'), 'claude');
    assert.strictEqual(h.localStorage.getItem(THEME_STORAGE_KEY), 'claude');

    assert.strictEqual(h.controller.setTheme('banana'), DEFAULT_THEME, '不认识的 id 要回落而不是照单全收');
    assert.strictEqual(h.localStorage.getItem(THEME_STORAGE_KEY), DEFAULT_THEME);
  }

  // --- cycleTheme 走完整圈 ---
  {
    const h = makeHarness();
    const seen = [h.controller.getTheme()];
    for (let i = 1; i < THEME_IDS.length; i++) seen.push(h.controller.cycleTheme());
    assert.deepStrictEqual(seen, THEME_IDS.slice());
    assert.strictEqual(h.controller.cycleTheme(), 'dark');
  }

  // --- 运行时换主题必须强制整树重算 ---
  // Chromium 不会把 :root 上 data-theme 的变化完整传播给引用 var() 的后代
  // （实测 419 个可见元素里 15 个停在旧主题的颜色上，等多久都不恢复）。
  // 这条断言守着那个 workaround：display 被写成 none 再还原，中间读过 offsetHeight
  // 强制 flush。删掉 forceStyleRecalc 会让这条挂掉。
  {
    const h = makeHarness();
    h.documentElement._displayWrites.length = 0;
    h.documentElement._flushed = 0;
    h.controller.setTheme('codex');
    assert.deepStrictEqual(h.documentElement._displayWrites, ['none', ''],
      '换主题时应当先 display:none 再还原');
    assert.ok(h.documentElement._flushed >= 1, '还原前必须读 offsetHeight 强制 flush');

    // 主题没变就不该白白拆一次渲染树
    h.documentElement._displayWrites.length = 0;
    h.controller.setTheme('codex');
    assert.deepStrictEqual(h.documentElement._displayWrites, []);
  }

  // --- forceStyleRecalc 对残缺节点必须安全 ---
  {
    assert.doesNotThrow(() => forceStyleRecalc(null));
    assert.doesNotThrow(() => forceStyleRecalc({}));
  }

  // --- 设置入口不受影响 ---
  {
    const h = makeHarness();
    h.elements.get('options-settings')._listeners.click({ stopPropagation() {} });
    assert.strictEqual(h.settingsOpened(), 1);
  }

  // --- localStorage 缺失/抛错时不该拖垮控制器 ---
  {
    const documentElement = makeElement();
    const controller = createThemeController({
      document: {
        body: makeElement(),
        documentElement,
        getElementById() { return null; },
        addEventListener() {},
      },
      localStorage: {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
      },
      terminalCache: new Map(),
      openConfigModal() {},
    });
    assert.strictEqual(controller.getTheme(), DEFAULT_THEME);
    assert.strictEqual(controller.setTheme('slate'), 'slate');
    assert.strictEqual(documentElement.getAttribute('data-theme'), 'slate');
  }

  console.log('unit-theme-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
