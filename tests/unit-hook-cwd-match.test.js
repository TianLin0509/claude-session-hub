'use strict';
// CodeAgent 待绑定认领：同一目录的短名（8.3）与长名写法要算同一个目录。
// 公司 v0.5.8 自动验收第 04 项：会话建在系统临时目录（用户名超 8 个字符时是短名写法），
// 3 个会话的 hook 全被当成外来者丢掉，卡片一直等不到完成。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sameWorkDir, transcriptBucketMatches } = require('../core/hook-cwd-match');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }

test('逐字相同、大小写或末尾分隔符不同都算同一目录', () => {
  assert.strictEqual(sameWorkDir('C:\\Work\\Proj', 'c:\\work\\proj\\'), true);
  assert.strictEqual(sameWorkDir('C:\\Work\\Proj', 'C:\\Work\\Other'), false);
  assert.strictEqual(sameWorkDir('', 'C:\\Work'), false);
});

test('记录目录按工作目录 slug 比对', () => {
  assert.strictEqual(transcriptBucketMatches('C:\\h\\.cac\\projects\\C--Work-Proj\\a.jsonl', 'C:\\Work\\Proj'), true);
  assert.strictEqual(transcriptBucketMatches('C:\\h\\.cac\\projects\\C--Work-Other\\a.jsonl', 'C:\\Work\\Proj'), false);
});

const shortName = process.platform === 'win32' && process.env.ProgramFiles
  ? path.join(path.parse(process.env.ProgramFiles).root, 'PROGRA~1') : null;
let longName = null;
try { longName = shortName && fs.realpathSync.native(shortName); } catch {}
if (longName && longName.toLowerCase() !== shortName.toLowerCase()) {
  test('8.3 短名与长名算同一目录，记录目录按长名 slug 也认', () => {
    assert.strictEqual(sameWorkDir(shortName, longName), true);
    assert.strictEqual(sameWorkDir(longName, shortName), true);
    const slug = longName.replace(/[^A-Za-z0-9]/g, '-');
    assert.strictEqual(transcriptBucketMatches(path.join(os.tmpdir(), 'projects', slug, 'a.jsonl'), shortName), true);
    assert.strictEqual(sameWorkDir(shortName, path.join(longName, 'Common Files')), false);
  });
} else {
  console.log('  skip 本机没有 8.3 短名（卷上关闭了短名生成）');
}

test('主进程认领与外来判定都走这套比对，日志写明哪项对不上', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /initialCwdMismatch = !sameWorkDir\(parsed\.cwd, hookTargetSession\.cwd\)/);
  assert.match(main, /initialTranscriptBucketMismatch = !transcriptBucketMatches\(/);
  assert.match(main, /sameCwd = !parsed\.cwd \|\| sameWorkDir\(/);
  assert.match(main, /sameBucket = transcriptBucketMatches\(/);
  assert.match(main, /'cwd' : initialTranscriptBucketMismatch \? 'transcript-dir' : 'native-id'/);
  // 绑定记录文件时的「嵌套 CLI」防护也要认两种写法，否则过了认领还是绑不上。
  assert.match(main, /normalizeWorkspaceKey\(fields\.cwd\) !== normalizeWorkspaceKey\(current\.cwd\)\s+&& !sameWorkDir\(fields\.cwd, current\.cwd\)/);
});

console.log(`unit-hook-cwd-match: ${passed} passed`);
