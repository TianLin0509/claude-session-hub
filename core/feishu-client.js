'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_FEISHU_BASE = 'https://open.feishu.cn';
const DEFAULT_LARK_BASE = 'https://open.larksuite.com';

function resolveBaseUrl(domain) {
  if (!domain || domain === 'feishu') return DEFAULT_FEISHU_BASE;
  if (domain === 'lark') return DEFAULT_LARK_BASE;
  return String(domain).replace(/\/+$/, '');
}

function requestJson(baseUrl, path, { method = 'GET', headers = {}, body = null } = {}) {
  const url = new URL(path, baseUrl);
  const transport = url.protocol === 'http:' ? http : https;
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        if (raw) {
          try { json = JSON.parse(raw); } catch (err) {
            err.message = `Feishu response is not JSON: ${err.message}`;
            return reject(err);
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Feishu HTTP ${res.statusCode}`);
          err.response = json;
          return reject(err);
        }
        resolve(json || {});
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestMultipart(baseUrl, requestPath, { method = 'POST', headers = {}, fields = {}, file = null } = {}) {
  const url = new URL(requestPath, baseUrl);
  const transport = url.protocol === 'http:' ? http : https;
  const boundary = '----hub-feishu-' + crypto.randomBytes(12).toString('hex');
  const chunks = [];

  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartName(name)}"\r\n\r\n` +
      `${String(value)}\r\n`,
      'utf8'
    ));
  }

  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartName(file.fieldName || 'file')}"; filename="${escapeMultipartName(file.fileName)}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
      'utf8'
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  const payload = Buffer.concat(chunks);
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        if (raw) {
          try { json = JSON.parse(raw); } catch (err) {
            err.message = `Feishu response is not JSON: ${err.message}`;
            return reject(err);
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Feishu HTTP ${res.statusCode}`);
          err.response = json;
          return reject(err);
        }
        resolve(json || {});
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function escapeMultipartName(value) {
  return String(value || '').replace(/["\r\n]/g, '_');
}

function buildMarkdownCard(text) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown', content: String(text || '') },
      ],
    },
  };
}

function buildGatewayMessageCard(msg) {
  const title = gatewayMessageTitle(msg.type);
  const elements = [
    { tag: 'markdown', content: String(msg.text || '').trim() || 'No content.' },
  ];
  const hint = gatewayActionHint(msg.type);
  if (hint) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: hint });
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: gatewayHeaderTemplate(msg.type),
      title: { tag: 'plain_text', content: title },
    },
    body: { elements },
  };
}

class FeishuClient {
  constructor({ appId, appSecret, domain = 'feishu', baseUrl = null, now = () => Date.now() }) {
    if (!appId) throw new Error('Feishu appId is required');
    if (!appSecret) throw new Error('Feishu appSecret is required');
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl || resolveBaseUrl(domain);
    this.now = now;
    this._tenantToken = null;
    this._tenantTokenExpiresAt = 0;
  }

  async getTenantAccessToken() {
    if (this._tenantToken && this.now() < this._tenantTokenExpiresAt - 60_000) {
      return this._tenantToken;
    }
    const resp = await requestJson(this.baseUrl, '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
    });
    if (resp.code !== 0 || !resp.tenant_access_token) {
      throw new Error(`Feishu tenant token failed: ${resp.msg || resp.code || 'unknown error'}`);
    }
    this._tenantToken = resp.tenant_access_token;
    this._tenantTokenExpiresAt = this.now() + Math.max(0, Number(resp.expire || 0)) * 1000;
    return this._tenantToken;
  }

  async sendMarkdown({ chatId, text, replyToMessageId = null, replyInThread = true }) {
    const card = buildMarkdownCard(text);
    return this.sendCard({ chatId, card, replyToMessageId, replyInThread });
  }

  async sendCard({ chatId, card, replyToMessageId = null, replyInThread = true }) {
    const token = await this.getTenantAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    const content = JSON.stringify(card);
    if (replyToMessageId) {
      const resp = await requestJson(this.baseUrl, `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: 'POST',
        headers,
        body: {
          content,
          msg_type: 'interactive',
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return this._assertOk(resp, 'Feishu card reply failed');
    }
    if (!chatId) throw new Error('chatId is required when replyToMessageId is absent');
    const resp = await requestJson(this.baseUrl, '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers,
      body: {
        receive_id: chatId,
        content,
        msg_type: 'interactive',
      },
    });
    return this._assertOk(resp, 'Feishu card send failed');
  }

  async uploadFile({ filePath, fileName = null, fileType = 'stream' }) {
    const resolved = path.resolve(String(filePath || ''));
    const st = fs.statSync(resolved);
    if (!st.isFile()) throw new Error(`Feishu file upload target is not a file: ${resolved}`);
    if (st.size <= 0) throw new Error(`Feishu file upload target is empty: ${resolved}`);
    if (st.size > 30 * 1024 * 1024) throw new Error(`Feishu file upload target is larger than 30MB: ${resolved}`);

    const token = await this.getTenantAccessToken();
    const name = fileName || path.basename(resolved);
    const resp = await requestMultipart(this.baseUrl, '/open-apis/im/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      fields: {
        file_type: fileType || 'stream',
        file_name: name,
      },
      file: {
        fieldName: 'file',
        fileName: name,
        contentType: contentTypeForFile(name),
        buffer: fs.readFileSync(resolved),
      },
    });
    this._assertOk(resp, 'Feishu file upload failed');
    const fileKey = resp.data && resp.data.file_key;
    if (!fileKey) throw new Error('Feishu file upload failed: missing file_key');
    return { ...resp, fileKey };
  }

  async sendFile({ chatId, filePath, fileName = null, replyToMessageId = null, replyInThread = true }) {
    const upload = await this.uploadFile({ filePath, fileName, fileType: 'stream' });
    return this.sendFileMessage({
      chatId,
      fileKey: upload.fileKey,
      replyToMessageId,
      replyInThread,
    });
  }

  async sendFileMessage({ chatId, fileKey, replyToMessageId = null, replyInThread = true }) {
    if (!fileKey) throw new Error('fileKey is required');
    const token = await this.getTenantAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    const content = JSON.stringify({ file_key: fileKey });
    if (replyToMessageId) {
      const resp = await requestJson(this.baseUrl, `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: 'POST',
        headers,
        body: {
          content,
          msg_type: 'file',
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return this._assertOk(resp, 'Feishu file reply failed');
    }
    if (!chatId) throw new Error('chatId is required when replyToMessageId is absent');
    const resp = await requestJson(this.baseUrl, '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers,
      body: {
        receive_id: chatId,
        content,
        msg_type: 'file',
      },
    });
    return this._assertOk(resp, 'Feishu file send failed');
  }

  _assertOk(resp, message) {
    if (!resp || resp.code !== 0) {
      throw new Error(`${message}: ${resp && (resp.msg || resp.code) || 'unknown error'}`);
    }
    return resp;
  }
}

function contentTypeForFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.md' || ext === '.markdown') return 'text/markdown; charset=utf-8';
  if (ext === '.txt' || ext === '.log') return 'text/plain; charset=utf-8';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

function createFeishuMessageSender(client, { replyInThread = true, logger = console } = {}) {
  return async (msg) => {
    const card = buildGatewayMessageCard(msg);
    try {
      const result = await client.sendCard({
        chatId: msg.chatId,
        card,
        replyToMessageId: msg.replyToMessageId,
        replyInThread,
      });
      const reportFiles = Array.isArray(msg.reportFiles) ? msg.reportFiles : [];
      for (const reportFile of reportFiles) {
        try {
          await client.sendFile({
            chatId: msg.chatId,
            filePath: reportFile.path,
            fileName: reportFile.name,
            replyToMessageId: msg.replyToMessageId,
            replyInThread,
          });
        } catch (err) {
          if (logger && typeof logger.warn === 'function') {
            logger.warn('[feishu-codex] report attachment failed:', err.message);
          }
        }
      }
      return result;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[feishu-codex] send failed:', err.message);
      }
      throw err;
    }
  };
}

function gatewayMessageTitle(type) {
  const titleByType = {
    'session-started': 'Codex session 已创建',
    'input-sent': '输入已写入 Codex',
    status: 'Codex 状态',
    'recent-output': 'Codex 最近输出',
    'session-stopped': 'Codex session 已停止',
    'output-digest': 'Codex 输出摘要',
    approval: 'Codex 工具审批',
    help: 'Hub 提示',
    error: 'Hub 错误',
  };
  return titleByType[type] || '圆桌';
}

function gatewayHeaderTemplate(type) {
  if (type === 'error') return 'red';
  if (type === 'approval') return 'orange';
  if (type === 'session-stopped') return 'grey';
  if (type === 'output-digest' || type === 'recent-output') return 'blue';
  return 'wathet';
}

function gatewayActionHint(type) {
  if (type === 'output-digest' || type === 'recent-output' || type === 'status' || type === 'input-sent') {
    return '可回复：`状态` / `最近输出` / `停止`。继续输入普通文本会写入当前 Codex session。';
  }
  if (type === 'session-started') {
    return '后续在本话题继续回复即可追问同一个 Codex session。';
  }
  if (type === 'approval') {
    return 'MVP 阶段先用文本处理审批；下一步会升级为按钮。';
  }
  return '';
}

function formatGatewayMessage(msg) {
  const title = gatewayMessageTitle(msg.type);
  return `**${title}**\n\n${String(msg.text || '').trim()}`;
}

module.exports = {
  FeishuClient,
  createFeishuMessageSender,
  buildMarkdownCard,
  buildGatewayMessageCard,
  formatGatewayMessage,
  gatewayMessageTitle,
  gatewayActionHint,
  requestJson,
  requestMultipart,
  resolveBaseUrl,
  contentTypeForFile,
};
