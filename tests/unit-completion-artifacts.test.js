'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_ARTIFACT_BYTES,
  discoverCompletionArtifacts,
  isSensitiveArtifactPath,
} = require('../core/completion-artifacts.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-completion-artifacts-'));
try {
  const outputDir = path.join(tempDir, 'artifacts');
  const sourceDir = path.join(tempDir, 'renderer');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  const htmlPath = path.join(outputDir, '20260901-AIHub-成果快递.html');
  const pdfPath = path.join(outputDir, '20260901-AIHub-说明.pdf');
  const sensitivePath = path.join(outputDir, '20260901-api-token-report.html');
  const sourcePath = path.join(sourceDir, 'index.html');
  const oversizedPath = path.join(outputDir, '20260901-AIHub-big.zip');
  fs.writeFileSync(htmlPath, '<!doctype html><title>成果</title>', 'utf8');
  fs.writeFileSync(pdfPath, '%PDF-mock', 'utf8');
  fs.writeFileSync(sensitivePath, '<title>secret</title>', 'utf8');
  fs.writeFileSync(sourcePath, '<title>Hub source</title>', 'utf8');
  fs.writeFileSync(oversizedPath, Buffer.from([0]));
  fs.truncateSync(oversizedPath, MAX_ARTIFACT_BYTES + 1);

  const filler = '无关说明'.repeat(80);
  const text = [
    `绝对路径：${htmlPath}`,
    `绝对路径：${htmlPath}`,
    `绝对路径：${pdfPath}`,
    `绝对路径：${sensitivePath}`,
    `绝对路径：${oversizedPath}`,
    filler,
    `修改源码：${sourcePath}`,
    '```text',
    `绝对路径：${path.join(outputDir, 'inside-code.html')}`,
    '```',
  ].join('\n');
  fs.writeFileSync(path.join(outputDir, 'inside-code.html'), '<title>code</title>', 'utf8');

  const artifacts = discoverCompletionArtifacts(text, tempDir);
  assert.deepEqual(artifacts.map(item => item.path), [htmlPath, pdfPath]);
  assert.deepEqual(artifacts.map(item => item.kind), ['html', 'pdf']);
  assert.equal(isSensitiveArtifactPath(sensitivePath), true);
  assert.equal(isSensitiveArtifactPath(htmlPath), false);

  const noSignal = discoverCompletionArtifacts(`修改了 ${sourcePath}`, tempDir);
  assert.deepEqual(noSignal, [], 'source-code references must not be mistaken for delivered artifacts');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('unit-completion-artifacts.test.js OK');
