const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'deep-summary-config.json');

function getDefault() {
  return {
    fallback_chain: ['gemini-cli', 'deepseek-api'],
    gemini_cli: { timeout_ms: 90000, model_override: null },
    deepseek_api: {
      model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/chat/completions',
      timeout_ms: 60000,
      max_retries: 1,
      // secrets_file 留空 → readSecret 优雅失败 → fallback chain 自动走 gemini-cli。
      // 用户要启用 deepseek-api：env DEEPSEEK_API_KEY 或写到 ~/.claude-session-hub/config.json。
      secrets_file: '',
      secrets_key: 'DEEPSEEK_API_KEY',
    },
    ui: { modal_max_width_px: 900, show_raw_json_button: true },
  };
}

function loadConfig(filepath = DEFAULT_CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return getDefault();
  }
}

module.exports = { loadConfig, getDefault };
