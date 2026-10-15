'use strict';
// 公司 CodeAgent 的模型身份（2026-10-13 用户：同事有 DeepSeek 权限，会话显示 GLM-5.2，
// 卡片里已经是 deepseek0731… 的真实模型名，输入框下方仍是 GLM；头像和侧栏图标也要按模型对应）。
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 启动构造会落模型日志和 MCP 配置，测试必须在自己的临时数据目录内。
const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-identity-'));
process.env.CLAUDE_HUB_DATA_DIR = path.join(isolatedData, 'hub');
process.on('exit', () => fs.rmSync(isolatedData, { recursive: true, force: true }));

const models = require('../core/codeagent-models');
const { normalizeCodeAgentModel } = require('../core/codeagent-config');
const { makeChatAvatarSrc, chatAvatarSrc } = require('../renderer/chat-avatar');
const { makeKindFilter } = require('../core/distribution');

const root = path.resolve(__dirname, '..');
const DS = 'deepseek0731-wx-chat';
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}

test('不认识的安全模型名原样传给 CodeAgent，不再被换成 GLM', () => {
  assert.strictEqual(normalizeCodeAgentModel(DS), DS);
  assert.strictEqual(normalizeCodeAgentModel('glm-5.2-wx-auto'), 'GLM-5.2-WX-Auto', '已知模型按名单大小写');
  assert.strictEqual(normalizeCodeAgentModel('MiniMax-M2.7'), 'MiniMax-M2.7');
  assert.strictEqual(normalizeCodeAgentModel(''), 'GLM-5.2-WX-Auto', '没选时仍是默认');
  for (const bad of ['x; rm -rf', '"GLM"', '-p', '<synthetic>', 'a'.repeat(120), 'a\nb', 'claude-opus-5', 'gpt-6-astra']) {
    assert.strictEqual(normalizeCodeAgentModel(bad), 'GLM-5.2-WX-Auto', bad);
  }
});

test('启动命令带的是会话里记的真实模型', () => {
  const { buildCodeAgentPtyLaunch } = require('../core/session-manager')._private;
  const launch = buildCodeAgentPtyLaunch('hub-1', 'codeagent', { model: DS, codeagentModelPick: true }, os.tmpdir(), {}, { command: 'codeagent', configDir: os.tmpdir() });
  assert.match(launch.cmd, new RegExp(`--model ${DS}\\b`));
  assert.doesNotMatch(launch.cmd, /GLM-5\.2/);
});

test('按模型名分家：GLM / DeepSeek / MiniMax，认不出返回空', () => {
  assert.strictEqual(models.modelFamily('GLM-5.2-WX-Auto'), 'glm');
  assert.strictEqual(models.modelFamily(DS), 'deepseek');
  assert.strictEqual(models.modelFamily('DeepSeek-V4-Pro'), 'deepseek');
  assert.strictEqual(models.modelFamily('MiniMax-M2.7'), 'minimax');
  assert.strictEqual(models.modelFamily('wx-large-0901'), '');
  assert.strictEqual(models.modelLabel('GLM-5.2-WX-Auto'), 'GLM-5.2 Auto');
  assert.strictEqual(models.modelLabel(DS), DS);
});

test('请求 GLM、实际回答是 DeepSeek：当前模型改成实际的，记下请求的并提示', () => {
  const session = { kind: 'codeagent', currentModel: { id: 'GLM-5.2-WX-Auto', displayName: 'GLM-5.2 Auto' } };
  const result = models.observeModel(session, DS);
  assert.deepStrictEqual(result.fields.currentModel, { id: DS, displayName: DS });
  assert.strictEqual(result.fields.codeagentRequestedModel, 'GLM-5.2-WX-Auto');
  assert.strictEqual(result.fields.codeagentActualModel, DS);
  assert.match(models.mismatchNotice(result.mismatch), /GLM-5\.2 Auto.*deepseek0731-wx-chat.*权限/);
  const again = models.observeModel({ ...session, ...result.fields }, DS);
  assert.strictEqual(again, null, '同一个模型再来一轮不再改、不再提示');
});

test('同一家（Auto 分流到具体模型）保留用户选的，只记实际模型', () => {
  const session = { kind: 'codeagent-resume', currentModel: { id: 'GLM-5.2-WX-Auto' } };
  const result = models.observeModel(session, 'GLM-5.2-WX');
  assert.deepStrictEqual(result.fields, { codeagentActualModel: 'GLM-5.2-WX' });
  assert.strictEqual(result.mismatch, null);
});

test('非 CodeAgent 会话、合成消息、空值都不改', () => {
  assert.strictEqual(models.observeModel({ kind: 'claude', currentModel: { id: 'claude-opus-5' } }, DS), null);
  assert.strictEqual(models.observeModel({ kind: 'codeagent', currentModel: { id: 'GLM-5.2-WX-Auto' } }, '<synthetic>'), null);
  assert.strictEqual(models.observeModel({ kind: 'codeagent' }, ''), null);
  const fresh = models.observeModel({ kind: 'codeagent' }, DS);
  assert.strictEqual(fresh.fields.currentModel.id, DS, '没记过模型时直接用实际的');
  assert.strictEqual(fresh.mismatch, null, '没请求过就不算不一致');
});

test('本机见过的模型进菜单，已知模型在前，去重、只在新名字时写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-models-'));
  try {
    assert.deepStrictEqual(models.modelOptions(dir).map(o => o.id), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7']);
    assert.strictEqual(models.recordObserved(dir, DS), true);
    assert.strictEqual(models.recordObserved(dir, DS.toUpperCase()), false, '大小写不同算同一个');
    assert.strictEqual(models.recordObserved(dir, 'GLM-5.2-WX-Auto'), true, '已知模型也记，但菜单里不重复');
    assert.strictEqual(models.recordObserved(dir, 'bad; name'), false);
    const options = models.modelOptions(dir);
    assert.deepStrictEqual(options.map(o => o.id), ['GLM-5.2-WX-Auto', 'MiniMax-M2.7', DS]);
    assert.strictEqual(options[2].source, 'observed');
    fs.writeFileSync(path.join(dir, models.OBSERVED_FILE), '{broken');
    assert.strictEqual(models.modelOptions(dir).length, 2, '文件坏了只回到已知模型');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('卡片头像按这条回答的模型：GLM / DeepSeek / MiniMax 各用各的，公司纯净版也一样', () => {
  const art = name => `assets/ai-avatars/cel-v2/${name}.png`;
  for (const avatar of [chatAvatarSrc, makeChatAvatarSrc(makeKindFilter(['codeagent']))]) {
    assert.strictEqual(avatar('codeagent', { model: DS }), art('deepseek'));
    assert.strictEqual(avatar('codeagent-resume', { model: 'MiniMax-M2.7' }), art('minimax'));
    assert.strictEqual(avatar('codeagent', { model: 'GLM-5.2-WX-Auto' }), art('glm'));
    assert.strictEqual(avatar('codeagent', { model: 'wx-large-0901' }), art('glm'), '认不出的模型沿用 CodeAgent 默认画像');
    assert.strictEqual(avatar('codeagent'), art('glm'));
  }
  for (const name of ['glm', 'deepseek', 'minimax']) assert(fs.existsSync(path.join(root, 'renderer', art(name))), name);
  assert.strictEqual(chatAvatarSrc('claude', { model: DS }), art('claude'), '只有 CodeAgent 按模型换画像');
});

test('公司版发行包保留三张 CodeAgent 画像；MiniMax 原图有来源记录且未被改动', () => {
  const target = JSON.parse(fs.readFileSync(path.join(root, 'community/targets/company/target.json'), 'utf8'));
  for (const name of ['glm', 'deepseek', 'minimax']) {
    assert(!target.drop.includes(`renderer/assets/ai-avatars/cel-v2/${name}.png`), name);
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'renderer/assets/20261013-codeagent-model-artwork.json'), 'utf8'));
  for (const asset of provenance) {
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset.file))).digest('hex'), asset.sha256, asset.file);
  }
});

test('输入框模型图标：MiniMax 有自己的图标，公司 GLM 仍用 CodeAgent 图标，DeepSeek 用 DeepSeek', () => {
  const { modelClass } = require('../renderer/model-ui');
  assert.strictEqual(modelClass('MiniMax-M2.7'), 'minimax');
  assert.strictEqual(modelClass('GLM-5.2-WX-Auto'), 'codeagent');
  assert.strictEqual(modelClass(DS), 'deepseek');
  const composer = fs.readFileSync(path.join(root, 'renderer/styles/composer.css'), 'utf8');
  const sidebar = fs.readFileSync(path.join(root, 'renderer/styles/card-view.css'), 'utf8');
  assert.match(composer, /\.composer-model-logo\.minimax\s*\{[^}]*minimax\.svg/);
  assert.match(sidebar, /\.logo-minimax\s*\{[^}]*minimax\.svg/);
  assert(fs.existsSync(path.join(root, 'renderer/assets/ai-logos/minimax.svg')));
});

test('侧栏图标按会话当前模型：DeepSeek / MiniMax / GLM，提示里仍写 CodeAgent', () => {
  const { createSessionListRenderer } = require('../renderer/session-list-renderer');
  const { isAiKind } = require('../core/ai-kinds');
  const el = () => ({ children: [], style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
    setAttribute() {}, addEventListener() {}, appendChild(c) { this.children.push(c); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    set innerHTML(v) { this._html = v; this.children = []; }, get innerHTML() { return this._html || ''; } });
  const render = model => {
    const list = el();
    const now = Date.now();
    const sessions = new Map([['s', { id: 's', title: 'CodeAgent 1', kind: 'codeagent', status: 'idle', createdAt: now, lastMessageTime: now, unreadCount: 0,
      currentModel: { id: model, displayName: models.modelLabel(model) } }]]);
    createSessionListRenderer({ document: { createElement: el, getElementById: () => null, head: el(), documentElement: el() },
      localStorage: { getItem: () => '[]', setItem() {} }, sessionListEl: list, getSessions: () => sessions, getMeetings: () => ({}),
      getActiveSessionId: () => null, getActiveMeetingId: () => null, isAiKind, modelShort: m => m.displayName, modelClass: () => '',
      escapeHtml: s => String(s), formatTime: () => '09:30', pctClass: () => 'ok', sessionBurnRate: () => null,
      selectSession() {}, selectMeeting() {}, openContextMenu() {} }).renderSessionList();
    return list.children.map(c => c.innerHTML).join('\n');
  };
  assert.match(render(DS), /logo-deepseek"/);
  assert.match(render(DS), /title="CodeAgent · deepseek0731-wx-chat/);
  assert.match(render('MiniMax-M2.7'), /logo-minimax"/);
  assert.match(render('GLM-5.2-WX-Auto'), /logo-codeagent"/);
});

if (failed) { console.error(`\n${failed} 个用例失败`); process.exit(1); }
console.log('\nunit-codeagent-model-identity: all passed');
