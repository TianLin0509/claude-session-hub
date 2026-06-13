// PPT 模式（2026-06-11 道雪）：一键全屏面板内嵌华为风格 PPT 一键生成器。
// 纯叠加层（z-index 覆盖），不动 session/会议任何状态；ESC 或 ✕ 关闭即回到原界面；
// 兼容 hub-escape 救援通道（escape-home 会顺带关掉本面板）。
(() => {
  const { ipcRenderer, shell } = require('electron');
  let panel = null;
  let webview = null;
  let statusEl = null;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'ppt-mode-panel';
    panel.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9000', 'display:none',
      'flex-direction:column', 'background:#1d1d1f',
    ].join(';');
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px', 'padding:8px 14px',
      'background:#2c2c2e', 'border-bottom:1px solid #38383a', 'color:#f5f5f7',
      'font-size:13px', 'flex:0 0 auto', '-webkit-app-region:no-drag',
    ].join(';');
    header.innerHTML = `
      <span style="font-weight:700">🎨 PPT 模式</span>
      <span style="color:#aeaeb2">华为风格一键生成 · 输入主题 → 两套候选 → 下载可编辑 PPTX</span>
      <span id="ppt-mode-status" style="color:#ff9f0a;margin-left:auto"></span>
      <button id="ppt-mode-external" title="在系统浏览器打开"
        style="background:none;border:1px solid #48484a;border-radius:6px;color:#f5f5f7;padding:3px 10px;cursor:pointer">浏览器打开</button>
      <button id="ppt-mode-close" title="关闭 PPT 模式 (Esc)"
        style="background:none;border:1px solid #48484a;border-radius:6px;color:#f5f5f7;padding:3px 12px;cursor:pointer">✕ 关闭</button>`;
    panel.appendChild(header);
    webview = document.createElement('webview');
    webview.style.cssText = 'flex:1;width:100%;border:none;background:#fafafa';
    panel.appendChild(webview);
    document.body.appendChild(panel);
    statusEl = header.querySelector('#ppt-mode-status');
    header.querySelector('#ppt-mode-close').addEventListener('click', closePpt);
    header.querySelector('#ppt-mode-external').addEventListener('click', () => {
      if (webview.getAttribute('src')) shell.openExternal(webview.getAttribute('src'));
    });
    return panel;
  }

  async function openPpt() {
    ensurePanel();
    panel.style.display = 'flex';
    statusEl.textContent = '正在启动 PPT 服务…';
    try {
      const r = await ipcRenderer.invoke('ppt-mode-ensure-server');
      if (r && r.error) {
        statusEl.textContent = r.error;
        return;
      }
      statusEl.textContent = '';
      if (webview.getAttribute('src') !== r.url) webview.setAttribute('src', r.url);
    } catch (err) {
      statusEl.textContent = `启动失败: ${err.message}`;
    }
  }

  function closePpt() {
    if (panel) panel.style.display = 'none';
  }

  function isOpen() {
    return panel && panel.style.display !== 'none';
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-ppt-toggle')) {
      isOpen() ? closePpt() : openPpt();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closePpt();
  });
  // hub-escape 救援: 回家时面板必须让路
  ipcRenderer.on('escape-home', closePpt);
})();
