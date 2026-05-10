'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const {
  createReportPublisher,
  extractLocalReportPaths,
  markdownToHtml,
} = require('../core/report-publisher.js');

function req(port, pathS) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathS }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function withServer(app, fn) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testPublisherRoutes() {
  const tmp = path.join(os.tmpdir(), 'csh-report-publisher-' + Date.now());
  const reportsDir = path.join(tmp, 'published');
  fs.mkdirSync(tmp, { recursive: true });
  const mdPath = path.join(tmp, 'demo report.md');
  const htmlPath = path.join(tmp, 'demo.html');
  fs.writeFileSync(mdPath, '# 标题\n\n- **结论**：可以手机阅读\n', 'utf8');
  fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><h1>HTML Report</h1>', 'utf8');

  const publisher = createReportPublisher({
    reportsDir,
    token: 'tok',
    getBaseUrl: () => 'http://127.0.0.1:0',
  });
  const app = express();
  app.use('/reports', publisher.router());

  await withServer(app, async (port) => {
    const mdLink = publisher.publishFile(mdPath);
    const htmlLink = publisher.publishFile(htmlPath);
    assert.strictEqual(mdLink.type, 'md');
    assert.strictEqual(htmlLink.type, 'html');

    const bad = await req(port, `/reports/${mdLink.id}/${encodeURIComponent(mdLink.name)}?token=bad`);
    assert.strictEqual(bad.status, 401);

    const md = await req(port, `/reports/${mdLink.id}/${encodeURIComponent(mdLink.name)}?token=tok`);
    assert.strictEqual(md.status, 200);
    assert.ok(md.body.includes('<h1>标题</h1>'));
    assert.ok(md.body.includes('<strong>结论</strong>'));

    const html = await req(port, `/reports/${htmlLink.id}/${encodeURIComponent(htmlLink.name)}?token=tok`);
    assert.strictEqual(html.status, 200);
    assert.ok(html.body.includes('HTML Report'));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  ok publisher routes');
}

function testHelpers() {
  const paths = extractLocalReportPaths('已生成 C:\\Users\\lintian\\docs\\a report.html 和 C:\\tmp\\b.md。');
  assert.deepStrictEqual(paths, ['C:\\Users\\lintian\\docs\\a report.html', 'C:\\tmp\\b.md']);
  assert.ok(markdownToHtml('## T\n\n1. `cmd`').includes('<code>cmd</code>'));
  console.log('  ok helpers');
}

(async () => {
  console.log('Running report publisher tests...');
  testHelpers();
  await testPublisherRoutes();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
