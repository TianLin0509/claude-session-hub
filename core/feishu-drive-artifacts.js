'use strict';

const path = require('path');

const SUPPORTED_DRIVE_HOST_RE = /(?:^|\.)(?:feishu\.cn|larksuite\.com|doubao\.com)$/i;

function buildFeishuDriveUploadArgs(artifact = {}, prefixArgs = []) {
  const fileName = path.basename(String(artifact.path || artifact.name || ''));
  if (!fileName) throw new Error('drive_artifact_missing');
  return [
    ...prefixArgs,
    'drive', '+upload',
    '--file', `./${fileName}`,
    '--as', 'bot',
  ];
}

function buildFeishuDrivePreviewArgs(fileToken, prefixArgs = []) {
  const normalized = String(fileToken || '').trim();
  if (!normalized || !/^[A-Za-z0-9_-]{6,512}$/.test(normalized)) {
    throw new Error('drive_file_token_invalid');
  }
  return [
    ...prefixArgs,
    'drive', '+preview',
    '--file-token', normalized,
    '--list-only',
    '--as', 'bot',
  ];
}

function normalizeDriveUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !SUPPORTED_DRIVE_HOST_RE.test(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function parseDriveUploadData(data = {}) {
  const source = data && typeof data === 'object' ? data : {};
  const file = source.file && typeof source.file === 'object' ? source.file : {};
  const upload = source.upload && typeof source.upload === 'object' ? source.upload : {};
  const result = source.result && typeof source.result === 'object' ? source.result : {};
  const meta = source.meta && typeof source.meta === 'object' ? source.meta : {};
  const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata : {};
  const firstMeta = Array.isArray(source.metas) && source.metas[0] && typeof source.metas[0] === 'object'
    ? source.metas[0]
    : {};
  const fileToken = firstString([
    source.file_token,
    source.fileToken,
    file.file_token,
    file.fileToken,
    file.token,
    upload.file_token,
    upload.fileToken,
    upload.token,
    result.file_token,
    result.fileToken,
    result.token,
    meta.file_token,
    meta.doc_token,
    metadata.file_token,
    metadata.doc_token,
    firstMeta.file_token,
    firstMeta.doc_token,
  ]);
  const url = normalizeDriveUrl(firstString([
    source.url,
    source.file_url,
    source.fileUrl,
    file.url,
    upload.url,
    result.url,
    meta.url,
    metadata.url,
    firstMeta.url,
  ]));
  const permissionGrant = source.permission_grant && typeof source.permission_grant === 'object'
    ? source.permission_grant
    : (result.permission_grant && typeof result.permission_grant === 'object' ? result.permission_grant : null);
  return {
    fileToken,
    url,
    permissionStatus: permissionGrant ? String(permissionGrant.status || '').toLowerCase() || null : null,
  };
}

function parseDrivePreviewData(data = {}) {
  const source = data && typeof data === 'object' ? data : {};
  const candidates = Array.isArray(source.candidates)
    ? source.candidates
    : (source.preview && Array.isArray(source.preview.candidates) ? source.preview.candidates : []);
  const html = candidates.find(candidate => {
    const type = String(candidate && (candidate.type || candidate.label) || '').toLowerCase();
    return type === 'html' || type.includes('html');
  });
  if (!html) return { state: 'unknown', candidateCount: candidates.length };
  const status = String(html.status || html.status_name || '').toUpperCase();
  if (status === 'READY') return { state: 'ready', candidateCount: candidates.length };
  if (status === 'PROCESSING' || status === 'PENDING') return { state: 'processing', candidateCount: candidates.length };
  if (status === 'NO_SUPPORT' || status === 'UNSUPPORTED') return { state: 'unsupported', candidateCount: candidates.length };
  if (status === 'FAILED' || status === 'ERROR') return { state: 'failed', candidateCount: candidates.length };
  return { state: 'unknown', candidateCount: candidates.length };
}

module.exports = {
  SUPPORTED_DRIVE_HOST_RE,
  buildFeishuDrivePreviewArgs,
  buildFeishuDriveUploadArgs,
  normalizeDriveUrl,
  parseDrivePreviewData,
  parseDriveUploadData,
};
