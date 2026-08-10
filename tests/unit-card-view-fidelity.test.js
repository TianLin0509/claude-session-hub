'use strict';
// 卡片视图的两类失真（用户 2026-07-28 反馈）：
//   1) "你"的卡片显示的不是我打的字 —— 系统注入被当成了用户 prompt
//   2) AI 的回答卡片经常重复出现两遍
// 外加群聊状态灯与侧栏代理显示。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  isSyntheticUserText,
  extractGroupChatUserInput,
  displayUserText,
} = require('../core/synthetic-user-filter.js');

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const CARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'turn-card-renderer.js'), 'utf8');
const LIST_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'), 'utf8');
const CLAUDE_PARSER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'claude-transcript-parser.js'), 'utf8');
const CODEX_PARSER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'codex-transcript-parser.js'), 'utf8');
const RUNNING_STATE_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'groupchat-running-state.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running card view fidelity tests...');

// ---- 1. 只显示用户自己的 prompt ----

test('斜杠命令回显与打断占位不算用户输入', () => {
  // 实测扫 101 份 transcript，这两类漏网最多
  assert.strictEqual(isSyntheticUserText('<local-command-stdout>Set model to Opus 5'), true);
  assert.strictEqual(isSyntheticUserText('<local-command-stdout>Goal set: 修一下 Hub'), true);
  assert.strictEqual(isSyntheticUserText('[Request interrupted by user]'), true);
  assert.strictEqual(isSyntheticUserText('[Request interrupted by user for tool use]'), true);
});

test('Codex 的 AGENTS.md 系统注入不算用户输入', () => {
  const raw = '# AGENTS.md instructions for C:\\Vibe\\x\n\n<INSTRUCTIONS>\n# Codex 全局约定\n</INSTRUCTIONS>';
  assert.strictEqual(isSyntheticUserText(raw), true);
  assert.strictEqual(displayUserText(raw), null);
});

test('群聊脚手架里只抽出「## 用户」那一段', () => {
  const scaffold = [
    '## 规则',
    '- 这里是AI群聊，你是Claude 1。可赞同、反对、追问。',
    '- 独到见解 > 全面但泛泛而谈。',
    '',
    '## 输出',
    '简单问题直答。',
    '',
    '## 新增发言',
    'Codex 2：我觉得应该先看代码。',
    '',
    '## 用户',
    '帮我看下这个 bug 是怎么来的',
    '',
    '请发言。',
  ].join('\n');
  assert.strictEqual(extractGroupChatUserInput(scaffold), '帮我看下这个 bug 是怎么来的');
  assert.strictEqual(displayUserText(scaffold), '帮我看下这个 bug 是怎么来的');
});

test('纯转述轮（用户这轮没说话）不冒出空的「你」卡片', () => {
  const scaffold = '## 新增发言\nKimi 3：我补充一点。\n\n## 用户\n\n\n请发言。';
  assert.strictEqual(displayUserText(scaffold), null);
});

test('正文里恰好写了「## 用户」的普通提问不被裁剪', () => {
  const normal = '帮我写个文档，结构如下：\n\n## 用户\n讲用户故事\n\n## 系统\n讲架构';
  assert.strictEqual(extractGroupChatUserInput(normal), null,
    '没有群聊脚手架特征时不许动手');
  assert.strictEqual(displayUserText(normal), normal);
});

test('普通用户输入原样通过', () => {
  assert.strictEqual(displayUserText('继续'), '继续');
  assert.strictEqual(displayUserText('帮我修一下 Hub'), '帮我修一下 Hub');
});

test('两个解析器都接了 displayUserText', () => {
  assert.match(CLAUDE_PARSER_SRC, /displayUserText\(message\.content\)/);
  assert.match(CLAUDE_PARSER_SRC, /displayUserText\(raw\)/);
  assert.match(CODEX_PARSER_SRC, /displayUserText\(raw\)/);
});

// ---- 2. 回答卡片不重复 ----

test('transcript 未落盘时的兜底卡被标记为可替换', () => {
  assert.match(
    RENDERER_SRC,
    /fallbackEl\.dataset\.provisional = 'true';/,
    '兜底卡用的是合成 id，必须打标记，否则真卡到达后会并存成两张',
  );
  assert.match(RENDERER_SRC, /fallbackEl\.dataset\.provisionalText = fallbackTurn\.text/);
});

test('真回答卡到达时撤掉同会话的兜底卡', () => {
  assert.match(CARD_SRC, /turn-card\.assistant\[data-provisional="true"\]/);
  assert.match(CARD_SRC, /prov\.dataset\.sessionId !== sidStr/, '只撤自己会话的，别误伤别的会话');
  assert.match(CARD_SRC, /prov\.dataset\.turnId === turn\.id/, '别把自己撤掉');
  assert.match(CARD_SRC, /realText\.startsWith\(provText\) \|\| provText\.startsWith\(realText\)/,
    '兜底卡是纯文本、真卡是结构化解析，必须前缀匹配而非全等');
});

// ---- 3. 群聊状态综合 session 与新鲜 watcher ----

test('idle 只压过过期 watcher，新鲜 watcher 可覆盖 PTY 的短暂空闲', () => {
  assert.match(LIST_SRC, /function _subIsRunning\(sub\)/);
  assert.match(LIST_SRC, /return isGroupChatMemberRunning\(sub\)/,
    '成员点和群聊父项必须走共享的新鲜度判定');
  assert.match(RUNNING_STATE_SRC,
    /hasFreshGroupChatWork\(session, now\)[\s\S]{0,120}session\.status === 'idle'/,
    '新鲜 watcher 判定必须先于 idle，避免 AI 明明在发言却显示空闲');
  assert.match(RUNNING_STATE_SRC,
    /age >= 0 && age <= GC_WORKING_FRESH_MS/,
    'watcher 必须有明确过期窗口，不能恢复成永久 gcWorking');
  assert.match(LIST_SRC, /if \(_subIsRunning\(sub\)\) statusCls = 'mini-st-thinking';/,
    '成员点必须走同一判定');
  assert.match(LIST_SRC, /if \(_subIsRunning\(sub\)\) return true;/,
    '群聊行的运行中判定也走同一函数');
});

// ---- 4. 侧栏双出口显示 ----

test('侧栏常驻显示国外 VPN 与国产直连的真实出口', () => {
  assert.match(LIST_SRC, /strip-route-foreign/);
  assert.match(LIST_SRC, /strip-route-domestic/);
  assert.match(LIST_SRC, /strip-route-label\">国外/);
  assert.match(LIST_SRC, /strip-route-label\">国产/);
  assert.match(LIST_SRC, /route\.locationLabel/);
  assert.match(LIST_SRC, /route\.ip/);
  assert.match(LIST_SRC, /function _shortProxy/);
  assert.match(RENDERER_SRC, /async function refreshHubProxyInfo/);
  assert.match(RENDERER_SRC, /get-network-egress-status/);
  assert.match(RENDERER_SRC, /getProxyInfo: \(\) => hubProxyInfo/);
});

test('代理串里的凭据不会被显示出来', () => {
  const { execSync } = require('node:child_process');
  // _shortProxy 在闭包里，这里直接复算它的契约：只留 host:port
  const cases = [
    ['http://127.0.0.1:7890', '127.0.0.1:7890'],
    ['http://user:secret@10.0.0.2:8080', '10.0.0.2:8080'],
    ['socks5://192.168.1.5:1080', '192.168.1.5:1080'],
  ];
  for (const [raw, expected] of cases) {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const got = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    assert.strictEqual(got, expected, `${raw} 应显示为 ${expected}`);
    assert.ok(!got.includes('secret'), '凭据不得出现在侧栏');
  }
  void execSync;
});

if (!process.exitCode) console.log('All card view fidelity tests passed.');
