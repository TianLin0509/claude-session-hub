'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  cleanUrl,
  normalizeOperationsConfig,
  serializeOperationsConfig,
} = require('../core/operations-config.js');

test('operations config accepts only HTTP health endpoints and preserves optional fields', () => {
  assert.equal(cleanUrl('file:///C:/secret'), '');
  assert.equal(cleanUrl('javascript:alert(1)'), '');
  assert.equal(cleanUrl('https://ops.example.com/health#token'), 'https://ops.example.com/health');

  const normalized = normalizeOperationsConfig({
    aliyun_monitor: {
      enabled: true,
      label: '生产 ECS',
      health_url: 'https://ops.example.com/health',
      metrics_url: 'https://ops.example.com/metrics',
      bearer_token: 'secret',
    },
    restore_root: 'C:\\Vibe\\Worktrees',
  });
  assert.equal(normalized.aliyunMonitor.enabled, true);
  assert.equal(normalized.aliyunMonitor.label, '生产 ECS');
  assert.equal(normalized.aliyunMonitor.bearerToken, 'secret');
  assert.equal(normalized.restoreRoot, 'C:\\Vibe\\Worktrees');
});

test('partial operations update does not erase the stored server monitor', () => {
  const updated = serializeOperationsConfig({
    aliyun_monitor: {
      enabled: true,
      label: 'ECS-A',
      health_url: 'https://ops.example.com/health',
      bearer_token: 'keep-me',
    },
  }, { restoreRoot: 'D:\\Worktrees' });
  assert.equal(updated.aliyun_monitor.enabled, true);
  assert.equal(updated.aliyun_monitor.label, 'ECS-A');
  assert.equal(updated.aliyun_monitor.bearer_token, 'keep-me');
  assert.equal(updated.restore_root, 'D:\\Worktrees');
});
