'use strict';

/**
 * 主题清单的唯一事实源。
 *
 * 主题是纯渲染层的观感偏好，不影响任何会话/进程状态，所以走 localStorage 而不是
 * config.json：localStorage 是同步读，theme-bootstrap.js 能在首帧前就把
 * data-theme 打上去，不会先闪一下再跳。走 IPC 拿不到这个时序。
 *
 * 加一套新皮肤 = 在这里加一条 + 在 base.css 里加一个 :root[data-theme='<id>'] 块。
 * 别的地方都不用动：菜单是照这份清单生成的。
 */

const THEMES = Object.freeze([
  Object.freeze({
    id: 'dark',
    label: '深色',
    hint: 'GitHub Dark · 默认',
    swatch: Object.freeze(['#0d1117', '#161b22', '#8b5cf6']),
  }),
  Object.freeze({
    id: 'claude',
    label: 'Claude 暖米',
    hint: '米色画布 · 圆角大 · 陶土强调',
    swatch: Object.freeze(['#faf9f5', '#f0eee6', '#c15f3c']),
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex 纸白',
    hint: '纯白 · 紧凑发丝线 · 近乎单色',
    swatch: Object.freeze(['#ffffff', '#fafafa', '#1a1a1a']),
  }),
  Object.freeze({
    id: 'hub',
    label: 'Hub 紫留白',
    hint: '冷灰白 · 保留品牌紫',
    swatch: Object.freeze(['#f7f7fa', '#f1f1f6', '#7c3aed']),
  }),
  Object.freeze({
    id: 'slate',
    label: '低对比灰白',
    hint: '灰底浮卡 · 与深色终端落差最小',
    swatch: Object.freeze(['#f1f2f4', '#e8eaee', '#3b6fe0']),
  }),
]);

const THEME_IDS = Object.freeze(THEMES.map(t => t.id));
const DEFAULT_THEME = 'dark';
const THEME_STORAGE_KEY = 'hub.theme';
const THEME_ATTRIBUTE = 'data-theme';

function normalizeTheme(value) {
  const id = String(value || '').trim().toLowerCase();
  return THEME_IDS.includes(id) ? id : DEFAULT_THEME;
}

function getTheme(value) {
  const id = normalizeTheme(value);
  return THEMES.find(t => t.id === id);
}

/** 循环到下一套，用于快捷键轮换。 */
function nextTheme(value) {
  const i = THEME_IDS.indexOf(normalizeTheme(value));
  return THEME_IDS[(i + 1) % THEME_IDS.length];
}

function isLightTheme(value) {
  return normalizeTheme(value) !== 'dark';
}

module.exports = {
  THEMES,
  THEME_IDS,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEME_ATTRIBUTE,
  normalizeTheme,
  getTheme,
  nextTheme,
  isLightTheme,
};
