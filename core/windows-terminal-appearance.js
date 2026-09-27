'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Windows Terminal's built-in Campbell scheme. CLI RGB colors remain untouched.
const CAMPBELL = Object.freeze({
  background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff',
  selectionBackground: '#ffffff', selectionForeground: '#0c0c0c',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
  blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
  brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
  brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
});

// Settings are JSONC: strip comments and trailing commas only outside strings.
// Keeping this local avoids depending on a build tool's transitive JSON parser.
function parseSettings(text) {
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quoted) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; clean += ch; }
    else if (ch === '/' && next === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      clean += ' ';
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unterminated settings comment');
      i = end + 1; clean += ' ';
    } else clean += ch;
  }
  let result = ''; quoted = false; escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (!quoted && ch === ',' && /^\s*[}\]]/.test(clean.slice(i + 1))) continue;
    result += ch;
    if (escaped) escaped = false;
    else if (quoted && ch === '\\') escaped = true;
    else if (ch === '"') quoted = !quoted;
  }
  return JSON.parse(result.replace(/^\uFEFF/, ''));
}

function appearanceFromSettings(settings = {}) {
  const profiles = settings.profiles || {};
  const list = Array.isArray(profiles) ? profiles : profiles.list || [];
  const profile = list.find(p => p.guid === settings.defaultProfile) || {};
  const defaults = profiles.defaults || {};
  const merged = { ...defaults, ...profile, font: { ...defaults.font, ...profile.font } };
  const schemeName = typeof merged.colorScheme === 'string' ? merged.colorScheme : merged.colorScheme?.dark;
  const scheme = (settings.schemes || []).find(s => s.name === schemeName);
  const theme = { ...CAMPBELL };
  const color = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  for (const key of Object.keys(CAMPBELL)) if (color(scheme?.[key])) theme[key] = scheme[key];
  if (color(scheme?.purple)) theme.magenta = scheme.purple;
  if (color(scheme?.brightPurple)) theme.brightMagenta = scheme.brightPurple;
  for (const key of ['background', 'foreground']) if (color(merged[key])) theme[key] = merged[key];
  if (color(merged.cursorColor || scheme?.cursorColor)) theme.cursor = merged.cursorColor || scheme.cursorColor;
  if (color(merged.selectionBackground || scheme?.selectionBackground)) {
    theme.selectionBackground = merged.selectionBackground || scheme.selectionBackground;
  }
  theme.cursorAccent = theme.background;
  const face = merged.font.face || merged.fontFace;
  const size = Number(merged.font.size || merged.fontSize || 12);
  return {
    theme,
    fontFamily: typeof face === 'string' && face.trim()
      ? `${JSON.stringify(face)}, 'Cascadia Mono', Consolas, monospace`
      : "'Cascadia Mono', Consolas, monospace",
    // Windows Terminal uses points; xterm uses CSS pixels (96 dpi / 72 pt).
    fontScale: Number.isFinite(size) && size >= 6 && size <= 36 ? size / 12 : 1,
    lineHeight: 1,
    source: 'Windows Terminal',
    warning: schemeName && schemeName !== 'Campbell' && !scheme
      ? `Windows Terminal scheme ${schemeName} is not in settings; using Campbell` : null,
  };
}

function readWindowsTerminalAppearance({ env = process.env, readFile = fs.readFileSync, warn = console.warn } = {}) {
  const local = env.LOCALAPPDATA;
  if (!local) return appearanceFromSettings();
  const candidates = [
    path.join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  for (const file of candidates) {
    try {
      const appearance = appearanceFromSettings(parseSettings(readFile(file, 'utf8')));
      if (appearance.warning) warn('[terminal-appearance] ' + appearance.warning);
      return { ...appearance, source: file };
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`[terminal-appearance] Cannot read ${file}: ${error.message}`);
    }
  }
  return appearanceFromSettings();
}

module.exports = { CAMPBELL, parseSettings, appearanceFromSettings, readWindowsTerminalAppearance };
