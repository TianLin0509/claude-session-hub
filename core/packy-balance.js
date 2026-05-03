/**
 * PackyAPI 账户数据拉取(余额 + 消耗)
 *
 * 数据源:
 * - 余额 / 累计消耗:cookie + new-api-user header → /api/user/self
 *   (这是 NewAPI 派生的账户接口,sk- key 拿不到,必须用 packyapi 网站登录态 cookie)
 * - 今日消耗:sk- key + /v1/dashboard/billing/usage(传 start_date=今天)
 *
 * 单位:NewAPI quota,500000 quota = 1 USD(实测 used_quota / 500000 与 sk- key 实测的
 * 月消耗对得上)。
 *
 * Cookie 安全:整段 session cookie 等同于浏览器登录态,写到 config.json(0o600 权限)。
 *             cookie 过期(timestamp 字段)后接口返回 401,Hub 显示"重新登录"提示。
 */

const https = require('https');
const { URL } = require('url');

const QUOTA_PER_USD = 500000;

/**
 * 从 cookie value(base64 编码的 gorilla/sessions payload)解出 user id 和过期时间。
 *
 * NewAPI cookie 结构(URL-decoded):<timestamp>|<base64-gob-data>|<hmac>
 * 整段对外是再次 base64 包裹。我们只读 timestamp 和 username (oidc_<id>) 字段。
 *
 * @returns {{userId: number, expiresAt: number}|null}
 */
function parseSessionCookie(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  try {
    const trimmed = cookieValue.trim();
    const b64decode = (s) => {
      const padded = s + '='.repeat((4 - s.length % 4) % 4);
      return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    };
    // 第一层:整段 cookie value 是 URL-safe base64 → "<timestamp>|<inner-b64>|<hmac>"
    const layer1 = b64decode(trimmed).toString('utf8');
    const parts = layer1.split('|');
    if (parts.length < 2) return null;
    const timestamp = parseInt(parts[0], 10);
    if (!isFinite(timestamp)) return null;
    const expiresAt = timestamp * 1000;

    // 第二层:gob payload 也是 base64,解出来才能看到 username 字段
    const layer2 = b64decode(parts[1]).toString('binary');
    // username 是 OIDC "oidc_<id>",直接正则。
    // (NewAPI gob 序列化里 username 字段值是字面字符串,不需要完整 gob 解析)
    const usernameMatch = layer2.match(/oidc_(\d+)/);
    if (!usernameMatch) return null;
    const userId = parseInt(usernameMatch[1], 10);
    if (!isFinite(userId)) return null;

    return { userId, expiresAt };
  } catch {
    return null;
  }
}

/**
 * 通用 HTTPS GET 请求(走代理,JSON 返回)
 */
function httpsGetJson(urlStr, headers, proxy) {
  return new Promise((resolve, reject) => {
    let opts;
    if (proxy) {
      const proxyUrl = new URL(proxy);
      const target = new URL(urlStr);
      opts = {
        host: proxyUrl.hostname,
        port: proxyUrl.port,
        path: urlStr,
        method: 'GET',
        headers: {
          ...headers,
          Host: target.hostname,
        },
      };
    } else {
      const target = new URL(urlStr);
      opts = {
        host: target.hostname,
        path: target.pathname + target.search,
        port: 443,
        method: 'GET',
        headers,
      };
    }

    const lib = proxy ? require('http') : https;
    const req = lib.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, json: null, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('packy-balance: request timeout'));
    });
    req.end();
  });
}

/**
 * 拉取账户余额 + 累计消耗(用 cookie 路径)
 * @returns {{balanceUsd, usedUsd, displayName}|null}
 */
async function fetchAccountStatus({ cookie, userId, proxy }) {
  if (!cookie || !userId) return null;
  const url = 'https://www.packyapi.com/api/user/self';
  try {
    const res = await httpsGetJson(url, {
      Cookie: `session=${cookie}`,
      'new-api-user': String(userId),
    }, proxy);
    if (res.status !== 200 || !res.json || !res.json.success) {
      return { error: res.json && res.json.message ? res.json.message : `status ${res.status}` };
    }
    const d = res.json.data;
    return {
      balanceUsd: d.quota / QUOTA_PER_USD,
      usedUsd: d.used_quota / QUOTA_PER_USD,
      displayName: d.display_name || d.username || '',
      requestCount: d.request_count || 0,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 拉取单个 token 的某时段消耗(用 sk- key 路径)
 * @returns USD 数值(可能 0)
 */
async function fetchTokenUsage({ apiKey, startDate, endDate, proxy }) {
  if (!apiKey) return 0;
  const qs = `start_date=${startDate}&end_date=${endDate}`;
  const url = `https://www.packyapi.com/v1/dashboard/billing/usage?${qs}`;
  try {
    const res = await httpsGetJson(url, {
      Authorization: `Bearer ${apiKey}`,
    }, proxy);
    if (res.status !== 200 || !res.json) return 0;
    // total_usage 单位:cent(0.01 USD)
    const cents = parseFloat(res.json.total_usage) || 0;
    return cents / 100;
  } catch {
    return 0;
  }
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoStr(n) {
  const d = new Date(Date.now() - n * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 主入口:聚合 packyapi 账户面板数据。
 *
 * @param {Object} opts
 * @param {string} opts.cookie  packy 网站 session cookie(可能为空)
 * @param {string[]} opts.tokenKeys  sk- key 列表(codex/bailian),去重
 * @param {string} [opts.proxy]
 * @returns {Promise<{balanceUsd?, usedUsd?, todayUsd?, expiresAt?, error?}>}
 */
async function fetchAggregated({ cookie, tokenKeys, proxy }) {
  const result = {
    balanceUsd: null,
    usedUsd: null,
    todayUsd: 0,
    expiresAt: null,
    error: null,
  };

  // 路径 1:cookie → 余额 + 累计消耗
  if (cookie) {
    const parsed = parseSessionCookie(cookie);
    if (parsed) {
      result.expiresAt = parsed.expiresAt;
      const status = await fetchAccountStatus({ cookie, userId: parsed.userId, proxy });
      if (status && !status.error) {
        result.balanceUsd = status.balanceUsd;
        result.usedUsd = status.usedUsd;
        result.displayName = status.displayName;
      } else if (status && status.error) {
        result.error = `账户接口: ${status.error}`;
      }
    } else {
      result.error = 'cookie 解析失败,请确认是从 packyapi.com cookies 复制完整值';
    }
  }

  // 路径 2:sk- key → 今日消耗(独立路径,即使 cookie 失败也有值)
  if (tokenKeys && tokenKeys.length) {
    const today = todayStr();
    const uniqueKeys = [...new Set(tokenKeys.filter(Boolean))];
    const todayResults = await Promise.all(
      uniqueKeys.map((k) => fetchTokenUsage({ apiKey: k, startDate: today, endDate: today, proxy }))
    );
    result.todayUsd = todayResults.reduce((a, b) => a + b, 0);

    // 如果 cookie 没拿到累计,用 30 天近似(降级)
    if (result.usedUsd === null) {
      const start = daysAgoStr(30);
      const monthResults = await Promise.all(
        uniqueKeys.map((k) => fetchTokenUsage({ apiKey: k, startDate: start, endDate: today, proxy }))
      );
      result.usedUsd = monthResults.reduce((a, b) => a + b, 0);
    }
  }

  return result;
}

module.exports = {
  parseSessionCookie,
  fetchAccountStatus,
  fetchTokenUsage,
  fetchAggregated,
  QUOTA_PER_USD,
};
