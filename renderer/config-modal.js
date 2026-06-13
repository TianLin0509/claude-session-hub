'use strict';

function createConfigModalController({ document, ipcRenderer, providerModes, renderAccountUsage }) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!providerModes) throw new Error('providerModes is required');

  // Config/Settings Modal (API key + proxy)
  const CONFIG_AI_META = {
    claude: {
      title: 'Claude 设置',
      hint: '默认使用本机 Claude Code 订阅。可选填 VPS 代理走团队共享 Max。',
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
    deepseek: {
      title: 'DeepSeek 设置',
      hint: 'DeepSeek 当前通过 API 接入，新建 DeepSeek 会话生效。',
      status: 'API',
      statusClass: 'api',
    },
    glm: {
      title: 'GLM 设置',
      hint: 'GLM 当前通过 API 接入，新建 GLM 会话生效。',
      status: 'API',
      statusClass: 'api',
    },
    gpt: {
      title: 'GPT 设置',
      hint: 'GPT 当前通过 PackyAPI codex 分组的 Anthropic 兼容端点接入，新建 GPT 会话生效。',
      status: 'API',
      statusClass: 'api',
    },
    kimi: {
      title: 'Kimi 设置',
      hint: 'Kimi 当前通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入，新建 Kimi 会话生效。',
      status: 'API',
      statusClass: 'api',
    },
    qwen: {
      title: 'Qwen 设置',
      hint: 'Qwen 当前通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入（与 Kimi 共享 bailian key），新建 Qwen 会话生效。',
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
  
  function configEl(id) {
    return document.getElementById(id);
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

  function fmtTokens(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }

  async function refreshMeridianUsage() {
    const el = document.getElementById('cfg-meridian-usage');
    if (!el) return;
    const url = (document.getElementById('cfg-meridian-url') || {}).value;
    const token = (document.getElementById('cfg-meridian-token') || {}).value;
    if (!url || !token) {
      el.innerHTML = '<span class="config-label-hint">未配置（填好 URL + Token 后保存即可拉取）</span>';
      return;
    }
    el.innerHTML = '<span class="config-label-hint">加载中…</span>';
    try {
      const r = await ipcRenderer.invoke('get-meridian-usage', { url: url.trim(), token: token.trim() });
      if (!r || !r.ok) {
        el.innerHTML = `<span class="config-label-hint" style="color:#f85149">拉取失败：${(r && r.errorMessage) || '未知'}</span>`;
        return;
      }
      const inPct = Math.min(100, Math.round((r.daily.input / r.limits.input) * 100));
      const outPct = Math.min(100, Math.round((r.daily.output / r.limits.output) * 100));
      el.innerHTML = `
        <div style="font-size: 12px; line-height: 1.6;">
          <div>请求数 <strong>${r.daily.requests}</strong> · cache hit <strong>${fmtTokens(r.daily.cacheRead)}</strong></div>
          <div>Input <strong>${fmtTokens(r.daily.input)}</strong> / ${fmtTokens(r.limits.input)}
            <div style="background:#222; height:6px; border-radius:3px; margin-top:3px;">
              <div style="background:${inPct > 80 ? '#f85149' : '#3fb950'}; width:${inPct}%; height:100%; border-radius:3px;"></div>
            </div>
          </div>
          <div style="margin-top:6px;">Output <strong>${fmtTokens(r.daily.output)}</strong> / ${fmtTokens(r.limits.output)}
            <div style="background:#222; height:6px; border-radius:3px; margin-top:3px;">
              <div style="background:${outPct > 80 ? '#f85149' : '#3fb950'}; width:${outPct}%; height:100%; border-radius:3px;"></div>
            </div>
          </div>
        </div>
      `;
    } catch (e) {
      el.innerHTML = `<span class="config-label-hint" style="color:#f85149">出错：${e.message || e}</span>`;
    }
  }
  
  function updateConfigSummaries() {
    const codexBackend = configEl('cfg-codex-backend') ? configEl('cfg-codex-backend').value : 'subscription';
    const codexModel = configEl('cfg-codex-model') ? (configEl('cfg-codex-model').value.trim() || 'gpt-5.5') : 'gpt-5.5';
    const codexKey = configEl('cfg-codex-key') ? configEl('cfg-codex-key').value.trim() : '';
    const profiles = readCodexProfilesFromForm();
    const profileSelect = configEl('cfg-codex-subscription-profile');
    const selectedProfileId = profileSelect ? profileSelect.value : codexSubscriptionProfile;
    if (profileSelect) renderCodexProfileSelect(selectedProfileId);
    const selectedProfile = profiles.find(p => p.id === selectedProfileId) || profiles[0];
    codexSubscriptionProfile = selectedProfile ? selectedProfile.id : 'default';
    updateCodexProfileMenuLabels();
    const deepseekKey = configEl('cfg-deepseek-key') ? configEl('cfg-deepseek-key').value.trim() : '';
    const glmKey = configEl('cfg-glm-key') ? configEl('cfg-glm-key').value.trim() : '';
    const glmModel = configEl('cfg-glm-model') ? (configEl('cfg-glm-model').value.trim() || 'glm-5.1') : 'glm-5.1';
    const gptKey = configEl('cfg-gpt-key') ? configEl('cfg-gpt-key').value.trim() : '';
    const gptModel = configEl('cfg-gpt-model') ? (configEl('cfg-gpt-model').value.trim() || 'gpt-5.4-high') : 'gpt-5.4-high';
    const kimiKey = configEl('cfg-kimi-key') ? configEl('cfg-kimi-key').value.trim() : '';
    const kimiModel = configEl('cfg-kimi-model') ? (configEl('cfg-kimi-model').value.trim() || 'kimi-k2.5') : 'kimi-k2.5';
    const qwenKey = configEl('cfg-qwen-key') ? configEl('cfg-qwen-key').value.trim() : '';
    const qwenModel = configEl('cfg-qwen-model') ? (configEl('cfg-qwen-model').value.trim() || 'qwen3.6-plus') : 'qwen3.6-plus';
  
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
  
    const glmSummary = configEl('cfg-summary-glm');
    if (glmSummary) glmSummary.textContent = glmKey ? `API · ${glmModel}` : 'API · 未配置 Key';
    setConfigStatus(configEl('cfg-status-glm'), glmKey ? 'API' : '缺 Key', glmKey ? 'api' : 'missing');
  
    const gptSummary = configEl('cfg-summary-gpt');
    if (gptSummary) gptSummary.textContent = gptKey ? `API · ${gptModel} · Packy` : 'API · 未配置 Key';
    setConfigStatus(configEl('cfg-status-gpt'), gptKey ? 'API' : '缺 Key', gptKey ? 'api' : 'missing');
  
    const kimiSummary = configEl('cfg-summary-kimi');
    if (kimiSummary) kimiSummary.textContent = kimiKey ? `API · ${kimiModel} · Packy` : 'API · 未配置 Key';
    setConfigStatus(configEl('cfg-status-kimi'), kimiKey ? 'API' : '缺 Key', kimiKey ? 'api' : 'missing');
  
    const qwenSummary = configEl('cfg-summary-qwen');
    if (qwenSummary) qwenSummary.textContent = qwenKey ? `API · ${qwenModel} · Packy` : 'API · 未配置 Key';
    setConfigStatus(configEl('cfg-status-qwen'), qwenKey ? 'API' : '缺 Key', qwenKey ? 'api' : 'missing');

    const meridianUrl = configEl('cfg-meridian-url') ? configEl('cfg-meridian-url').value.trim() : '';
    const meridianToken = configEl('cfg-meridian-token') ? configEl('cfg-meridian-token').value.trim() : '';
    const claudeSummary = configEl('cfg-summary-claude');
    if (claudeSummary) {
      claudeSummary.textContent = (meridianUrl && meridianToken)
        ? `VPS 代理 · ${meridianUrl.replace(/^https?:\/\//, '')}`
        : '订阅模式 · claude-opus-4-8[1m]';
    }
    if (activeConfigAi === 'claude') {
      setConfigStatus(
        configEl('cfg-detail-status'),
        (meridianUrl && meridianToken) ? 'VPS 代理' : '订阅',
        (meridianUrl && meridianToken) ? 'api' : 'subscription'
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
    } else if (activeConfigAi === 'glm') {
      setConfigStatus(configEl('cfg-detail-status'), glmKey ? 'API' : '缺 Key', glmKey ? 'api' : 'missing');
    } else if (activeConfigAi === 'gpt') {
      setConfigStatus(configEl('cfg-detail-status'), gptKey ? 'API' : '缺 Key', gptKey ? 'api' : 'missing');
    } else if (activeConfigAi === 'kimi') {
      setConfigStatus(configEl('cfg-detail-status'), kimiKey ? 'API' : '缺 Key', kimiKey ? 'api' : 'missing');
    } else if (activeConfigAi === 'qwen') {
      setConfigStatus(configEl('cfg-detail-status'), qwenKey ? 'API' : '缺 Key', qwenKey ? 'api' : 'missing');
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
      providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
      setCodexProfileForm(cfg.codexSubscriptionProfiles, cfg.codexSubscriptionProfile);
      document.getElementById('cfg-proxy').value = cfg.proxy || '';
      document.getElementById('cfg-deepseek-key').value = cfg.deepseekApiKey || '';
      document.getElementById('cfg-codex-backend').value = cfg.codexBackend || 'subscription';
      document.getElementById('cfg-codex-key').value = cfg.codexApiKey || '';
      document.getElementById('cfg-codex-url').value = cfg.codexApiBaseUrl || '';
      document.getElementById('cfg-codex-model').value = cfg.codexApiModel || '';
      document.getElementById('cfg-glm-key').value = cfg.glmApiKey || '';
      document.getElementById('cfg-glm-url').value = cfg.glmBaseUrl || '';
      document.getElementById('cfg-glm-model').value = cfg.glmModel || '';
      document.getElementById('cfg-gpt-key').value = cfg.gptApiKey || '';
      document.getElementById('cfg-gpt-url').value = cfg.gptBaseUrl || '';
      document.getElementById('cfg-gpt-model').value = cfg.gptModel || '';
      document.getElementById('cfg-kimi-key').value = cfg.kimiApiKey || '';
      document.getElementById('cfg-kimi-url').value = cfg.kimiBaseUrl || '';
      document.getElementById('cfg-kimi-model').value = cfg.kimiModel || '';
      document.getElementById('cfg-qwen-key').value = cfg.qwenApiKey || '';
      document.getElementById('cfg-qwen-url').value = cfg.qwenBaseUrl || '';
      document.getElementById('cfg-qwen-model').value = cfg.qwenModel || '';
      if (document.getElementById('cfg-meridian-url')) {
        document.getElementById('cfg-meridian-url').value = cfg.meridianUrl || '';
        document.getElementById('cfg-meridian-token').value = cfg.meridianToken || '';
        refreshMeridianUsage();
      }
      const packyEl = document.getElementById('cfg-packy-cookie');
      if (packyEl) packyEl.value = cfg.packySessionCookie || '';
      const expiresEl = document.getElementById('cfg-packy-expires');
      if (expiresEl) expiresEl.textContent = cfg.packySessionCookie ? '已配置' : '未配置';
      updateConfigSummaries();
    } catch {
      // 加载失败也显示空白面板
    }
    showConfigMainView();
    modal.classList.remove('hidden');
  }
  
  function closeConfigModal() {
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
    ['cfg-codex-backend', 'cfg-codex-subscription-profile', 'cfg-codex-profile-default-label', 'cfg-codex-profile-second-label', 'cfg-codex-profile-second-home', 'cfg-codex-key', 'cfg-codex-url', 'cfg-codex-model', 'cfg-deepseek-key', 'cfg-glm-key', 'cfg-glm-url', 'cfg-glm-model', 'cfg-gpt-key', 'cfg-gpt-url', 'cfg-gpt-model', 'cfg-kimi-key', 'cfg-kimi-url', 'cfg-kimi-model', 'cfg-qwen-key', 'cfg-qwen-url', 'cfg-qwen-model', 'cfg-meridian-url', 'cfg-meridian-token'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updateConfigSummaries);
      if (el) el.addEventListener('change', updateConfigSummaries);
    });

    const testBtn = document.getElementById('cfg-meridian-test-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const url = document.getElementById('cfg-meridian-url').value.trim();
        const token = document.getElementById('cfg-meridian-token').value.trim();
        const resultEl = document.getElementById('cfg-meridian-test-result');
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
    }
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
        deepseekApiKey: document.getElementById('cfg-deepseek-key').value.trim() || undefined,
        codexBackend: document.getElementById('cfg-codex-backend').value,
        codexSubscriptionProfile: (document.getElementById('cfg-codex-subscription-profile') && document.getElementById('cfg-codex-subscription-profile').value) || 'default',
        codexSubscriptionProfiles: readCodexProfilesFromForm(),
        codexApiKey: document.getElementById('cfg-codex-key').value.trim() || undefined,
        codexApiBaseUrl: document.getElementById('cfg-codex-url').value.trim() || undefined,
        codexApiModel: document.getElementById('cfg-codex-model').value.trim() || undefined,
        glmApiKey: document.getElementById('cfg-glm-key').value.trim() || undefined,
        glmBaseUrl: document.getElementById('cfg-glm-url').value.trim() || undefined,
        glmModel: document.getElementById('cfg-glm-model').value.trim() || undefined,
        gptApiKey: document.getElementById('cfg-gpt-key').value.trim() || undefined,
        gptBaseUrl: document.getElementById('cfg-gpt-url').value.trim() || undefined,
        gptModel: document.getElementById('cfg-gpt-model').value.trim() || undefined,
        kimiApiKey: document.getElementById('cfg-kimi-key').value.trim() || undefined,
        kimiBaseUrl: document.getElementById('cfg-kimi-url').value.trim() || undefined,
        kimiModel: document.getElementById('cfg-kimi-model').value.trim() || undefined,
        qwenApiKey: document.getElementById('cfg-qwen-key').value.trim() || undefined,
        qwenBaseUrl: document.getElementById('cfg-qwen-url').value.trim() || undefined,
        qwenModel: document.getElementById('cfg-qwen-model').value.trim() || undefined,
        meridianUrl: document.getElementById('cfg-meridian-url') ? (document.getElementById('cfg-meridian-url').value.trim() || undefined) : undefined,
        meridianToken: document.getElementById('cfg-meridian-token') ? (document.getElementById('cfg-meridian-token').value.trim() || undefined) : undefined,
        packySessionCookie: (document.getElementById('cfg-packy-cookie') && document.getElementById('cfg-packy-cookie').value.trim()) || undefined,
      };
      try {
        const result = await ipcRenderer.invoke('save-hub-config', newConfig);
        if (result && result.success) {
          providerModes.codex = newConfig.codexBackend === 'api' ? 'api' : 'subscription';
          renderAccountUsage();
          msg.textContent = '配置已保存。新创建的 Codex / GLM / DeepSeek / GPT / Kimi / Qwen 会话将立即生效。';
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
    updateSummaries: updateConfigSummaries,
    showMainView: showConfigMainView,
    showDetail: showConfigDetail,
    readCodexProfilesFromForm,
  };
}

module.exports = { createConfigModalController };
