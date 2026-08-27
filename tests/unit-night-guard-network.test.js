'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAUDE_ENDPOINTS,
  createCurlConnectivityProbe,
  normalizeProxy,
  parseHttpCode,
} = require('../core/night-guard-network.js');

test('401 and 403 are valid transport success responses', async () => {
  const calls = [];
  const probe = createCurlConnectivityProbe({
    now: () => 100,
    execFile(_file, args, _options, callback) {
      calls.push(args);
      const url = args[args.length - 1];
      callback(null, url.includes('api.openai.com') ? '401' : '403', '');
    },
  });
  const result = await probe({ proxy: '127.0.0.1:7890' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.endpoints.map(item => item.httpCode), [403, 401]);
  assert.equal(calls.every(args => args.includes('http://127.0.0.1:7890')), true);
});

test('one failed endpoint keeps the health round closed', async () => {
  const probe = createCurlConnectivityProbe({
    execFile(_file, args, _options, callback) {
      const url = args[args.length - 1];
      if (url.includes('api.openai.com')) {
        const error = new Error('timeout');
        error.code = 28;
        callback(error, '', 'timeout');
      } else callback(null, '403', '');
    },
  });
  const result = await probe({ proxy: 'http://127.0.0.1:7890' });
  assert.equal(result.ok, false);
  assert.equal(result.endpoints[1].errorCode, 'timeout');
});

test('proxy and HTTP code normalization are strict', () => {
  assert.equal(normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseHttpCode(' 401 '), 401);
  assert.equal(parseHttpCode('000'), 0);
});

test('proxy auth and upstream 5xx are not treated as recovered service routes', async () => {
  for (const response of ['407', '502']) {
    const probe = createCurlConnectivityProbe({
      execFile(_file, _args, _options, callback) { callback(null, response, ''); },
    });
    assert.equal((await probe({ proxy: '127.0.0.1:7890' })).ok, false);
  }
});

test('Claude health rounds target Claude and Anthropic endpoints', async () => {
  const urls = [];
  const probe = createCurlConnectivityProbe({
    endpoints: CLAUDE_ENDPOINTS,
    execFile(_file, args, _options, callback) {
      urls.push(args[args.length - 1]);
      callback(null, args[args.length - 1].includes('api.anthropic.com') ? '401' : '403', '');
    },
  });
  assert.equal((await probe({ proxy: '127.0.0.1:7890' })).ok, true);
  assert.deepEqual(urls, ['https://claude.ai/', 'https://api.anthropic.com/v1/models']);
});
