'use strict';
// 特战队团队入口（2026-10-18 田哥拍板）：同事共用田哥的阿里云中转，每人一把钥匙、各自限额、可单独收回。
//   邀请码：AIHUB-TZ-1.<base64url(JSON{u: 通道地址, l: 称呼})>，通道地址形如 https://<域名>/hub-link/<钥匙>/api。
//   同事在家里 Hub 粘贴邀请码后，配对码就带上这个地址；公司 Hub 照旧粘贴配对码，一行不用改。
//   组长（本机有管理口令的那台）在同一页新建 / 收回成员：服务器只存钥匙的哈希，钥匙明文只在新建那一刻出现在邀请码里。
const { checkBaseUrl } = require('./crypto');
const { BridgeClient } = require('./client');

const INVITE_PREFIX = 'AIHUB-TZ-1.';
const TEAM_PATH = /\/hub-link\/[A-Za-z0-9_-]{32,64}\/api$/;

function makeInvite(url, label) {
  const u = checkBaseUrl(url);
  if (!TEAM_PATH.test(new URL(u).pathname)) throw new Error('不是团队入口的通道地址');
  return INVITE_PREFIX + Buffer.from(JSON.stringify({ u, l: String(label || '').slice(0, 24) }), 'utf8').toString('base64url');
}

function parseInvite(text) {
  const s = String(text || '');
  if (/AIHUB-LINK-1\./.test(s)) throw new Error('这是配对码，要粘贴到公司 Hub；家里这里粘贴的是组长发的邀请码（以 AIHUB-TZ-1. 开头）');
  const match = s.match(/AIHUB-TZ-1\.([A-Za-z0-9_-]{20,})/);
  if (!match) throw new Error('没找到邀请码：应以 AIHUB-TZ-1. 开头，请向组长要');
  let value;
  try { value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { throw new Error('邀请码不完整，请整段复制'); }
  const url = checkBaseUrl(value && value.u);
  if (!TEAM_PATH.test(new URL(url).pathname)) throw new Error('邀请码里的通道地址不对，请向组长要新的');
  return { url, label: String(value.l || '').slice(0, 24) };
}

// 组长的成员管理：deps.teamAdmin() 返回 { apiUrl, origin, token }（取自本机公司收件箱配置），没有就不是组长。
class TeamAdmin {
  constructor({ teamAdmin, fetchImpl }) { this.source = teamAdmin; this.fetchImpl = fetchImpl; }
  config() { try { const c = this.source?.(); return c && c.apiUrl && c.token ? c : null; } catch { return null; } }
  available() { return !!this.config(); }
  async request(pathname, init = {}) {
    const c = this.config();
    if (!c) throw new Error('本机没有特战队管理口令');
    const client = new BridgeClient({ baseUrl: c.apiUrl, fetchImpl: this.fetchImpl, timeoutMs: 20000 });
    return client.request(pathname, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + c.token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  }
  async members() { return (await this.request('/members', { method: 'GET' })).members || []; }
  async create(label) {
    const c = this.config();
    const r = await this.request('/members', { method: 'POST', body: JSON.stringify({ label: String(label || '').trim() }) });
    const url = `${String(c.origin).replace(/\/+$/, '')}/hub-link/${r.key}/api`;
    return { member: r.member, invite: makeInvite(url, r.member && r.member.label) };
  }
  async revoke(id) {
    if (!/^m[a-f0-9]{8}$/.test(String(id || ''))) throw new Error('成员编号无效');
    return (await this.request(`/members/${id}/revoke`, { method: 'POST', body: '{}' })).member;
  }
}

module.exports = { INVITE_PREFIX, makeInvite, parseInvite, TeamAdmin };
