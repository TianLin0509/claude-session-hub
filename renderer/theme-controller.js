'use strict';

const THEME_CLASSES = ['theme-midnight', 'theme-obsidian', 'theme-aurora', 'theme-light', 'theme-vibechat-light'];
const XTERM_THEMES = {
  default: {
    background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
    cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#ffffff',
  },
  midnight: {
    background: '#080c14', foreground: '#c8d8f0', cursor: '#58a6ff',
    cursorAccent: '#080c14', selectionBackground: 'rgba(88, 166, 255, 0.3)',
    black: '#1a2540', red: '#ff7b72', green: '#39d353', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#c8d8f0',
    brightBlack: '#3a4a68', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#e0ecff',
  },
  obsidian: {
    background: '#0a0a0a', foreground: '#d4c4a8', cursor: '#e8a040',
    cursorAccent: '#0a0a0a', selectionBackground: 'rgba(232, 160, 64, 0.25)',
    black: '#1a1a1a', red: '#ff7b72', green: '#e8a040', yellow: '#f0b860',
    blue: '#c8a878', magenta: '#d4a080', cyan: '#e8a040', white: '#d4c4a8',
    brightBlack: '#504030', brightRed: '#ffa198', brightGreen: '#f0b860',
    brightYellow: '#f8d080', brightBlue: '#d8c098', brightMagenta: '#e0b898',
    brightCyan: '#f0b860', brightWhite: '#e8d8c0',
  },
  aurora: {
    background: '#0b0e13', foreground: '#b0d0e0', cursor: '#7ee8c8',
    cursorAccent: '#0b0e13', selectionBackground: 'rgba(126, 232, 200, 0.25)',
    black: '#1a1f28', red: '#ff7b72', green: '#7ee8c8', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#7ee8c8', white: '#b0d0e0',
    brightBlack: '#384858', brightRed: '#ffa198', brightGreen: '#a0f0d8',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#a0f0d8', brightWhite: '#d0e8f0',
  },
  'vibechat-light': {
    // Catppuccin Latte（社区现代柔和浅色，米白 #eff1f5 + 高饱和柔色调）
    // diff 色块感优于纯白 GitHub PR 风（参考 mockup vibechat-pty-diff-blocks-7d3f1c.html）
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78',
    cursorAccent: '#eff1f5', selectionBackground: 'rgba(114, 135, 253, 0.20)',
    black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    blue: '#1e66f5', magenta: '#8839ef', cyan: '#179299', white: '#acb0be',
    brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
    brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#8839ef',
    brightCyan: '#179299', brightWhite: '#4c4f69',
  },
};

function createThemeController({ document, localStorage, terminalCache, openConfigModal }) {
  if (!document) throw new Error('document is required');
  if (!localStorage) throw new Error('localStorage is required');
  if (!terminalCache) throw new Error('terminalCache is required');
  if (typeof openConfigModal !== 'function') throw new Error('openConfigModal is required');

  function applyTheme(name) {
    THEME_CLASSES.forEach(c => document.body.classList.remove(c));
    if (name && name !== 'default') document.body.classList.add('theme-' + name);
    localStorage.setItem('claude-hub-theme', name || 'default');
    const popup = document.getElementById('theme-picker-popup');
    if (popup) {
      for (const opt of popup.querySelectorAll('.theme-option')) {
        opt.classList.toggle('active', (opt.dataset.theme || 'default') === (name || 'default'));
      }
    }
    const xt = XTERM_THEMES[name] || XTERM_THEMES.default;
    for (const [, cached] of terminalCache) {
      cached.terminal.options.theme = xt;
    }
  }
  function init() {
    // 默认主题 default（Default Dark，经典深色）
    // 已设过偏好的用户保留 localStorage 旧值；新装 / 从未切过主题的用户首次启动即看到 Default Dark
    const saved = localStorage.getItem('claude-hub-theme') || 'default';
    applyTheme(saved);
    // 主题切换通过"选项"菜单触发
    const optionsBtn = document.getElementById('btn-options');
    const optionsMenu = document.getElementById('options-menu');
    const themeItem = document.getElementById('options-theme');
    const themePopup = document.getElementById('theme-picker-popup');
    if (!optionsBtn || !optionsMenu) return;

    // 选项菜单展开/收起
    optionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      optionsMenu.style.display = optionsMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('mousedown', (e) => {
      if (!optionsBtn.contains(e.target) && !optionsMenu.contains(e.target)) {
        optionsMenu.style.display = 'none';
      }
    });

    // 主题选项点击 -> 显示主题选择弹窗
    if (themeItem && themePopup) {
      themeItem.addEventListener('click', (e) => {
        e.stopPropagation();
        themePopup.style.display = 'block';
        optionsMenu.style.display = 'none';
      });
      for (const opt of themePopup.querySelectorAll('.theme-option')) {
        opt.addEventListener('click', () => {
          applyTheme(opt.dataset.theme);
          themePopup.style.display = 'none';
        });
      }
      document.addEventListener('mousedown', (e) => {
        if (!themePopup.contains(e.target)) themePopup.style.display = 'none';
      });
    }

    // 设置选项点击 -> 打开配置面板
    const settingsItem = document.getElementById('options-settings');
    if (settingsItem) {
      settingsItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        optionsMenu.style.display = 'none';
        openConfigModal();
      });
    }

    initMeridianPopup(optionsMenu);
  }

  async function refreshMeridianBadge() {
    const badge = document.getElementById('meridian-status-badge');
    if (!badge) return;
    try {
      const cfg = await ipcRenderer.invoke('get-hub-config-raw');
      const active = cfg.meridianEnabled && cfg.meridianUrl && cfg.meridianToken;
      badge.textContent = active ? '已启用' : '未启用';
      badge.classList.toggle('meridian-badge-on', !!active);
      badge.classList.toggle('meridian-badge-off', !active);
    } catch {
      badge.textContent = '未配置';
    }
  }

  function initMeridianPopup(optionsMenu) {
    const item = document.getElementById('options-meridian');
    const popup = document.getElementById('meridian-config-popup');
    if (!item || !popup) return;

    const urlInput = document.getElementById('meridian-popup-url');
    const tokenInput = document.getElementById('meridian-popup-token');
    const enableCb = document.getElementById('meridian-popup-enable');
    const testBtn = document.getElementById('meridian-popup-test');
    const saveBtn = document.getElementById('meridian-popup-save');
    const cancelBtn = document.getElementById('meridian-popup-cancel');
    const resultEl = document.getElementById('meridian-popup-result');

    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      optionsMenu.style.display = 'none';
      try {
        const cfg = await ipcRenderer.invoke('get-hub-config-raw');
        urlInput.value = cfg.meridianUrl || 'https://meridian.lthub.xyz:8443';
        tokenInput.value = cfg.meridianToken || '';
        enableCb.checked = !!cfg.meridianEnabled;
        resultEl.textContent = '配置后立即生效（仅影响新建 Claude 会话）';
        resultEl.style.color = '';
      } catch {
        urlInput.value = 'https://meridian.lthub.xyz:8443';
        tokenInput.value = '';
        enableCb.checked = false;
      }
      popup.style.display = 'block';
    });

    cancelBtn.addEventListener('click', () => { popup.style.display = 'none'; });

    testBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      const token = tokenInput.value.trim();
      if (!url || !token) {
        resultEl.textContent = '⚠ URL 和 Token 都必填';
        resultEl.style.color = '#e0a800';
        return;
      }
      testBtn.disabled = true;
      resultEl.textContent = '测试中…';
      resultEl.style.color = '';
      try {
        const r = await ipcRenderer.invoke('test-meridian-health', { url, token });
        if (r.healthOk && r.authOk) {
          resultEl.textContent = `✓ 成功 · 模型 ${r.model} · 延迟 ${r.latencyMs}ms`;
          resultEl.style.color = '#3fb950';
        } else if (r.healthOk && !r.authOk) {
          resultEl.textContent = `✗ URL 通但 Token 失败：${r.errorMessage}`;
          resultEl.style.color = '#f85149';
        } else {
          resultEl.textContent = `✗ ${r.errorMessage}`;
          resultEl.style.color = '#f85149';
        }
      } catch (e) {
        resultEl.textContent = `✗ 测试出错：${e.message || e}`;
        resultEl.style.color = '#f85149';
      } finally {
        testBtn.disabled = false;
      }
    });

    saveBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      const token = tokenInput.value.trim();
      const enabled = enableCb.checked;
      if (enabled && (!url || !token)) {
        resultEl.textContent = '⚠ 启用前请先填 URL 和 Token';
        resultEl.style.color = '#e0a800';
        return;
      }
      saveBtn.disabled = true;
      try {
        const result = await ipcRenderer.invoke('save-hub-config', {
          meridianUrl: url || undefined,
          meridianToken: token || undefined,
          meridianEnabled: enabled,
        });
        // save-hub-config 读现有配置失败时返回 {success:false} 中止保存（防静默覆盖其它 provider 字段）。
        // 必须如实反映失败，否则会"已中止却假报已保存"。
        if (!result || !result.success) {
          throw new Error(result && result.error === 'config_read_failed'
            ? '配置文件暂时不可读（可能被占用），请稍后重试' : '保存失败');
        }
        resultEl.textContent = '✓ 已保存';
        resultEl.style.color = '#3fb950';
        await refreshMeridianBadge();
        setTimeout(() => { popup.style.display = 'none'; }, 600);
      } catch (e) {
        resultEl.textContent = `✗ 保存失败：${e.message || e}`;
        resultEl.style.color = '#f85149';
      } finally {
        saveBtn.disabled = false;
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (popup.style.display !== 'none' && !popup.contains(e.target) && e.target !== item && !item.contains(e.target)) {
        popup.style.display = 'none';
      }
    });

    refreshMeridianBadge();
    if (typeof window !== 'undefined') window.refreshMeridianBadge = refreshMeridianBadge;
  }

  init();
  return { applyTheme, init, refreshMeridianBadge };
}

module.exports = { XTERM_THEMES, createThemeController };
