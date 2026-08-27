'use strict';

const {
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEME_ATTRIBUTE,
  normalizeTheme,
  nextTheme,
} = require('../core/theme-config.js');

const GITHUB_DARK = {
  background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
  cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d364', brightWhite: '#ffffff',
};

/**
 * 终端在所有主题下都用同一套深色调色板（方案 T1「深色终端岛」）。
 *
 * 不给浅色皮肤另配 light ANSI 的原因：xterm 里跑的是 Claude Code / Codex /
 * Gemini / Kimi 的 TUI，它们用 dim 灰自绘框线和分隔符，浅底下几乎看不见，
 * brightBlack 一类更是直接糊掉。要换必须逐个 CLI 实测过才算数。
 * 浅色皮肤改为把这块恒深区域收成圆角内缩的嵌入式终端（见 base.css 的
 * --machine-island-*），而不是硬把 ANSI 反色。
 *
 * 结构上留成映射：将来真要做 light ANSI，只需在这里补一套并逐 CLI 验收，
 * 调用方不用改。
 */
const XTERM_THEMES = THEMES.reduce((acc, t) => {
  acc[t.id] = GITHUB_DARK;
  return acc;
}, {});

function resolveXtermTheme(theme) {
  return XTERM_THEMES[normalizeTheme(theme)] || XTERM_THEMES[DEFAULT_THEME];
}

/**
 * 运行时换主题后强制整树重算样式。
 *
 * Chromium 不会把 :root 上 data-theme 的变化完整传播给所有引用 var() 的后代。
 * 隔离实例实测：419 个可见元素里有 15 个（侧栏搜索入口、会话筛选 tab、章节动作
 * 按钮等）停在上一个主题的颜色上，等多久都不会自己恢复。冷启动时每套皮肤都正确，
 * 只有运行时切换会踩到，所以很容易在开发期漏掉。
 *
 * 短暂 display:none 会把渲染树拆掉，挂回来时样式必然重算。中间那次 offsetHeight
 * 读取是必须的——不强制 flush，浏览器会把两次赋值合并成无事发生。
 * 代价是一帧，换主题本来就是低频操作。
 */
function forceStyleRecalc(root) {
  if (!root || !root.style) return;
  const previous = root.style.display;
  try {
    root.style.display = 'none';
    void root.offsetHeight;
  } finally {
    root.style.display = previous;
  }
}

function buildPickerMarkup() {
  // 菜单项照 THEMES 清单生成：加皮肤只改 core/theme-config.js，这里不用动。
  return THEMES.map(t => (
    '<button type="button" class="options-theme-item" role="radio" aria-checked="false"'
    + ' data-theme-id="' + t.id + '">'
    + '<span class="options-theme-swatch" aria-hidden="true">'
    + t.swatch.map(c => '<i style="background:' + c + '"></i>').join('')
    + '</span>'
    + '<span class="options-theme-copy"><strong>' + t.label + '</strong>'
    + '<small>' + t.hint + '</small></span>'
    + '<span class="options-theme-check" aria-hidden="true">✓</span>'
    + '</button>'
  )).join('');
}

function createThemeController({ document, localStorage, terminalCache, openConfigModal }) {
  if (!document) throw new Error('document is required');
  if (!terminalCache) throw new Error('terminalCache is required');
  if (typeof openConfigModal !== 'function') throw new Error('openConfigModal is required');

  const store = localStorage || null;

  function readStoredTheme() {
    if (!store || typeof store.getItem !== 'function') return DEFAULT_THEME;
    try {
      return normalizeTheme(store.getItem(THEME_STORAGE_KEY));
    } catch {
      return DEFAULT_THEME;
    }
  }

  function writeStoredTheme(theme) {
    if (!store || typeof store.setItem !== 'function') return;
    try {
      store.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // 存不下只影响下次启动的默认值，不该拦住这次切换。
    }
  }

  // theme-bootstrap.js 已经在首帧前打过一次 data-theme；这里以 DOM 上的实际值
  // 为准，读不到再回落 localStorage，保证控制器和页面看到的是同一套主题。
  let currentTheme = (() => {
    const root = document.documentElement;
    const fromDom = root && typeof root.getAttribute === 'function'
      ? root.getAttribute(THEME_ATTRIBUTE)
      : null;
    return fromDom ? normalizeTheme(fromDom) : readStoredTheme();
  })();

  function syncPicker() {
    const host = document.getElementById('options-theme-picker');
    if (!host || typeof host.querySelectorAll !== 'function') return;
    for (const btn of host.querySelectorAll('[data-theme-id]')) {
      const on = btn.getAttribute('data-theme-id') === currentTheme;
      btn.setAttribute('aria-checked', String(on));
      if (btn.classList && typeof btn.classList.toggle === 'function') {
        btn.classList.toggle('selected', on);
      }
    }
  }

  function renderPicker() {
    const host = document.getElementById('options-theme-picker');
    if (!host) return;
    if (!host.dataset || host.dataset.rendered !== '1') {
      host.innerHTML = buildPickerMarkup();
      if (host.dataset) host.dataset.rendered = '1';
      host.addEventListener('click', (e) => {
        const btn = e.target && typeof e.target.closest === 'function'
          ? e.target.closest('[data-theme-id]')
          : null;
        if (!btn) return;
        e.stopPropagation();
        setTheme(btn.getAttribute('data-theme-id'));
      });
    }
    syncPicker();
  }

  function applyTheme(theme = currentTheme) {
    const previousTheme = currentTheme;
    currentTheme = normalizeTheme(theme);

    const root = document.documentElement;
    if (root && typeof root.setAttribute === 'function') {
      root.setAttribute(THEME_ATTRIBUTE, currentTheme);
    }
    if (previousTheme !== currentTheme) forceStyleRecalc(root);

    const xtermTheme = resolveXtermTheme(currentTheme);
    for (const [, cached] of terminalCache) {
      cached.terminal.options.theme = xtermTheme;
    }

    syncPicker();
    return currentTheme;
  }

  function setTheme(theme) {
    const applied = applyTheme(theme);
    writeStoredTheme(applied);
    return applied;
  }

  /** 循环到下一套，用于快捷键轮换。 */
  function cycleTheme() {
    return setTheme(nextTheme(currentTheme));
  }

  function getTheme() {
    return currentTheme;
  }

  function init() {
    renderPicker();
    applyTheme();

    const optionsBtn = document.getElementById('btn-options');
    const optionsMenu = document.getElementById('options-menu');
    if (!optionsBtn || !optionsMenu) return;

    optionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      optionsMenu.style.display = optionsMenu.style.display === 'none' ? 'block' : 'none';
    });

    document.addEventListener('mousedown', (e) => {
      if (!optionsBtn.contains(e.target) && !optionsMenu.contains(e.target)) {
        optionsMenu.style.display = 'none';
      }
    });

    optionsMenu.addEventListener('mousedown', (e) => {
      if (e.target === optionsMenu) optionsMenu.style.display = 'none';
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && optionsMenu.style.display !== 'none') {
        optionsMenu.style.display = 'none';
      }
    });

    const settingsItem = document.getElementById('options-settings');
    if (settingsItem) {
      settingsItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        optionsMenu.style.display = 'none';
        openConfigModal();
      });
    }
  }

  init();
  return { applyTheme, setTheme, cycleTheme, getTheme, init };
}

module.exports = {
  XTERM_THEMES,
  resolveXtermTheme,
  forceStyleRecalc,
  buildPickerMarkup,
  createThemeController,
};
