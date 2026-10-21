'use strict';
// 公司版 v3.1.0（2026-10-21）：安装包的 beforePack 钩子要求自带会议室运行时，
// 公司库 CI 必须在打包前下载官方公开 release 资产并按 baseline.json 校验。
// 公司版的 ci.yml 由目标 overlay 覆盖社区版 overlay；这里守住两件事：
// ① 公司版只比社区版多「下载运行时」这一步，社区版 CI 以后改了，公司版也得跟着改；
// ② 这一步在打包之前，按 baseline.json 的版本、文件名、大小、哈希校验，并只设置环境变量。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const community = read('community/overlay/.github/workflows/ci.yml');
const company = read('community/targets/company/overlay/.github/workflows/ci.yml');
const STEP_NAME = '      - name: Fetch pinned meeting-room runtime for the company installer\n';

function splitStep(text) {
  const start = text.indexOf(STEP_NAME);
  assert.ok(start >= 0, '公司版 ci.yml 缺少下载会议室运行时的步骤');
  const next = text.indexOf('\n      - ', start + 1);
  assert.ok(next > start, '下载步骤后面应当还有打包步骤');
  return { step: text.slice(start, next + 1), rest: text.slice(0, start) + text.slice(next + 1) };
}

test('公司版 ci.yml 只比社区版多下载运行时这一步', () => {
  const { rest } = splitStep(company);
  assert.strictEqual(rest, community);
});

test('下载步骤在打包之前，按 baseline.json 校验后才设置 AI_HUB_ROOM_RUNTIME_SOURCE', () => {
  const { step } = splitStep(company);
  assert.ok(company.indexOf(STEP_NAME) < company.indexOf('run: npm run dist'), '必须在 npm run dist 之前');
  assert.match(step, /room-component\/baseline\.json/);
  assert.match(step, /releases\/download\/v\$\(\$baseline\.version\)\/\$\(\$exe\.file\)/);
  assert.match(step, /Get-FileHash -Algorithm SHA256/);
  assert.match(step, /\$hash -ne \$exe\.sha256 -or \$size -ne \[int64\]\$exe\.size/);
  assert.ok(step.indexOf('throw "runtime mismatch') < step.indexOf('AI_HUB_ROOM_RUNTIME_SOURCE='), '校验失败要先抛错，不能先设变量');
  assert.match(step, /GITHUB_ENV/);
  assert.doesNotMatch(step, /npm (i|install|ci)\b|choco |winget |pip /, '这一步只下载运行时，不装别的东西');
});

test('baseline.json 的运行时是钩子要求的那个官方 exe', () => {
  const baseline = JSON.parse(read('core/company-assistant/room-component/baseline.json'));
  assert.strictEqual(baseline.version, '2.1.0');
  assert.strictEqual(baseline.exe.file, 'MishuTerminator-2.1.0.exe');
  assert.strictEqual(baseline.exe.size, 80568759);
  assert.match(baseline.exe.sha256, /^[0-9a-f]{64}$/);
  const target = JSON.parse(read('community/targets/company/target.json'));
  assert.strictEqual(target.build.beforePack, 'core/company-assistant/room-component/build-runtime.js');
});
