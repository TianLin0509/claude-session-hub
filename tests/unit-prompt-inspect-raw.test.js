'use strict';
// raw 原文层的可验证性单测。
//
// 这个面板的全部价值在于「不是 mock」，所以下面每条都是围绕可验证性写的：
//   - 白名单：只有本次 inspection 真实产出的路径能读；越权路径必须被拒
//   - Windows 路径比较：resolve + 大小写不敏感，c:\x\..\x\a.md 和 C:\X\A.MD 是同一条
//   - sha256 / bytes：必须和独立算出来的值逐字节一致（用户能拿 Get-FileHash 对账）
//   - 分页：多段拼回 === 全文，且不在 UTF-8 多字节字符中间切断
//   - 拼装：顺序 = 外→内（import 紧跟父文件），每段 [start,end) 偏移与真实拼装 buffer 对齐
//   - 不存在的文件优雅报错，不抛
//   - UNAVAILABLE_PARTS 里不许出现任何伪造正文

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PI = require('../core/prompt-inspect.js');
const { registerPromptInspectIpc } = require('../main/ipc/prompt-inspect-handlers.js');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// 造一棵可控的目录树 + 一个假 HOME（避免真实 ~/.claude/CLAUDE.md 干扰断言）
function withTree(fn) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-raw-')));
  const fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  try {
    fn(root, fakeHome);
  } finally {
    process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 标准夹具：root/CLAUDE.md → root/proj/CLAUDE.md（@extra.md）→ root/proj/extra.md
function makeFixture(root) {
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const outer = path.join(root, 'CLAUDE.md');
  const inner = path.join(proj, 'CLAUDE.md');
  const extra = path.join(proj, 'extra.md');
  const orphan = path.join(proj, 'AGENTS.md');
  fs.writeFileSync(outer, '# 外层规则\n中文正文，用于验证 UTF-8 不被切坏。\n', 'utf8');
  fs.writeFileSync(inner, '# 项目规则\n\n@extra.md\n\n结尾行。\n', 'utf8');
  fs.writeFileSync(extra, '# 被 @import 拉进来的片段\n每一行都要逐字对得上。\n', 'utf8');
  fs.writeFileSync(orphan, '# Claude 读不到的 AGENTS.md\n', 'utf8');
  return { proj, outer, inner, extra, orphan };
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    channels: () => [...handlers.keys()],
    call: (channel, payload) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`没有注册 channel: ${channel}`);
      return fn({}, payload);
    },
  };
}

console.log('Running prompt-inspect raw tests...');

// ---------- 白名单 ----------

test('白名单命中：inspection 里出现过的路径都能解析出 source', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    for (const p of [fx.outer, fx.inner, fx.extra, fx.orphan]) {
      assert.ok(PI.resolveAllowedSource(insp, p), `应命中白名单：${p}`);
    }
    // MEMORY.md 即使还不存在，也在 inspection 里出现过 → 允许（读的时候再报 NOT_FOUND）
    assert.ok(PI.resolveAllowedSource(insp, insp.memory.indexPath), 'MEMORY.md 应在白名单里');
  });
});

test('白名单比较：path.resolve 归一化 + Windows 大小写不敏感', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    // .. 绕一圈应归一化到同一条
    const winding = path.join(fx.proj, '..', 'proj', 'CLAUDE.md');
    assert.ok(PI.resolveAllowedSource(insp, winding), `resolve 后应命中：${winding}`);
    if (process.platform === 'win32') {
      assert.ok(PI.resolveAllowedSource(insp, fx.inner.toUpperCase()), '大写路径应命中（Windows 不区分大小写）');
      assert.ok(PI.resolveAllowedSource(insp, fx.inner.toLowerCase()), '小写路径应命中');
    }
  });
});

test('越权被拒：不在 inspection 里的路径一律 null', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET', 'utf8');
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    assert.strictEqual(PI.resolveAllowedSource(insp, secret), null, '同目录旁的普通文件也不许读');
    assert.strictEqual(PI.resolveAllowedSource(insp, 'C:\\Windows\\win.ini'), null);
    assert.strictEqual(PI.resolveAllowedSource(insp, '/etc/passwd'), null);
    assert.strictEqual(PI.resolveAllowedSource(insp, path.join(fx.proj, '..', '..', 'anything.md')), null);
    assert.strictEqual(PI.resolveAllowedSource(insp, ''), null);
    assert.strictEqual(PI.resolveAllowedSource(insp, null), null);
  });
});

test('buildRawAllowlist 去重且全是绝对路径', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    const list = PI.buildRawAllowlist(insp);
    assert.ok(list.length >= 4, `白名单至少 4 条，实际 ${list.length}`);
    assert.ok(list.every(p => path.isAbsolute(p)), '白名单必须全是绝对路径');
    const keys = list.map(PI.pathKey);
    assert.strictEqual(new Set(keys).size, keys.length, '白名单不许有重复');
  });
});

// ---------- sha256 / bytes ----------

test('readRawFile 的 bytes / sha256 与独立计算一致', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const buf = fs.readFileSync(fx.inner);
    const expectSha = crypto.createHash('sha256').update(buf).digest('hex');
    const r = PI.readRawFile(fx.inner);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.totalBytes, buf.length, '字节数必须等于磁盘文件大小');
    assert.strictEqual(r.totalBytes, fs.statSync(fx.inner).size);
    assert.strictEqual(r.sha256, expectSha, 'sha256 必须是整份文件的哈希');
    assert.strictEqual(r.sha256_12, expectSha.slice(0, 12));
    assert.strictEqual(r.text, buf.toString('utf8'), '正文必须与磁盘逐字一致');
    assert.strictEqual(r.contentTruth, 'disk-verbatim');
    assert.strictEqual(r.mtime, new Date(fs.statSync(fx.inner).mtimeMs).toISOString());
  });
});

test('sha256 是整份文件的哈希，不随分页变化', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const full = PI.readRawFile(fx.inner);
    const part = PI.readRawFile(fx.inner, { offset: 0, limit: 4 });
    assert.strictEqual(part.sha256, full.sha256, '分页读也要给整份文件的 sha256');
    assert.ok(part.sliceBytes < full.totalBytes, '这一段应该确实短于全文');
    assert.strictEqual(part.eof, false);
  });
});

// ---------- 分页 ----------

test('分页多段拼回 === 全文，且不在 UTF-8 字符中间切断', () => {
  withTree((root) => {
    const big = path.join(root, 'CLAUDE.md');
    // 全中文（每字 3 字节）+ 一个 4 字节 emoji，专门用来试探切断
    const content = '中文规则'.repeat(400) + '🔍尾巴\n';
    fs.writeFileSync(big, content, 'utf8');

    const total = fs.statSync(big).size;
    let offset = 0;
    let joined = '';
    let rounds = 0;
    for (;;) {
      const r = PI.readRawFile(big, { offset, limit: 7 }); // 7 不是 3 也不是 4 的倍数
      assert.strictEqual(r.ok, true);
      assert.ok(!r.text.includes('\uFFFD'), `第 ${rounds} 段出现替换字符 = 切在了字符中间`);
      joined += r.text;
      assert.ok(r.end > offset || r.eof, '必须推进 offset，否则分页会卡死');
      offset = r.end;
      rounds += 1;
      if (r.eof) break;
      assert.ok(rounds < 5000, '分页轮数异常');
    }
    assert.strictEqual(Buffer.byteLength(joined, 'utf8'), total, '拼回来的字节数要等于文件大小');
    assert.strictEqual(joined, content, '拼回来的正文必须与磁盘逐字一致');
  });
});

test('offset 越界 / limit 非法都不抛', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const size = fs.statSync(fx.inner).size;
    const past = PI.readRawFile(fx.inner, { offset: size + 999, limit: 100 });
    assert.strictEqual(past.ok, true);
    assert.strictEqual(past.sliceBytes, 0);
    assert.strictEqual(past.eof, true);
    const weird = PI.readRawFile(fx.inner, { offset: -50, limit: -1 });
    assert.strictEqual(weird.ok, true);
    assert.strictEqual(weird.offset, 0);
    assert.strictEqual(weird.text, fs.readFileSync(fx.inner, 'utf8'));
  });
});

// ---------- 优雅报错 ----------

test('不存在的文件优雅报 NOT_FOUND（不抛）', () => {
  withTree((root) => {
    const r = PI.readRawFile(path.join(root, 'nope', 'missing.md'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NOT_FOUND');
    assert.ok(r.error && r.error.includes('missing.md'));
  });
});

test('目录被判成 NOT_FILE，不会把整个目录读出来', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const r = PI.readRawFile(fx.proj);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NOT_FILE');
  });
});

// ---------- 拼装顺序与偏移 ----------

test('拼装顺序：外层 CLAUDE.md → 内层 CLAUDE.md → 其 @import', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    const asm = PI.buildAssembly(insp);
    const scoped = asm.segments.filter(s => PI.pathKey(s.path).startsWith(PI.pathKey(root) + path.sep.toLowerCase()));
    const rels = scoped.map(s => path.relative(root, s.path));
    assert.deepStrictEqual(rels, [
      'CLAUDE.md',
      path.join('proj', 'CLAUDE.md'),
      path.join('proj', 'extra.md'),
    ], '注入顺序必须是外→内，且 @import 紧跟它的父文件');
    // 孤儿 AGENTS.md 不进拼装（Claude 根本读不到它）
    assert.ok(!asm.segments.some(s => path.basename(s.path) === 'AGENTS.md'), '孤儿 AGENTS.md 不许进拼装');
    // 顺序诚实度标注
    assert.strictEqual(scoped[0].orderTruth, 'measured');
    assert.strictEqual(scoped[2].orderTruth, 'approx', '@import 插入位置只是近似，必须标 approx');
  });
});

test('拼装偏移：每段 [start,end) 与真实拼装 buffer 对齐', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    const asm = PI.buildAssembly(insp);
    const live = asm.segments.filter(s => !s.missing);
    assert.ok(live.length >= 3, `拼装段数太少：${live.length}`);

    // 按 segments 声明的顺序重建 buffer，再逐段校验偏移
    const rebuilt = Buffer.concat(
      live.map((s, i) => (i === 0
        ? [fs.readFileSync(s.path)]
        : [Buffer.from(asm.joiner, 'utf8'), fs.readFileSync(s.path)])).flat()
    );
    assert.strictEqual(rebuilt.length, asm.totalBytes, 'totalBytes 必须等于真实拼装长度');
    assert.strictEqual(live[0].start, 0, '第一段从 0 开始');
    for (let i = 0; i < live.length; i += 1) {
      const s = live[i];
      const onDisk = fs.readFileSync(s.path);
      assert.strictEqual(s.end - s.start, s.bytes, `#${i} 偏移宽度必须等于 bytes`);
      assert.strictEqual(s.bytes, onDisk.length, `#${i} bytes 必须等于磁盘大小`);
      assert.ok(rebuilt.slice(s.start, s.end).equals(onDisk), `#${i} [start,end) 切出来的必须就是该文件原文`);
      assert.strictEqual(s.sha256_12, crypto.createHash('sha256').update(onDisk).digest('hex').slice(0, 12));
      if (i > 0) {
        assert.strictEqual(s.start, live[i - 1].end + Buffer.byteLength(asm.joiner, 'utf8'),
          `#${i} 起点必须紧跟上一段 + 分隔符`);
      }
    }
    assert.strictEqual(live[live.length - 1].end, asm.totalBytes);
  });
});

test('拼装返回的 text 与磁盘逐字一致，complete 时可直接拼出全文', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    const asm = PI.buildAssembly(insp);
    const live = asm.segments.filter(s => !s.missing);
    for (const s of live) {
      if (s.textOmitted || s.textTruncated) continue;
      assert.strictEqual(s.text, fs.readFileSync(s.path, 'utf8'), `${s.path} 的 text 必须逐字等于磁盘`);
    }
    if (asm.complete) {
      const joined = live.map(s => s.text).join(asm.joiner);
      assert.strictEqual(Buffer.byteLength(joined, 'utf8'), asm.totalBytes);
    }
  });
});

test('超限时只裁正文，偏移与 sha 仍是真实值并显式标注', () => {
  withTree((root) => {
    const big = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(big, 'X'.repeat(5000), 'utf8');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'Y'.repeat(5000), 'utf8');

    const insp = PI.buildInspection({ cwd: proj, kind: 'claude' });
    const asm = PI.buildAssembly(insp, { maxSegmentBytes: 100, maxTotalBytes: 150 });
    const scoped = asm.segments.filter(s => PI.pathKey(s.path).startsWith(PI.pathKey(root) + path.sep.toLowerCase()));
    assert.ok(scoped.some(s => s.textTruncated || s.textOmitted), '应有段落被标为截断/未载入');
    assert.strictEqual(asm.complete, false, '不完整时 complete 必须为 false');
    for (const s of scoped) {
      assert.strictEqual(s.bytes, fs.statSync(s.path).size, '截断只影响 text，bytes 仍是真实文件大小');
      assert.strictEqual(s.end - s.start, s.bytes, '截断不许影响偏移');
      assert.ok(s.textBytes <= s.bytes);
    }
  });
});

test('Codex 会话拼的是 AGENTS.md 链，不是 CLAUDE.md', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'CLAUDE 侧内容\n', 'utf8');
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'CODEX 侧内容\n', 'utf8');

    const insp = PI.buildInspection({ cwd: proj, kind: 'codex' });
    const asm = PI.buildAssembly(insp);
    const scoped = asm.segments.filter(s => PI.pathKey(s.path).startsWith(PI.pathKey(root) + path.sep.toLowerCase()));
    assert.ok(scoped.length > 0, 'codex 侧应至少拼到一份 AGENTS.md');
    assert.ok(scoped.every(s => path.basename(s.path) === 'AGENTS.md'),
      `codex 拼装里不该出现 CLAUDE.md：${scoped.map(s => s.path).join(', ')}`);
  });
});

// ---------- 诚实标注 ----------

test('UNAVAILABLE_PARTS 只写「拿不到 + 为什么」，不含任何伪造正文', () => {
  assert.ok(PI.UNAVAILABLE_PARTS.length >= 3);
  for (const u of PI.UNAVAILABLE_PARTS) {
    assert.strictEqual(typeof u.label, 'string');
    assert.strictEqual(typeof u.why, 'string');
    assert.ok(u.why.length > 8, 'why 必须解释清楚为什么拿不到');
    assert.strictEqual(u.text, undefined, '绝不许携带伪造正文');
    assert.strictEqual(u.content, undefined, '绝不许携带伪造正文');
    assert.strictEqual(u.prompt, undefined, '绝不许携带伪造正文');
  }
  withTree((root) => {
    const fx = makeFixture(root);
    const asm = PI.buildAssembly(PI.buildInspection({ cwd: fx.proj, kind: 'claude' }));
    assert.ok(Array.isArray(asm.unavailable) && asm.unavailable.length >= 3, '拼装结果必须带上「拿不到」清单');
    assert.ok(asm.segments.every(s => s.missing || s.contentTruth === 'disk-verbatim'),
      '每个拼装段的内容必须标为磁盘实读原文');
  });
});

// ---------- IPC 层（真实 handler，不是 mock） ----------

test('IPC 注册三个 channel', () => {
  const ipc = fakeIpcMain();
  registerPromptInspectIpc(ipc, { sessionManager: null });
  assert.deepStrictEqual(ipc.channels().sort(),
    ['prompt-inspect', 'prompt-inspect-assemble', 'prompt-inspect-raw']);
});

test('IPC prompt-inspect-raw：合法路径返回与磁盘逐字一致的原文', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const ipc = fakeIpcMain();
    registerPromptInspectIpc(ipc, {
      sessionManager: { getSession: (id) => (id === 'S1' ? { cwd: fx.proj, kind: 'claude' } : undefined) },
    });
    const res = ipc.call('prompt-inspect-raw', { sessionId: 'S1', path: fx.inner });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.data.text, fs.readFileSync(fx.inner, 'utf8'));
    assert.strictEqual(res.data.totalBytes, fs.statSync(fx.inner).size);
    assert.strictEqual(res.data.sha256,
      crypto.createHash('sha256').update(fs.readFileSync(fx.inner)).digest('hex'));
    assert.strictEqual(res.data.injected, true);
  });
});

test('IPC prompt-inspect-raw：越权路径必须 FORBIDDEN', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET', 'utf8');
    const ipc = fakeIpcMain();
    registerPromptInspectIpc(ipc, {
      sessionManager: { getSession: () => ({ cwd: fx.proj, kind: 'claude' }) },
    });
    for (const bad of [secret, 'C:\\Windows\\win.ini', '/etc/passwd', path.join(root, 'home', '.ssh', 'id_rsa')]) {
      const res = ipc.call('prompt-inspect-raw', { sessionId: 'S1', path: bad });
      assert.strictEqual(res.ok, false, `${bad} 不该被放行`);
      assert.strictEqual(res.code, 'FORBIDDEN', `${bad} 应报 FORBIDDEN，实际 ${res.code}`);
      assert.ok(!('text' in (res.data || {})), '被拒时绝不能带回任何正文');
    }
  });
});

test('IPC prompt-inspect-raw：renderer 传的 cwd 决定白名单，不能越到别的 cwd', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    const otherOnly = path.join(other, 'AGENTS.md');
    fs.writeFileSync(otherOnly, 'other tree only\n', 'utf8');

    const ipc = fakeIpcMain();
    registerPromptInspectIpc(ipc, { sessionManager: null });
    // 用 proj 的 cwd 去读 other 目录里的文件 → 不在白名单
    const res = ipc.call('prompt-inspect-raw', { cwd: fx.proj, kind: 'claude', path: otherOnly });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'FORBIDDEN');
  });
});

test('IPC prompt-inspect-raw：缺 cwd / 缺 path / 白名单内但文件不存在，各自明确报错', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const ipc = fakeIpcMain();
    registerPromptInspectIpc(ipc, {
      sessionManager: { getSession: (id) => (id === 'S1' ? { cwd: fx.proj, kind: 'claude' } : undefined) },
    });

    const noCwd = ipc.call('prompt-inspect-raw', { sessionId: 'GONE', path: fx.inner });
    assert.strictEqual(noCwd.ok, false);
    assert.strictEqual(noCwd.code, 'NO_CWD');

    const noPath = ipc.call('prompt-inspect-raw', { sessionId: 'S1' });
    assert.strictEqual(noPath.ok, false);
    assert.strictEqual(noPath.code, 'NO_PATH');

    // MEMORY.md 在白名单里但这棵假 HOME 下并不存在 → NOT_FOUND 而不是 FORBIDDEN
    const insp = PI.buildInspection({ cwd: fx.proj, kind: 'claude' });
    assert.ok(!fs.existsSync(insp.memory.indexPath), '前提：假 HOME 下没有 MEMORY.md');
    const missing = ipc.call('prompt-inspect-raw', { sessionId: 'S1', path: insp.memory.indexPath });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.code, 'NOT_FOUND');
    assert.ok(missing.error.includes('MEMORY.md'));
  });
});

test('IPC prompt-inspect-raw：分页参数透传，多次调用能读完整份文件', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const ipc = fakeIpcMain();
    registerPromptInspectIpc(ipc, { sessionManager: null });
    let offset = 0;
    let joined = '';
    for (let i = 0; i < 500; i += 1) {
      const res = ipc.call('prompt-inspect-raw', { cwd: fx.proj, kind: 'claude', path: fx.inner, offset, limit: 5 });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      joined += res.data.text;
      offset = res.data.end;
      if (res.data.eof) break;
    }
    assert.strictEqual(joined, fs.readFileSync(fx.inner, 'utf8'));
  });
});

test('IPC prompt-inspect-assemble：返回段索引 + 偏移 + 拿不到清单', () => {
  withTree((root) => {
    const fx = makeFixture(root);
    const ipc = fakeIpcMain();
    registerPromptInspectIpc(ipc, {
      sessionManager: { getSession: () => ({ cwd: fx.proj, kind: 'claude' }) },
    });
    const res = ipc.call('prompt-inspect-assemble', { sessionId: 'S1' });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(res.data.segments.length >= 3);
    assert.ok(res.data.totalBytes > 0);
    assert.ok(res.data.unavailable.length >= 3);
    assert.ok(res.data.allowlistSize >= 4);
    assert.strictEqual(res.data.cwd, fx.proj);
  });
});

test('IPC prompt-inspect-assemble：没有 cwd 时报 NO_CWD 而不是抛异常', () => {
  const ipc = fakeIpcMain();
  registerPromptInspectIpc(ipc, { sessionManager: null });
  const res = ipc.call('prompt-inspect-assemble', { sessionId: 'nobody' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'NO_CWD');
});

if (failures === 0) console.log('All prompt-inspect raw tests passed.');
