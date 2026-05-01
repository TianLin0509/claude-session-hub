// core/summary-engine.js
const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { stripAnsi } = require('./ansi-utils');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'summary-templates.json');

const START_MARKER = 'SM-START';
const END_MARKER = 'SM-END';
const MARKER_INSTRUCTION = '\n\n[用SM-START和SM-END包裹回答内容]';

class SummaryEngine {
  constructor(config = {}) {
    this._templatesPath = config.templatesPath || DEFAULT_TEMPLATES_PATH;
    this._templates = null;
    this._markerCache = new Map();
  }

  _loadTemplates() {
    if (this._templates) return this._templates;
    try {
      const raw = fs.readFileSync(this._templatesPath, 'utf-8');
      this._templates = JSON.parse(raw);
    } catch (e) {
      console.error('[summary-engine] Failed to load templates:', e.message);
      return { scenes: {}, deep: { system: '', promptTemplate: '{{content}}' } };
    }
    return this._templates;
  }

  reloadTemplates() {
    this._templates = null;
    return this._loadTemplates();
  }

  getScenes() {
    const t = this._loadTemplates();
    const result = [];
    for (const [key, val] of Object.entries(t.scenes || {})) {
      result.push({ key, label: val.label || key });
    }
    return result;
  }

  getMarkerInstruction() {
    return MARKER_INSTRUCTION;
  }

  // Find SM-START at line boundary (not inside instruction echo like "[用SM-START和SM-END包裹...]")
  _findStartMarker(cleaned) {
    let searchFrom = cleaned.length;
    while (searchFrom > 0) {
      const idx = cleaned.lastIndexOf(START_MARKER, searchFrom - 1);
      if (idx < 0) return -1;
      if (idx === 0 || cleaned[idx - 1] === '\n' || cleaned[idx - 1] === '\r') return idx;
      searchFrom = idx;
    }
    return -1;
  }

  extractMarker(rawBuffer, sessionId) {
    if (!rawBuffer) return this._markerCache.get(sessionId) || '';
    const cleaned = stripAnsi(rawBuffer);
    const startIdx = this._findStartMarker(cleaned);
    if (startIdx < 0) {
      return this._markerCache.get(sessionId) || '';
    }
    const contentStart = startIdx + START_MARKER.length;
    const endIdx = cleaned.indexOf(END_MARKER, contentStart);
    if (endIdx < 0) {
      return cleaned.slice(contentStart).trim();
    }
    const content = cleaned.slice(contentStart, endIdx).trim();
    if (sessionId && content) this._markerCache.set(sessionId, content);
    return content;
  }

  markerStatus(rawBuffer, sessionId) {
    if (!rawBuffer) return this._markerCache.has(sessionId) ? 'done' : 'none';
    const cleaned = stripAnsi(rawBuffer);
    const startIdx = this._findStartMarker(cleaned);
    if (startIdx >= 0) {
      const contentStart = startIdx + START_MARKER.length;
      const endIdx = cleaned.indexOf(END_MARKER, contentStart);
      if (endIdx >= 0) {
        const content = cleaned.slice(contentStart, endIdx).trim();
        if (sessionId && content) this._markerCache.set(sessionId, content);
        return 'done';
      }
      return 'streaming';
    }
    if (this._markerCache.has(sessionId)) return 'done';
    return 'none';
  }

  quickSummary(rawBuffer, sessionId) {
    return this.extractMarker(rawBuffer, sessionId);
  }

  async compressContext(content, maxChars = 1000) {
    if (!content || content.length <= maxChars) return content;
    const system = '你是一个协作上下文压缩助手。将内容压缩到指定字符数以内，保留关键结论、数据点和具体建议，压缩论证过程和重复内容。';
    const prompt = `将以下 AI 回答压缩到 ${maxChars} 字符以内。\n要求：保留关键结论、数据点和具体建议，压缩论证过程和重复内容。\n\n原文：\n${content}`;
    try {
      const compressed = await this._callGeminiPipe(system, prompt);
      return compressed || content.slice(0, maxChars);
    } catch (err) {
      console.error('[summary-engine] compressContext failed:', err.message);
      return content.slice(0, maxChars);
    }
  }

  async detectDivergence(agentOutputs) {
    if (!agentOutputs || Object.keys(agentOutputs).length < 2) {
      return { consensus: [], divergence: [] };
    }
    const system = '你是一个多AI协作分析助手。分析多个AI的回答，识别共识和分歧。只输出JSON，不要其他内容。';
    let prompt = '分析以下多个 AI 对同一问题的回答，识别共识和分歧。\n\n';
    for (const [name, content] of Object.entries(agentOutputs)) {
      prompt += `【${name}】\n${content}\n\n`;
    }
    prompt += '请以 JSON 格式输出：\n{\n  "consensus": ["共识点1", "共识点2"],\n  "divergence": [\n    {\n      "topic": "分歧主题",\n      "positions": {"Agent1": "观点", "Agent2": "观点"},\n      "suggestedQuestion": "建议追问的问题"\n    }\n  ]\n}';

    try {
      const raw = await this._callGeminiPipe(system, prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { consensus: [], divergence: [] };
    } catch (err) {
      console.error('[summary-engine] detectDivergence failed:', err.message);
      return { consensus: [], divergence: [] };
    }
  }

  async deepSummary(rawBuffer, options = {}) {
    const { agentName = 'AI', question = '', scene = 'free_discussion' } = options;

    const content = this.extractMarker(rawBuffer);
    if (!content) {
      console.warn('[summary-engine] deepSummary: no marker content for', agentName);
      return '';
    }

    const t = this._loadTemplates();
    const sceneConfig = (t.scenes || {})[scene] || (t.scenes || {}).free_discussion || {};
    const instruction = sceneConfig.instruction || '';
    const system = (t.deep || {}).system || '';
    const template = (t.deep || {}).promptTemplate || '{{content}}';

    const prompt = template
      .replace('{{agent_name}}', agentName)
      .replace('{{question}}', question)
      .replace('{{content}}', content)
      .replace('{{instruction}}', instruction);

    try {
      const summary = await this._callGeminiPipe(system, prompt);
      return summary;
    } catch (err) {
      console.error('[summary-engine] Gemini pipe failed:', err.message);
      return '';
    }
  }

  buildInjection(otherSummaries, userFollowUp) {
    if (!otherSummaries || otherSummaries.length === 0) return userFollowUp || '';
    let payload = '[会议室协作同步]\n';
    for (const s of otherSummaries) {
      payload += `【${s.label}】${s.summary}\n`;
    }
    payload += '---\n';
    if (userFollowUp) payload += userFollowUp;
    return payload;
  }

  _callGeminiPipe(system, prompt) {
    return new Promise((resolve, reject) => {
      const args = ['-p'];
      if (system) {
        args.push('--system-prompt', system);
      }

      const child = execFile('gemini', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gemini -p failed: ${err.message} stderr: ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      });

      child.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') reject(e);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // pilot-mode（2026-05-01）：让任意 5 家 AI（claude / deepseek / glm / codex / gemini）
  //   都能 headless 生成摘要。pilot 模式关闭时主驾自己生成"不限字数摘要 + 段落目录"。
  //   失败时调用方走 F5-B 按轮切兜底（plan §Task 4 已规划）。
  async summarizeWithKind(kind, system, prompt, options = {}) {
    const timeout = options.timeout || 60000;
    const model = options.model || null;
    switch (kind) {
      case 'claude':
      case 'claude-resume':
      case 'deepseek':
      case 'glm':
        return this._callClaudeHeadless(kind, system, prompt, timeout, model);
      case 'codex':
        return this._callCodexHeadless(system, prompt, timeout, model);
      case 'gemini':
        return this._callGeminiPipe(system, prompt);
      default:
        throw new Error(`summarizeWithKind: Unsupported kind: ${kind}`);
    }
  }

  _buildEnvForKind(kind) {
    const env = { ...process.env };
    if (kind === 'claude' || kind === 'claude-resume') return env;
    // 通过 hub-config 取 DeepSeek / GLM 的 API key + base url（与 session-manager 同源），
    //   避免在多处复制 secrets.toml 解析逻辑。
    let cv = {};
    try {
      const { getConfig } = require('./hub-config.js');
      cv = getConfig() || {};
    } catch (e) {
      console.warn('[summary-engine] hub-config load failed:', e.message);
    }
    if (kind === 'deepseek') {
      env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
      if (cv.deepseekApiKey) env.ANTHROPIC_AUTH_TOKEN = cv.deepseekApiKey;
      env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-deepseek');
    } else if (kind === 'glm') {
      if (cv.glmBaseUrl) env.ANTHROPIC_BASE_URL = cv.glmBaseUrl;
      if (cv.glmApiKey) env.ANTHROPIC_AUTH_TOKEN = cv.glmApiKey;
      env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-glm');
    }
    return env;
  }

  _writeTmpSysFile(system) {
    const f = path.join(os.tmpdir(), `summary_sys_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(f, system || '', 'utf8');
    return f;
  }

  async _callClaudeHeadless(kind, system, prompt, timeout, model) {
    const env = this._buildEnvForKind(kind);
    const sysFile = this._writeTmpSysFile(system);
    const args = ['-p'];
    if (model) args.push('--model', model);
    args.push('--append-system-prompt-file', sysFile);
    // DeepSeek/GLM 跑在 claude CLI 上，需 bypass permissions 才能 headless 不弹窗
    if (kind === 'deepseek' || kind === 'glm') args.push('--permission-mode', 'bypassPermissions');
    try {
      return await this._spawnAndCollect('claude', args, { env, stdin: prompt }, timeout);
    } finally {
      try { fs.unlinkSync(sysFile); } catch {}
    }
  }

  async _callCodexHeadless(system, prompt, timeout, model) {
    const sysFile = this._writeTmpSysFile(system);
    const args = ['exec', '-', '--skip-git-repo-check', '--json', '--full-auto',
                  '-c', `model_instructions_file=${sysFile}`];
    if (model) args.push('--model', model);
    try {
      const out = await this._spawnAndCollect('codex', args, { stdin: prompt }, timeout);
      // Codex JSONL 输出：抽出 item.completed.item.text（或老格式 message.text）
      return this._extractCodexFinalText(out) || out.trim();
    } finally {
      try { fs.unlinkSync(sysFile); } catch {}
    }
  }

  _extractCodexFinalText(jsonlOut) {
    if (!jsonlOut) return '';
    const lines = jsonlOut.split('\n').filter(l => l.trim());
    let lastText = '';
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      // 新协议：{type:'item.completed', item:{type:'message', text:'...'}}
      if (obj?.type === 'item.completed' && obj.item?.text) lastText = obj.item.text;
      // 老协议：{type:'message', text:'...'}
      else if (obj?.type === 'message' && obj.text) lastText = obj.text;
    }
    return lastText;
  }

  _spawnAndCollect(cmd, args, opts, timeout) {
    return new Promise((resolve, reject) => {
      const env = opts.env || process.env;
      const child = spawn(cmd, args, { env, shell: false });
      let out = '', err = '';
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      if (opts.stdin) {
        child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); });
        child.stdin.end(opts.stdin);
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error(`${cmd} headless timeout after ${timeout}ms; stderr: ${err.slice(0, 200)}`));
      }, timeout);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim().length > 0) resolve(out.trim());
        else reject(new Error(`${cmd} exit code=${code}: ${err.slice(0, 300)}`));
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

module.exports = { SummaryEngine, START_MARKER, END_MARKER, MARKER_INSTRUCTION };
