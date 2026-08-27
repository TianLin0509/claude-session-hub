'use strict';

const childProcess = require('child_process');

const DEFAULT_ENDPOINTS = [
  { name: 'chatgpt', url: 'https://chatgpt.com/' },
  { name: 'openai-api', url: 'https://api.openai.com/v1/models' },
];

function execFileUtf8(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function normalizeProxy(value) {
  const proxy = String(value || '').trim();
  if (!proxy) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
}

function parseHttpCode(value) {
  const match = String(value || '').match(/(?:^|\s)([1-5]\d\d)(?:\s|$)/);
  return match ? Number(match[1]) : 0;
}

function probeErrorCode(error) {
  if (error && error.code === 'ENOENT') return 'curl-unavailable';
  if (error && (error.killed || error.code === 'ETIMEDOUT' || error.code === 28)) return 'timeout';
  return 'transport-failed';
}

function createCurlConnectivityProbe(options = {}) {
  const execFileImpl = options.execFile || childProcess.execFile;
  const endpoints = Array.isArray(options.endpoints) && options.endpoints.length
    ? options.endpoints
    : DEFAULT_ENDPOINTS;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
  const curlBin = options.curlBin || (process.platform === 'win32' ? 'curl.exe' : 'curl');
  const nullDevice = options.nullDevice || (process.platform === 'win32' ? 'NUL' : '/dev/null');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  return async function probeConnectivity(input = {}) {
    const proxy = normalizeProxy(input.proxy);
    const checkedAt = now();
    if (!proxy) {
      return {
        ok: false,
        checkedAt,
        errorCode: 'proxy-not-configured',
        error: '未配置可验证的代理地址',
        endpoints: [],
      };
    }

    const results = await Promise.all(endpoints.map(async endpoint => {
      const args = [
        '--silent',
        '--show-error',
        '--location',
        '--ipv4',
        '--connect-timeout', String(Math.max(2, Math.min(6, Math.ceil(timeoutMs / 2000)))),
        '--max-time', String(Math.max(3, Math.ceil(timeoutMs / 1000))),
        '--proxy', proxy,
        '--output', nullDevice,
        '--write-out', '%{http_code}',
        '--user-agent', 'AI-Hub-Night-Guard/1.0',
        endpoint.url,
      ];
      const startedAt = now();
      try {
        const stdout = await execFileUtf8(execFileImpl, curlBin, args, {
          windowsHide: true,
          timeout: timeoutMs + 1500,
          maxBuffer: 64 * 1024,
        });
        const httpCode = parseHttpCode(stdout);
        return {
          name: String(endpoint.name || endpoint.url),
          url: endpoint.url,
          // 401/403/429 prove that TLS reached the real service. A proxy-auth
          // 407 or upstream/proxy 5xx does not prove the Codex route recovered.
          ok: httpCode >= 200 && httpCode < 500 && httpCode !== 407,
          httpCode,
          durationMs: Math.max(0, now() - startedAt),
          errorCode: httpCode ? null : 'no-http-response',
        };
      } catch (error) {
        return {
          name: String(endpoint.name || endpoint.url),
          url: endpoint.url,
          ok: false,
          httpCode: 0,
          durationMs: Math.max(0, now() - startedAt),
          errorCode: probeErrorCode(error),
          error: String(error && error.message || '连接失败').slice(0, 300),
        };
      }
    }));

    const ok = results.length > 0 && results.every(result => result.ok);
    return {
      ok,
      checkedAt,
      proxy,
      endpoints: results,
      errorCode: ok ? null : 'endpoint-failed',
      error: ok ? null : '代理尚未连续连通 Codex 所需端点',
    };
  };
}

function createFixtureConnectivityProbe(fixture = {}, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const rounds = Array.isArray(fixture.rounds) ? fixture.rounds.slice() : [];
  let index = 0;
  return async function fixtureProbe(input = {}) {
    const selected = rounds[Math.min(index, Math.max(0, rounds.length - 1))]
      || fixture.default
      || { ok: true };
    index += 1;
    return {
      checkedAt: now(),
      proxy: normalizeProxy(input.proxy),
      endpoints: [],
      ...selected,
    };
  };
}

module.exports = {
  DEFAULT_ENDPOINTS,
  createCurlConnectivityProbe,
  createFixtureConnectivityProbe,
  normalizeProxy,
  parseHttpCode,
};
