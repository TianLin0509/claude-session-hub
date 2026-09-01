'use strict';

const assert = require('node:assert/strict');
const {
  buildFeishuDrivePreviewArgs,
  buildFeishuDriveUploadArgs,
  normalizeDriveUrl,
  parseDrivePreviewData,
  parseDriveUploadData,
} = require('../core/feishu-drive-artifacts.js');

const uploadArgs = buildFeishuDriveUploadArgs({
  path: 'C:\\artifacts\\20260901-AIHub-native-preview.html',
});
assert.deepEqual(uploadArgs.slice(0, 2), ['drive', '+upload']);
assert.ok(uploadArgs.includes('./20260901-AIHub-native-preview.html'));
assert.ok(uploadArgs.includes('--as'));
assert.ok(uploadArgs.includes('bot'));

const previewArgs = buildFeishuDrivePreviewArgs('boxcn_native_preview');
assert.deepEqual(previewArgs.slice(0, 2), ['drive', '+preview']);
assert.ok(previewArgs.includes('--list-only'));
assert.throws(() => buildFeishuDrivePreviewArgs('../bad'), /drive_file_token_invalid/);

assert.equal(normalizeDriveUrl('https://tenant.feishu.cn/file/boxcn_x'), 'https://tenant.feishu.cn/file/boxcn_x');
assert.equal(normalizeDriveUrl('https://tenant.larksuite.com/file/boxcn_x'), 'https://tenant.larksuite.com/file/boxcn_x');
assert.equal(normalizeDriveUrl('https://evil.example/file/boxcn_x'), null);
assert.equal(normalizeDriveUrl('javascript:alert(1)'), null);

assert.deepEqual(parseDriveUploadData({
  file_token: 'boxcn_native_preview',
  url: 'https://tenant.feishu.cn/file/boxcn_native_preview',
  permission_grant: { status: 'granted' },
}), {
  fileToken: 'boxcn_native_preview',
  url: 'https://tenant.feishu.cn/file/boxcn_native_preview',
  permissionStatus: 'granted',
});

assert.deepEqual(parseDriveUploadData({
  result: { token: 'boxcn_nested', permission_grant: { status: 'failed' } },
  metas: [{ url: 'https://tenant.feishu.cn/file/boxcn_nested' }],
}), {
  fileToken: 'boxcn_nested',
  url: 'https://tenant.feishu.cn/file/boxcn_nested',
  permissionStatus: 'failed',
});

assert.equal(parseDrivePreviewData({ candidates: [{ type: 'html', status: 'READY' }] }).state, 'ready');
assert.equal(parseDrivePreviewData({ candidates: [{ type: 'html', status: 'PROCESSING' }] }).state, 'processing');
assert.equal(parseDrivePreviewData({ candidates: [{ type: 'html', status: 'NO_SUPPORT' }] }).state, 'unsupported');
assert.equal(parseDrivePreviewData({ candidates: [{ type: 'pdf', status: 'READY' }] }).state, 'unknown');

console.log('unit-feishu-drive-artifacts.test.js OK');
