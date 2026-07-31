'use strict';
// ensureMemoryLink 从不 throw —— 四种保护（错链 / 非普通文件 / memory 是文件 / 锁竞争）
// 全部收进 result.errors 返回。2026-07-29 三方审查第四轮发现调用侧把返回值整个丢了，
// 于是那些保护一条都到不了用户：会话照常起、记忆却接在错误的库上，现场零线索。
// 这组断言锁住「检测 → session 留痕 → renderer 透传 → 侧栏 ⚠」整条链。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const sessionManager = read('core/session-manager.js');
const persistence = read('main/ipc/persistence-handlers.js');
const renderer = read('renderer/renderer.js');
const sessionList = read('renderer/session-list-renderer.js');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}`); console.error(err.message); }
}

console.log('Running memory link warning tests...');

check('调用侧接住返回值而不是丢弃', () => {
  assert.match(sessionManager, /const memResult = ensureMemoryLink\(spawnCwd,\s*\{/,
    'ensureMemoryLink 的返回值必须被接住——它不 throw，丢了就等于没有错误处理');
  assert.match(sessionManager, /memResult\.errors\.length/, '必须检查 errors');
  assert.match(sessionManager, /projectRootDirs:\s*\[isDeepSeek \? '\.claude-deepseek' : '\.claude'\]/,
    'Claude / DeepSeek 只应维护各自的 bucket，不能跨 provider 制造空壳或误报警');
});

check('错误落到 session 上供 UI 读取', () => {
  assert.match(sessionManager, /memoryLinkWarning:\s*memResult\.errors\.join|memoryLinkWarning = memResult\.errors\.join/);
  assert.match(sessionManager, /memoryLinkWarning:\s*memoryLinkWarning \|\| null/,
    '成功时也必须显式发 null，才能覆盖 renderer 里旧的告警');
});

check('回收动作有日志（并入/冲突不能静默）', () => {
  assert.match(sessionManager, /memResult\.merged\.length \|\| memResult\.conflicts\.length/);
});

check('renderer 持久化和 dormant 恢复都透传，但 resume 请求不回灌旧警告', () => {
  assert.match(renderer, /memoryLinkWarning:\s*s\.memoryLinkWarning \|\| null/,
    '持久化 payload 必须带 warning');
  assert.match(renderer, /memoryLinkWarning:\s*meta\.memoryLinkWarning \|\| null/,
    'dormant restore 必须恢复 warning');
  const resumeRequest = renderer.slice(
    renderer.indexOf("ipcRenderer.invoke('resume-session'"),
    renderer.indexOf('});', renderer.indexOf("ipcRenderer.invoke('resume-session'")),
  );
  assert.ok(!/memoryLinkWarning/.test(resumeRequest),
    '旧 warning 不能回灌给新 spawn；新 session 要以本次检测结果为准');
});

check('侧栏显示 ⚠ 且 tooltip 含记忆告警', () => {
  assert.match(sessionList, /session\.memoryLinkWarning/, '侧栏 helper 必须读这个字段');
  assert.match(sessionList, /anyWarning \? `<span class="sl-pin"/,
    '⚠ 图标要同时覆盖 cwd 回落与记忆告警，不能只认 cwd');
});

// 这条是本轮差点踩进去的坑，必须锁死。
check('memoryLinkWarning 绝不能进 RESUME_META_FIELDS', () => {
  const block = persistence.slice(
    persistence.indexOf('const RESUME_META_FIELDS'),
    persistence.indexOf('];', persistence.indexOf('const RESUME_META_FIELDS')),
  );
  assert.ok(!/'memoryLinkWarning'/.test(block),
    'RESUME_META_FIELDS 的语义是「新会话缺该字段就继承旧值」。memory link 每次 spawn 都重新'
    + '检测，放进来会让警告永久粘住、修好也删不掉（cwdFellBackFrom 能放是因为 healPersistedCwds'
    + ' 里有显式 delete 清除路径）。');
});

check('成功的 resume 会清掉旧 warning，而不是被对象合并粘住', () => {
  assert.match(renderer, /\.\.\.existing,\s*\.\.\.session/s,
    '先确认 renderer 的 resume 路径确实以新 session 覆盖旧 session');
  const oldSession = { id: 's1', memoryLinkWarning: '旧错链' };
  const cleanSession = { id: 's1', memoryLinkWarning: null };
  assert.strictEqual(({ ...oldSession, ...cleanSession }).memoryLinkWarning, null,
    '新 session 显式 null 后，旧 warning 才能被清除');
});

// 行为层：真跑一次，确认错链场景确实产出 errors 而不是静默通过。
check('错链场景真的产出 errors（不是只靠源码匹配）', () => {
  const { ensureMemoryLink, canonicalMemoryDir } = require('../core/claude-memory-link.js');
  const { projectSlug } = require('../core/claude-transcript-locator.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memwarn-'));
  try {
    const canonical = canonicalMemoryDir(home);
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'MEMORY.md'), '# Router\n', 'utf8');

    const cwd = 'C:\\Vibe\\AI\\wrong-target';
    const bucket = path.join(home, '.claude', 'projects', projectSlug(cwd));
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(bucket, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(bucket, 'memory'), 'junction');

    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {}, log() {} } });
    assert.ok(result.errors.some(e => e.includes('没有指向规范库')),
      `错链必须进 errors，实际：${JSON.stringify(result.errors)}`);
    // 只有 .claude 那个 root 被做成了错链；.claude-deepseek 没有，它正常建 junction
    // 是**正确行为**（一个 root 出问题不该拖垮另一个）。所以只断言错链那个没被改写。
    const wrongLink = path.join(bucket, 'memory');
    assert.ok(!result.linked.includes(wrongLink), '错链的那个 root 不许悄悄改写');
    assert.strictEqual(fs.realpathSync.native(wrongLink), fs.realpathSync.native(elsewhere),
      '错链必须原样保留，指向原来的目标');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

if (failed) { process.exitCode = 1; }
else console.log('All memory link warning tests passed.');
