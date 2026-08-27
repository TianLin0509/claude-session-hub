'use strict';

/**
 * 首帧前把主题打到 <html data-theme> 上。
 *
 * 必须在 index.html <head> 里同步 <script src> 引入（CSP 是 script-src 'self'，
 * 内联脚本会被拦，所以只能走独立文件）。经典脚本会阻塞解析，body 还没开始渲染，
 * 因此不会出现"先深后浅"的闪烁。
 *
 * 这里刻意不依赖 renderer.js 的任何东西：整段包在 try/catch 里，任何一步失败都
 * 只是退回没有 data-theme 的状态，base.css 段②的 :root 会兜住深色。
 */

(function bootstrapTheme() {
  try {
    const {
      DEFAULT_THEME,
      THEME_STORAGE_KEY,
      THEME_ATTRIBUTE,
      normalizeTheme,
    } = require('../core/theme-config.js');

    let stored = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      stored = null;
    }

    const theme = normalizeTheme(stored || DEFAULT_THEME);
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  } catch (err) {
    // 主题只是观感，任何异常都不该拦住 Hub 启动。
    try { console.warn('[theme] bootstrap skipped:', err && err.message); } catch { /* noop */ }
  }
})();
