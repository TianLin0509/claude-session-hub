'use strict';
// AI 群聊复用子 session 卡片视图 —— 源码契约（2026-07-29 道雪）
//
// 用户原话："其实我们每个 session 都有自己的卡片视图，我为什么不能直接复用各自 session
// 的卡片视图，来作为 AI 群聊的视图，这样就很方便了，不用一直显示思考中。"
//
// 病根（改前）：群聊三个渲染面都自建了平行实现，且**只看 partial.text**。
// 而 partial.text 在"思考 + 连续工具调用"阶段恒为空（transcript-tap 的 text 只从
// type==='text' 的块里取），于是：
//   - 聊天流气泡 → 「思考中...」空壳
//   - 卡片视图 streaming 分支 → 「💭 思考中 … 详情请点击左侧子 session 查看」
//     （这句话本身就是在承认群聊显示不了子 session 能显示的东西）
// 但同一时刻 partial.blocks 里 thinking / tool_use 早就有内容了 —— 数据在，是渲染没接。
//
// 本测试锁住修复形态，防回退。行为侧的真跑见：
//   tests/renderer-preview-blocks.test.js（blocks → turn 映射）
//   tests/e2e-groupchat-card-reuse-cdp.js（真实隔离 Hub + CDP，截图为证）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const mrSrc = read('renderer', 'meeting-room.js');
const tcSrc = read('renderer', 'turn-card-renderer.js');
const cssSrc = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// --- 1. 平行实现必须已删除 ---------------------------------------------------
test('群聊自建的 blocks 渲染平行实现已删除', () => {
  assert.ok(!/function _renderPreviewBlocks\(/.test(mrSrc),
    '_renderPreviewBlocks 是与 turn-card-renderer 平行的那套渲染，必须删掉而不是留着并存');
  assert.ok(!/function _formatToolUseBlock\(/.test(mrSrc),
    '_formatToolUseBlock 同上（工具摘要归工具簇管）');
  assert.ok(!/class="mr-ft-think"/.test(mrSrc) && !/class="mr-ft-tool"/.test(mrSrc),
    'mr-ft-think / mr-ft-tool 是平行实现的产物，不该再有人生成');
});

test('「详情请点击左侧子 session 查看」这句认输文案不再被渲染', () => {
  // 只允许出现在注释里（记录病史）；不许再出现在生成 HTML 的字符串里。
  assert.ok(!/mr-ft-thinking-hint/.test(mrSrc),
    '群聊卡片现在显示的就是子 session 卡片本身，不需要再让用户自己点过去看');
  const rendered = mrSrc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/详情请点击左侧子 session 查看/.test(rendered),
    '这句文案不得出现在任何会被渲染的字符串里');
});

// --- 2. 三个渲染面都走同一个桥 -----------------------------------------------
test('存在 blocks→turn 桥接层，且工具上限有护栏', () => {
  assert.ok(/function _gcTurnFromBlocks\(/.test(mrSrc), '需要 _gcTurnFromBlocks 把 tap blocks 转成 turn');
  assert.ok(/function _gcRegisterCard\(/.test(mrSrc), '需要 _gcRegisterCard 登记待挂载卡片');
  assert.ok(/function _hydrateGroupChatCards\(/.test(mrSrc), '需要 _hydrateGroupChatCards 真正挂卡');
  assert.ok(/const _GC_TURN_TOOL_CAP = \d+;/.test(mrSrc), '工具调用要有防 DOM 膨胀上限');
});

test('挂载真的走 turn-card-renderer 的 mountSessionTurnCard', () => {
  assert.ok(/window\._mountSessionTurnCard/.test(mrSrc),
    '必须复用 window._mountSessionTurnCard —— 这是单 session 卡片视图用的同一个渲染器');
  assert.ok(/skipTurnRegistry: true/.test(mrSrc) && /skipStreamingIndicator: true/.test(mrSrc),
    '群聊挂卡必须传两个隔离开关，避免与单会话面板互相干扰');
});

test('聊天流 / 卡片视图 / 时间线抽屉三个面都登记卡片', () => {
  for (const [label, re] of [
    ['聊天流气泡', /cardHostHtml = _gcRegisterCard\(cardKey, message\.sid,/],
    ['卡片视图', /const cardHost = _gcRegisterCard\(`ft\|/],
    ['时间线抽屉', /_gcRegisterCard\(tlCardKey, sid,/],
  ]) {
    assert.ok(re.test(mrSrc), `${label} 必须走 _gcRegisterCard，不许再自己拼 markdown`);
  }
});

test('每条 innerHTML 重写路径后面都跟着 hydrate', () => {
  // 挂载点是空 div，忘了 hydrate 就是空气泡 —— 这是本次重构最容易踩的坑，逐条锁死。
  const paths = [
    ['全量重渲', /panel\.innerHTML = _renderGcPanelHtml\(state, meeting\);[\s\S]{0,400}?_hydrateGroupChatCards\(panel\);/],
    ['pending 局部 patch', /articleEl\.outerHTML = newHtml;[\s\S]{0,400}?_hydrateGroupChatCards\(patchedEl\);/],
    ['slot 卡片局部 patch', /slotEl\.outerHTML = html;[\s\S]{0,500}?_hydrateGroupChatCards\(newSlotEl\);/],
    ['抽屉切 tab', /contentEl\.innerHTML = renderTurnBody\(turnsWithAns\[idx\]\);[\s\S]{0,120}?_hydrateGroupChatCards\(contentEl\);/],
    ['抽屉实时更新', /tlBody\.innerHTML = inner;[\s\S]{0,120}?_hydrateGroupChatCards\(tlBody\);/],
  ];
  for (const [label, re] of paths) {
    assert.ok(re.test(mrSrc), `${label} 之后必须 hydrate，否则用户看到空气泡`);
  }
});

// --- 3. "有 blocks 就不算空" 的判空口径 ---------------------------------------
test('判空必须同时看 text 和 blocks（这正是"永久思考中"的病根）', () => {
  const emptyChecks = mrSrc.match(/const empty = !text[^;]*;/g) || [];
  assert.strictEqual(emptyChecks.length, 2,
    '_renderGroupChatPending 与 _patchGroupChatPendingMessage 两处都要有 pending 判空');
  for (const line of emptyChecks) {
    assert.ok(/blocks/.test(line),
      `判空不得只看 text —— thinking / 工具调用先到、text 后到是常态：${line}`);
  }
  assert.ok(!/const empty = !text && status !== 'errored';/.test(mrSrc),
    '不得回退到"只看 text"的旧判空（那正是永久思考中的病根）');
});

test('有真实内容时一律走真卡片，优先于"思考中"占位', () => {
  assert.ok(/if \(cardHostHtml\) \{[\s\S]{0,200}?\} else if \(opts\.empty && !_isSettledStatus\) \{/.test(mrSrc),
    '卡片分支必须排在 empty 占位分支之前，否则有内容也会被"思考中"盖掉');
});

// --- 4. 群聊专属状态由外壳表达，不塞进通用渲染器 -------------------------------
test('群聊调度状态留在外壳，turn-card-renderer 不认识它们', () => {
  for (const s of ['superseded', 'interrupted', 'absent', 'errored', 'send_stuck', 'soft_alert', 'transport_lost']) {
    assert.ok(cssSrc.includes(`.mr-gc-st-${s}`), `群聊状态 ${s} 需要外壳侧的状态条样式`);
  }
  assert.ok(/data-gc-status="/.test(mrSrc), '外壳必须把状态挂到 article 上供 CSS 取用');
  for (const s of ['superseded', 'send_stuck', 'soft_alert', 'transport_lost']) {
    assert.ok(!new RegExp(s).test(tcSrc),
      `turn-card-renderer 不该认识群聊调度语义 '${s}' —— 它是通用 session 卡片渲染器`);
  }
});

// --- 5. 与单会话面板的隔离 ----------------------------------------------------
test('两个隔离开关在 turn-card-renderer 里真的生效', () => {
  assert.ok(/const skipRegistry = opts\.skipTurnRegistry === true;/.test(tcSrc), '需要 skipTurnRegistry 开关');
  assert.ok(/opts\.skipStreamingIndicator === true/.test(tcSrc), '需要 skipStreamingIndicator 开关');
  const registryWrites = tcSrc.match(/win\._sessionTurns\.set\(/g) || [];
  assert.ok(registryWrites.length >= 3, '应有多处 _sessionTurns 写入');
  // 每一处写入都必须被 skipRegistry 守住
  const guarded = tcSrc.match(/if \(!skipRegistry\)[\s\S]{0,120}?win\._sessionTurns\.set\(/g) || [];
  assert.strictEqual(guarded.length, registryWrites.length,
    '每一处 _sessionTurns 写入都必须受 skipRegistry 守卫，漏一处群聊卡片就会污染单会话面板的 turn 表');
  assert.ok(!/if \(typeof updateStreamingIndicator === 'function'\) updateStreamingIndicator\(sessionId\);/.test(
    tcSrc.slice(tcSrc.indexOf('function mountSessionTurnCard'))),
    'mountSessionTurnCard 内不得再无条件调 updateStreamingIndicator（要走 notifyIndicator 开关）');
});

test('群聊卡片不重复渲染身份与死按钮', () => {
  assert.ok(/\.mr-gc-card-host \.turn-avatar \{ display: none; \}/.test(cssSrc),
    '身份由群聊外壳的头像+成员名表达，卡片自带头像要隐藏');
  assert.ok(/\.mr-gc-card-host \.turn-actions \{ display: none; \}/.test(cssSrc),
    '卡片自带操作条在群聊里点不动（全局处理器有 .msg-overlay 守卫），必须隐藏');
});

test('长文折叠不叠两套', () => {
  assert.ok(/if \(b\.querySelector\('\.mr-gc-card-host'\)\) return;/.test(mrSrc),
    '正文是真卡片时，折叠交给卡片自己的 postProcessLongTextFold，群聊不许再套一层');
});

console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
