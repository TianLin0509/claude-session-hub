'use strict';

const { normalizeCardDisplayConfig } = require('../core/card-display-config.js');

const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const DEFAULT_CLAUDE_SUBSCRIPTION_MODEL = 'claude-opus-5[1m]';
const DEFAULT_CLAUDE_FABLE_MODEL = 'claude-fable-5';

function createConfigModalController({ document, ipcRenderer, providerModes, renderAccountUsage, applyCardDisplaySettings = () => {} }) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!providerModes) throw new Error('providerModes is required');

  // Config/Settings Modal (API key + proxy)
  const CONFIG_AI_META = {
    claude: {
      title: 'Claude 设置',
      hint: '使用当前本机 Claude Code 登录状态。新建 Claude 会话会走本机订阅和本机代理配置。',
      status: '订阅',
      statusClass: 'subscription',
    },
    gemini: {
      title: 'Gemini 设置',
      hint: '使用当前本机 Gemini CLI 登录状态。代理设置会影响新建 Gemini 会话。',
      status: '订阅',
      statusClass: 'subscription',
    },
    codex: {
      title: 'Codex 设置',
      hint: '全 Hub 新建 Codex 会话统一生效。API 模式会使用隔离 CODEX_HOME，不污染本机订阅配置。',
    },
    kimi: {
      title: 'Kimi Code 设置',
      hint: '使用当前本机 Kimi Code CLI 登录状态；新建会话与群聊成员默认使用 Kimi K3。',
      status: '订阅',
      statusClass: 'subscription',
    },
    deepseek: {
      title: 'DeepSeek 设置',
      hint: 'DeepSeek 当前通过 API 接入，新建 DeepSeek 会话生效。',
      status: 'API',
      statusClass: 'api',
    },
  };
  
  let activeConfigAi = 'codex';
  let codexSubscriptionProfiles = [
    { id: 'default', label: '主账号', home: '' },
    { id: 'second', label: '新账号', home: 'C:\\Users\\lintian\\.codex-profiles\\second' },
  ];
  let codexSubscriptionProfile = 'default';
  let savedCardDisplay = normalizeCardDisplayConfig();
  
  function configEl(id) {
    return document.getElementById(id);
  }

  function readCardDisplayForm() {
    return normalizeCardDisplayConfig({
      cardFontSize: configEl('cfg-card-font-size')?.value,
      cardFontFamily: configEl('cfg-card-font-family')?.value,
    });
  }

  function setCardDisplayForm(config, { apply = true } = {}) {
    const normalized = normalizeCardDisplayConfig(config);
    if (configEl('cfg-card-font-size')) configEl('cfg-card-font-size').value = String(normalized.cardFontSize);
    if (configEl('cfg-card-font-size-value')) configEl('cfg-card-font-size-value').textContent = `${normalized.cardFontSize}px`;
    if (configEl('cfg-card-font-family')) configEl('cfg-card-font-family').value = normalized.cardFontFamily;
    if (apply) applyCardDisplaySettings(normalized);
    return normalized;
  }

  function previewCardDisplay() {
    return setCardDisplayForm(readCardDisplayForm());
  }
  
  function normalizeCodexProfilesForUi(profiles) {
    const byId = new Map(codexSubscriptionProfiles.map(p => [p.id, { ...p }]));
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (!p || typeof p !== 'object') continue;
        const id = String(p.id || '').trim();
        if (!id) continue;
        byId.set(id, {
          id,
          label: String(p.label || id).trim() || id,
          home: String(p.home || '').trim(),
        });
      }
    }
    return [...byId.values()];
  }
  
  function renderCodexProfileSelect(selectedId) {
    const select = configEl('cfg-codex-subscription-profile');
    if (!select) return;
    const selected = selectedId || codexSubscriptionProfile || 'default';
    select.innerHTML = '';
    for (const profile of codexSubscriptionProfiles) {
      const opt = document.createElement('option');
      opt.value = profile.id;
      opt.textContent = profile.label || profile.id;
      select.appendChild(opt);
    }
    select.value = codexSubscriptionProfiles.some(p => p.id === selected) ? selected : 'default';
    codexSubscriptionProfile = select.value;
  }
  
  function setCodexProfileForm(profiles, selectedId) {
    codexSubscriptionProfiles = normalizeCodexProfilesForUi(profiles);
    codexSubscriptionProfile = selectedId || 'default';
    const main = codexSubscriptionProfiles.find(p => p.id === 'default') || { label: '主账号', home: '' };
    const second = codexSubscriptionProfiles.find(p => p.id === 'second') || { label: '新账号', home: '' };
    if (configEl('cfg-codex-profile-default-label')) configEl('cfg-codex-profile-default-label').value = main.label || '主账号';
    if (configEl('cfg-codex-profile-second-label')) configEl('cfg-codex-profile-second-label').value = second.label || '新账号';
    if (configEl('cfg-codex-profile-second-home')) configEl('cfg-codex-profile-second-home').value = second.home || '';
    renderCodexProfileSelect(codexSubscriptionProfile);
    updateCodexProfileMenuLabels();
  }
  
  function readCodexProfilesFromForm() {
    const mainLabel = (configEl('cfg-codex-profile-default-label') && configEl('cfg-codex-profile-default-label').value.trim()) || '主账号';
    const secondLabel = (configEl('cfg-codex-profile-second-label') && configEl('cfg-codex-profile-second-label').value.trim()) || '新账号';
    const secondHome = (configEl('cfg-codex-profile-second-home') && configEl('cfg-codex-profile-second-home').value.trim()) || '';
    codexSubscriptionProfiles = [
      { id: 'default', label: mainLabel, home: '' },
      { id: 'second', label: secondLabel, home: secondHome },
    ];
    return codexSubscriptionProfiles;
  }
  
  function updateCodexProfileMenuLabels() {
    const byId = new Map(codexSubscriptionProfiles.map(p => [p.id, p]));
    document.querySelectorAll('[data-codex-profile-label]').forEach(el => {
      const profile = byId.get(el.dataset.codexProfileLabel);
      if (profile) el.textContent = profile.label || profile.id;
    });
  }
  
  function setConfigStatus(el, label, cls) {
    if (!el) return;
    el.textContent = label;
    el.className = 'config-ai-status ' + (cls || '');
  }

  function updateClaudeBackendControls() {
    const backend = configEl('cfg-claude-backend') ? configEl('cfg-claude-backend').value : 'subscription';
    const isApi = backend === 'api';
    for (const id of ['cfg-claude-key', 'cfg-claude-url', 'cfg-claude-model']) {
      const el = configEl(id);
      if (el) el.disabled = !isApi;
    }
    const subscriptionCard = configEl('cfg-claude-subscription-card');
    const apiCard = configEl('cfg-claude-api-card');
    if (subscriptionCard) subscriptionCard.classList.toggle('selected', !isApi);
    if (apiCard) apiCard.classList.toggle('selected', isApi);
    const routeNote = configEl('cfg-claude-route-note');
    if (routeNote) {
      routeNote.textContent = isApi
        ? '中转端当前使用 HTTP 明文连接。Key、提示词和回复可能在传输链路上被读取。'
        : '中转参数已保存备用；当前订阅模式不会读取或发送中转 Key。';
      routeNote.className = isApi ? 'config-note warning' : 'config-note';
    }
    if (activeConfigAi === 'claude' && configEl('cfg-detail-hint')) {
      configEl('cfg-detail-hint').textContent = isApi
        ? '新建 Claude 会话将直连同事中转，使用已保存的 Key 与 Fable 5 模型。'
        : CONFIG_AI_META.claude.hint;
    }
  }

  function claudeModelDisplayName(model) {
    return model === DEFAULT_CLAUDE_FABLE_MODEL ? 'Fable 5 · 1M' : model;
  }

  function updateConfigSummaries() {
    const claudeBackend = configEl('cfg-claude-backend') ? configEl('cfg-claude-backend').value : 'subscription';
    const claudeModel = configEl('cfg-claude-model') ? (configEl('cfg-claude-model').value.trim() || DEFAULT_CLAUDE_FABLE_MODEL) : DEFAULT_CLAUDE_FABLE_MODEL;
    const claudeKey = configEl('cfg-claude-key') ? configEl('cfg-claude-key').value.trim() : '';
    const codexBackend = configEl('cfg-codex-backend') ? configEl('cfg-codex-backend').value : 'subscription';
    const codexModel = configEl('cfg-codex-model') ? (configEl('cfg-codex-model').value.trim() || DEFAULT_CODEX_MODEL) : DEFAULT_CODEX_MODEL;
    const codexKey = configEl('cfg-codex-key') ? configEl('cfg-codex-key').value.trim() : '';
    const profiles = readCodexProfilesFromForm();
    const profileSelect = configEl('cfg-codex-subscription-profile');
    const selectedProfileId = profileSelect ? profileSelect.value : codexSubscriptionProfile;
    if (profileSelect) renderCodexProfileSelect(selectedProfileId);
    const selectedProfile = profiles.find(p => p.id === selectedProfileId) || profiles[0];
    codexSubscriptionProfile = selectedProfile ? selectedProfile.id : 'default';
    updateCodexProfileMenuLabels();
    const deepseekKey = configEl('cfg-deepseek-key') ? configEl('cfg-deepseek-key').value.trim() : '';
  
    const codexSummary = configEl('cfg-summary-codex');
    if (codexSummary) {
      codexSummary.textContent = codexBackend === 'api'
        ? `第三方 API · ${codexModel} · Packy`
        : `订阅模式 · ${(selectedProfile && selectedProfile.label) || '主账号'} · ${codexModel}`;
    }
    setConfigStatus(
      configEl('cfg-status-codex'),
      codexBackend === 'api' ? (codexKey ? 'API' : '缺 Key') : ((selectedProfile && selectedProfile.label) || '订阅'),
      codexBackend === 'api' ? (codexKey ? 'api' : 'missing') : 'subscription'
    );
  
    const deepseekSummary = configEl('cfg-summary-deepseek');
    if (deepseekSummary) deepseekSummary.textContent = deepseekKey ? 'API · deepseek-v4-pro[1m]' : 'API · 未配置 Key';
    setConfigStatus(configEl('cfg-status-deepseek'), deepseekKey ? 'API' : '缺 Key', deepseekKey ? 'api' : 'missing');

    const claudeSummary = configEl('cfg-summary-claude');
    if (claudeSummary) {
      claudeSummary.textContent = claudeBackend === 'api'
        ? `同事中转 · ${claudeModelDisplayName(claudeModel)}`
        : `订阅模式 · ${DEFAULT_CLAUDE_SUBSCRIPTION_MODEL}`;
    }
    setConfigStatus(
      configEl('cfg-status-claude'),
      claudeBackend === 'api' ? (claudeKey ? '中转' : '缺 Key') : '订阅',
      claudeBackend === 'api' ? (claudeKey ? 'api' : 'missing') : 'subscription'
    );
    if (activeConfigAi === 'claude') {
      setConfigStatus(
        configEl('cfg-detail-status'),
        claudeBackend === 'api' ? (claudeKey ? '中转' : '缺 Key') : '订阅',
        claudeBackend === 'api' ? (claudeKey ? 'api' : 'missing') : 'subscription'
      );
    }

    if (activeConfigAi === 'codex') {
      setConfigStatus(
        configEl('cfg-detail-status'),
        codexBackend === 'api' ? (codexKey ? 'API' : '缺 Key') : ((selectedProfile && selectedProfile.label) || '订阅'),
        codexBackend === 'api' ? (codexKey ? 'api' : 'missing') : 'subscription'
      );
    } else if (activeConfigAi === 'deepseek') {
      setConfigStatus(configEl('cfg-detail-status'), deepseekKey ? 'API' : '缺 Key', deepseekKey ? 'api' : 'missing');
    }
  }
  
  function showConfigMainView() {
    if (configEl('config-main-view')) configEl('config-main-view').classList.remove('hidden');
    if (configEl('config-detail-view')) configEl('config-detail-view').classList.add('hidden');
    document.querySelectorAll('.config-ai-row').forEach(row => row.classList.remove('active'));
    updateConfigSummaries();
  }
  
  function showConfigDetail(ai) {
    activeConfigAi = ai || 'codex';
    const meta = CONFIG_AI_META[activeConfigAi] || CONFIG_AI_META.codex;
    if (configEl('config-main-view')) configEl('config-main-view').classList.add('hidden');
    if (configEl('config-detail-view')) configEl('config-detail-view').classList.remove('hidden');
    if (configEl('cfg-detail-title')) configEl('cfg-detail-title').textContent = meta.title;
    if (configEl('cfg-detail-hint')) configEl('cfg-detail-hint').textContent = meta.hint;
    document.querySelectorAll('.config-ai-row').forEach(row => row.classList.toggle('active', row.dataset.ai === activeConfigAi));
    document.querySelectorAll('.config-ai-detail').forEach(panel => panel.classList.toggle('active', panel.id === 'cfg-detail-' + activeConfigAi));
  
    if (meta.status) {
      setConfigStatus(configEl('cfg-detail-status'), meta.status, meta.statusClass);
    }
    if (activeConfigAi === 'claude') updateClaudeBackendControls();
    updateConfigSummaries();
  }
  
  async function openConfigModal() {
    let modal = document.getElementById('config-modal');
    if (!modal && document.readyState === 'loading') {
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      modal = document.getElementById('config-modal');
    }
    if (!modal) return;
  
    // 加载当前配置
    try {
      const cfg = await ipcRenderer.invoke('get-hub-config-raw');
      providerModes.claude = cfg.claudeBackend === 'api' ? 'api' : 'subscription';
      providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
      setCodexProfileForm(cfg.codexSubscriptionProfiles, cfg.codexSubscriptionProfile);
      document.getElementById('cfg-proxy').value = cfg.proxy || '';
      document.getElementById('cfg-claude-backend').value = cfg.claudeBackend || 'subscription';
      document.getElementById('cfg-claude-key').value = cfg.claudeApiKey || '';
      document.getElementById('cfg-claude-url').value = cfg.claudeApiBaseUrl || '';
      document.getElementById('cfg-claude-model').value = cfg.claudeApiModel || DEFAULT_CLAUDE_FABLE_MODEL;
      document.getElementById('cfg-deepseek-key').value = cfg.deepseekApiKey || '';
      document.getElementById('cfg-codex-backend').value = cfg.codexBackend || 'subscription';
      document.getElementById('cfg-codex-key').value = cfg.codexApiKey || '';
      document.getElementById('cfg-codex-url').value = cfg.codexApiBaseUrl || '';
      document.getElementById('cfg-codex-model').value = cfg.codexApiModel || '';
      savedCardDisplay = setCardDisplayForm(cfg);
      updateClaudeBackendControls();
      updateConfigSummaries();
    } catch {
      // 加载失败也显示空白面板
    }
    showConfigMainView();
    modal.classList.remove('hidden');
  }
  
  function closeConfigModal() {
    applyCardDisplaySettings(savedCardDisplay);
    const modal = document.getElementById('config-modal');
    if (modal) modal.classList.add('hidden');
    const msg = document.getElementById('config-save-msg');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  }
  
  // 配置面板事件（DOM ready 后绑定）
  function initConfigModal() {
    const modal = document.getElementById('config-modal');
    if (!modal) return;
  
    document.getElementById('config-close').addEventListener('click', closeConfigModal);
    document.getElementById('config-cancel').addEventListener('click', closeConfigModal);
    const backBtn = document.getElementById('config-back');
    if (backBtn) backBtn.addEventListener('click', showConfigMainView);
    document.querySelectorAll('.config-ai-row').forEach(row => {
      row.addEventListener('click', () => showConfigDetail(row.dataset.ai));
    });
    ['cfg-claude-backend', 'cfg-claude-key', 'cfg-claude-url', 'cfg-claude-model', 'cfg-codex-backend', 'cfg-codex-subscription-profile', 'cfg-codex-profile-default-label', 'cfg-codex-profile-second-label', 'cfg-codex-profile-second-home', 'cfg-codex-key', 'cfg-codex-url', 'cfg-codex-model', 'cfg-deepseek-key'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updateConfigSummaries);
      if (el) el.addEventListener('change', () => {
        if (id === 'cfg-claude-backend') updateClaudeBackendControls();
        updateConfigSummaries();
      });
    });
    const cardSize = configEl('cfg-card-font-size');
    const cardFamily = configEl('cfg-card-font-family');
    if (cardSize) cardSize.addEventListener('input', previewCardDisplay);
    if (cardFamily) cardFamily.addEventListener('change', previewCardDisplay);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeConfigModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        e.preventDefault(); closeConfigModal();
      }
    });
  
    document.getElementById('config-save').addEventListener('click', async () => {
      const msg = document.getElementById('config-save-msg');
      const newConfig = {
        proxy: document.getElementById('cfg-proxy').value.trim() || undefined,
        claudeBackend: document.getElementById('cfg-claude-backend').value,
        claudeApiKey: document.getElementById('cfg-claude-key').value.trim() || undefined,
        claudeApiBaseUrl: document.getElementById('cfg-claude-url').value.trim() || undefined,
        claudeApiModel: document.getElementById('cfg-claude-model').value.trim() || undefined,
        deepseekApiKey: document.getElementById('cfg-deepseek-key').value.trim() || undefined,
        codexBackend: document.getElementById('cfg-codex-backend').value,
        codexSubscriptionProfile: (document.getElementById('cfg-codex-subscription-profile') && document.getElementById('cfg-codex-subscription-profile').value) || 'default',
        codexSubscriptionProfiles: readCodexProfilesFromForm(),
        codexApiKey: document.getElementById('cfg-codex-key').value.trim() || undefined,
        codexApiBaseUrl: document.getElementById('cfg-codex-url').value.trim() || undefined,
        codexApiModel: document.getElementById('cfg-codex-model').value.trim() || undefined,
        ...readCardDisplayForm(),
      };
      if (newConfig.claudeBackend === 'api' && (!newConfig.claudeApiKey || !newConfig.claudeApiBaseUrl || !newConfig.claudeApiModel)) {
        msg.textContent = '请先完整填写同事中转的 Key、Base URL 和模型。';
        msg.className = 'config-save-msg error';
        msg.style.display = 'block';
        return;
      }
      try {
        const result = await ipcRenderer.invoke('save-hub-config', newConfig);
        if (result && result.success) {
          providerModes.claude = newConfig.claudeBackend === 'api' ? 'api' : 'subscription';
          providerModes.codex = newConfig.codexBackend === 'api' ? 'api' : 'subscription';
          renderAccountUsage();
          savedCardDisplay = setCardDisplayForm(newConfig);
          msg.textContent = '配置已保存。卡片字体已立即生效；新会话将按所选 AI 后端启动。';
          msg.className = 'config-save-msg success';
          msg.style.display = 'block';
          setTimeout(() => { msg.style.display = 'none'; }, 4000);
        } else {
          throw new Error('save failed');
        }
      } catch (err) {
        msg.textContent = '保存失败: ' + (err.message || '未知错误');
        msg.className = 'config-save-msg error';
        msg.style.display = 'block';
      }
    });
  }
  document.addEventListener('DOMContentLoaded', initConfigModal);
  // 如果 DOM 已经 ready 也立即尝试
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(initConfigModal, 0);
  }

  return {
    open: openConfigModal,
    close: closeConfigModal,
    init: initConfigModal,
    setCodexProfileForm,
    updateClaudeBackendControls,
    updateSummaries: updateConfigSummaries,
    showMainView: showConfigMainView,
    showDetail: showConfigDetail,
    readCodexProfilesFromForm,
    readCardDisplayForm,
    setCardDisplayForm,
  };
}

module.exports = { createConfigModalController };
