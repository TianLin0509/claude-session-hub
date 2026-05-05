'use strict';
// 单元测试 core/roundtable-scenes.js — 场景注册表 + prompt 拼装
// 2026-05-04 prompt 重构 (P0-P5):
//   P0 L1 BASE_RULES 瘦身 (~700→~260 字)
//   P1 L2 research 三层分型 (PRESET 瘦身 + COVENANT_RESEARCH 重写为 4 块差量)
//   P2 删除 RESUME_REMINDERS / getResumeReminder (死代码)
//   P3 GENERAL_PRESET 补强 (~50→~210 字, 4 协作策略 + 1 段场景定位)
//   P4 五元组格式 SSoT (BRIEF_SUMMARY_FIELDS schema + render helpers)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scenes = require('../core/roundtable-scenes');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'scenes-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// === L1 BASE_RULES：极简，只承载核心规则 ===
function testL1BaseRulesIsMinimal() {
  const r = scenes.BASE_RULES;
  // 必须含的核心要素
  assert.ok(r.includes('圆桌讨论'), 'BASE_RULES should contain "圆桌讨论"');
  assert.ok(r.includes('调度上下文'), 'BASE_RULES should preview "调度上下文"');
  assert.ok(r.includes('timeline.md'), 'BASE_RULES should mention timeline.md');
  assert.ok(r.includes('房间公约'), 'BASE_RULES should reference 房间公约');
  // v2 白名单优化 (2026-05-04): "AI 禁止主动调用" 段必须存在
  assert.ok(r.includes('AI 禁止主动调用'),
    'BASE_RULES 必须含"AI 禁止主动调用"段 (v2 白名单优化区分 AI 主动 vs 用户主动)');
  // 三个原则的关键词
  assert.ok(r.includes('引用明示'), 'BASE_RULES should include "引用明示" principle');
  assert.ok(r.includes('分歧不抹平'), 'BASE_RULES should include "分歧不抹平" principle');
  assert.ok(r.includes('不知说不知'), 'BASE_RULES should include "不知说不知" principle');
  // L2 详细约定不应在 L1 展开
  const fiveSlots = ['目标', '关键事实', '关键分歧', '当前结论', '下一步'];
  const slotsInL1 = fiveSlots.filter(s => r.includes(s)).length;
  assert.ok(slotsInL1 < 3,
    `BASE_RULES should NOT expand 五元组 definition (found ${slotsInL1} slot keywords; L2 territory)`);
  // P0 决议: 投研专项禁令下沉到 RESEARCH_PRESET (防反弹)
  assert.ok(!r.includes('LinDangAgent'), 'BASE_RULES MUST NOT mention LinDangAgent');
  assert.ok(!r.includes('A 股'), 'BASE_RULES MUST NOT mention A 股');
  assert.ok(!r.includes('投研'), 'BASE_RULES MUST NOT mention 投研');
  assert.ok(!r.includes('cli.py'), 'BASE_RULES MUST NOT mention cli.py (P0 投研禁令下沉)');
  assert.ok(!r.includes('Stock_top10'), 'BASE_RULES MUST NOT mention Stock_top10');
  assert.ok(!r.includes('fetch_lindang'), 'BASE_RULES MUST NOT mention fetch_lindang');
  // P0 决议: 删调度模式枚举 (L3 调度上下文已实时输出)
  assert.ok(!r.includes('fanout / debate / summary'), 'BASE_RULES MUST NOT enumerate fanout/debate/summary (L3 territory)');
  assert.ok(!r.includes('all 群策群力'), 'BASE_RULES MUST NOT enumerate dispatch modes');
  // 不能硬编码 "共三家" / "另外两位 AI 同事"
  assert.ok(!/共三家|另外两位\s*AI\s*同事/.test(r), 'BASE_RULES MUST NOT hardcode 共三家');
  // 篇幅约束
  assert.ok(r.length < 1500, `BASE_RULES too long: ${r.length} chars (P0 瘦身后应 ~600 字符)`);
  console.log('  ✓ testL1BaseRulesIsMinimal');
}

// === v2 白名单优化 (2026-05-04 道雪): BASE_RULES 必须区分 AI 主动 vs 用户主动 ===
//   配合 session-manager.js 删除 --disable-slash-commands (用户基本操作不再被误杀),
//   BASE_RULES 必须用软约束兜住 settings 兜不到的盲区:
//   - 用户自定义 skill (cli-caller/init/loop/schedule/design-review,~/.claude/skills/)
//     不属于任何 plugin,enabledPlugins 完全禁不掉
//   - 危险斜杠命令 /agents /init /clear 解锁后 AI 主动调会违反 CLAUDE.md 铁律
//   - memory 写入要明示在白名单内 (区分项目文件 vs memory 文件)
function testL1BaseRulesAiVsUserAccessV2() {
  const r = scenes.BASE_RULES;

  // 必须列出用户自定义 skill 名单 (settings 兜不到,只能软约束)
  const customSkills = ['cli-caller', 'init', 'loop', 'schedule', 'design-review'];
  for (const sk of customSkills) {
    assert.ok(r.includes(sk),
      `BASE_RULES "AI 禁止主动调用"段必须列出用户自定义 skill "${sk}" ` +
      `(它不属于任何 plugin,enabledPlugins 兜不到)`);
  }

  // 必须列出危险斜杠命令的 AI 主动调用禁令
  assert.ok(/\/agents|派 sub-agent/.test(r),
    'BASE_RULES 必须禁 AI 主动调 /agents (派 sub-agent 违反铁律)');
  assert.ok(/\/init|写 CLAUDE\.md/.test(r),
    'BASE_RULES 必须禁 AI 主动调 /init (写 CLAUDE.md 违反"圆桌不写文件"铁律)');
  assert.ok(/\/clear|清历史|断 timeline/.test(r),
    'BASE_RULES 必须禁 AI 主动调 /clear (清历史会断 timeline.md 一致性)');

  // 必须区分"项目文件"vs"memory 文件" (放开 memory 写入白名单)
  assert.ok(r.includes('项目文件'),
    'BASE_RULES 必须明示"Edit/Write **项目文件**" (区分代码文件 vs memory 文件)');

  // 必须有 memory 写入白名单
  assert.ok(/Auto-memory|memory 写入|memory 目录/.test(r),
    'BASE_RULES "允许"段必须含 Auto-memory 写入白名单 (让每 AI 积累记忆)');

  // 必须明示用户主动放行
  assert.ok(/用户主动放行|用户.*斜杠命令|\/model.*\/compact/.test(r),
    'BASE_RULES 必须明示用户主动调 /model /compact 等斜杠命令放行 (不被禁令误杀)');

  // 反向断言: 不允许出现旧版"Edit / Write 文件"裸字串 (歧义)
  assert.ok(!/Edit\s*\/\s*Write\s*文件[；;]/.test(r),
    'v2 决议: 不允许"Edit / Write 文件;"裸字串 (与 memory 文件冲突,必须改为"项目文件")');

  console.log('  ✓ testL1BaseRulesAiVsUserAccessV2');
}

// === L2 COVENANT_GENERAL：详细协作手册 + 五元组 SSoT ===
function testL2CovenantGeneralExported() {
  assert.strictEqual(typeof scenes.COVENANT_GENERAL, 'string', 'COVENANT_GENERAL should be exported as string');
  const c = scenes.COVENANT_GENERAL;
  assert.ok(c.length > 500, `COVENANT_GENERAL should be substantive (got ${c.length} chars)`);
  // 必须涵盖的详细约定
  assert.ok(c.includes('timeline.md'), 'COVENANT_GENERAL should cover timeline.md usage');
  assert.ok(c.includes('摘要按钮'), 'COVENANT_GENERAL should cover 摘要按钮');
  assert.ok(c.includes('五元组'), 'COVENANT_GENERAL should cover 五元组');
  assert.ok(c.includes('dispatchMode'), 'COVENANT_GENERAL should cover dispatchMode 切换');
  assert.ok(c.includes('协作礼仪'), 'COVENANT_GENERAL should cover 协作礼仪');
  // 五元组五段必须齐
  assert.ok(c.includes('目标') && c.includes('关键事实') && c.includes('关键分歧')
            && c.includes('当前结论') && c.includes('下一步'),
    'COVENANT_GENERAL should list all 5 quintuple slots');
  // P4 SSoT: 五元组段必须用 renderFiveElementItems 渲染 (与 buildBriefSummaryPrompt 共用)
  assert.ok(c.includes(scenes.renderFiveElementItems()),
    'COVENANT_GENERAL must contain renderFiveElementItems() output (P4 SSoT)');
  console.log('  ✓ testL2CovenantGeneralExported');
}

// === SCENE_REGISTRY 结构 ===
function testRegistryStructure() {
  const keys = scenes.getSceneKeys();
  // dev 场景 (plan-dev-scenario.md) 加入后,SCENE_REGISTRY 包含三个 key
  assert.deepStrictEqual(keys.sort(), ['dev', 'general', 'research']);

  const requiredFields = ['name', 'icon', 'preset', 'defaultCovenant', 'mcpConfig',
                          'summaryHints', 'summaryTitleTag', 'dataPackEnabled'];
  for (const k of keys) {
    const s = scenes.getScene(k);
    assert.ok(s !== null, `scene ${k} should exist`);
    for (const f of requiredFields) {
      assert.ok(f in s, `scene ${k} should have field ${f}`);
    }
    assert.strictEqual(typeof s.name, 'string');
    assert.strictEqual(typeof s.icon, 'string');
    assert.strictEqual(typeof s.preset, 'string');
    assert.strictEqual(typeof s.defaultCovenant, 'string');
    assert.strictEqual(typeof s.summaryHints, 'string');
    assert.strictEqual(typeof s.summaryTitleTag, 'boolean');
    assert.strictEqual(typeof s.dataPackEnabled, 'boolean');
  }
  console.log('  ✓ testRegistryStructure');
}

// === P1: research preset 瘦身后仍含核心 (LinDangAgent + 旧入口禁令) ===
function testResearchPresetCore() {
  const s = scenes.getScene('research');
  assert.ok(s.preset.includes('LinDangAgent'), 'research preset should still mention LinDangAgent');
  // 旧入口禁令必须保留 (操作禁令每轮必读)
  assert.ok(s.preset.includes('cli.py analyze'), 'research preset should keep cli.py 旧入口禁令');
  assert.ok(s.preset.includes('Stock_top10'), 'research preset should keep Stock_top10 禁令');
  assert.ok(s.preset.includes('fetch_for_arena'), 'research preset should keep fetch_for_arena 禁令');
  // P1 决议: "纯读不写" 已删除 (与 L1 BASE_RULES "禁 Edit/Write 文件" 重复)
  assert.ok(!s.preset.includes('纯读不写'), 'P1 decision: "纯读不写" removed (overlap with L1)');
  // P1 决议: "圆桌产物是观点不是研报" 已迁出到 COVENANT_RESEARCH
  assert.ok(!s.preset.includes('圆桌产物是观点'), 'P1 decision: "圆桌产物是观点" moved to COVENANT_RESEARCH');
  console.log('  ✓ testResearchPresetCore');
}

// === Bash escape 修复 (2026-05-04 道雪): RESEARCH_PRESET 路径样板必须避坑 ===
//   血泪案例: 旧版样板 `python C:\LinDangAgent\data_query.py snapshot 688008` 经 bash
//     解析后 `\L` `\d` 当 escape,反斜杠被吞,变成 `python C:LinDangAgentdata_query.py`,
//     python 当相对路径加 cwd 报 No such file or directory。
//   契约: 入口样板必须用 `cd C:/LinDangAgent && python data_query.py` 模式
//     (正斜杠 + cd 后相对路径,与 AGENT_GUIDE 一致),且必须含 ⚠ Bash 路径警告段。
function testResearchPresetBashEscapeSafe() {
  const s = scenes.getScene('research');
  // 反向断言: 不允许"python <反斜杠绝对路径>"裸样板出现 (诱导源)
  // 唯一允许的反斜杠 token 是禁令短语 (例如 "严禁裸反斜杠"),不允许完整命令样板
  assert.ok(!/python\s+C:\\LinDangAgent\\data_query\.py/.test(s.preset),
    'RESEARCH_PRESET MUST NOT contain `python C:\\\\LinDangAgent\\\\data_query.py` 裸样板 ' +
    '(诱导源: AI 会照抄 → bash 吃反斜杠 → No such file)');
  assert.ok(!/python\s+C:\\LinDangAgent\\\.\.\./.test(s.preset),
    'RESEARCH_PRESET MUST NOT contain 完整反例命令字串 (即使在警告段) ' +
    '— 按 feedback_prompt_no_negation_demo 铁律,删诱导源,不靠"⚠ 不要 X"+反例字符纠正');
  // 正向断言: 必须有 cd 模式样板 (与 AGENT_GUIDE 一致)
  assert.ok(/cd\s+C:\/LinDangAgent\s*&&\s*python\s+data_query\.py/.test(s.preset),
    'RESEARCH_PRESET 必须含 `cd C:/LinDangAgent && python data_query.py` 样板 (avoids bash escape)');
  // 必须有规则/警告段教育 AI (机制说明,不展示反例)
  assert.ok(s.preset.includes('Bash 路径规则') || s.preset.includes('Bash 路径警告'),
    'RESEARCH_PRESET 必须含 ⚠ Bash 路径规则段 (机制说明,不展示反例)');
  // 必须明示 escape 机制
  assert.ok(/escape|当 escape|escape 序列/.test(s.preset),
    'Bash 路径规则必须明示反斜杠被当 escape 序列处理');
  // 必须给替代正例
  assert.ok(s.preset.includes('C:/LinDangAgent/data_query.py') || /python\s+C:\/LinDangAgent\/data_query\.py/.test(s.preset),
    'Bash 路径规则必须给"正斜杠版"正例 python C:/LinDangAgent/data_query.py');
  // AGENT_GUIDE 引用也用正斜杠
  assert.ok(s.preset.includes('C:/LinDangAgent/data/AGENT_GUIDE.md'),
    'AGENT_GUIDE 引用应用正斜杠版 C:/LinDangAgent/data/AGENT_GUIDE.md');
  // 禁令段明示禁裸反斜杠 Bash 调用 (短语,不附完整反例)
  assert.ok(/严禁.*反斜杠|裸反斜杠/.test(s.preset),
    'RESEARCH_PRESET 操作禁令必须明示 ❌ 裸反斜杠 Windows 路径调 Bash');
  console.log('  ✓ testResearchPresetBashEscapeSafe');
}

// === P3: GENERAL_PRESET 补强 (4 协作策略 + 1 场景定位) ===
function testGeneralPresetEnhanced() {
  const s = scenes.getScene('general');
  // 必须含 4 条协作策略关键词
  assert.ok(s.preset.includes('协作策略'), 'GENERAL_PRESET should have "协作策略" section');
  assert.ok(s.preset.includes('上下文已够'), 'GENERAL_PRESET should have 上下文已够 strategy');
  assert.ok(s.preset.includes('涉及代码/文件/事实'), 'GENERAL_PRESET should have 事实核实 strategy');
  assert.ok(s.preset.includes('依赖项目细节'), 'GENERAL_PRESET should have 项目细节 strategy');
  assert.ok(s.preset.includes('问题有多解'), 'GENERAL_PRESET should have 多解澄清 strategy');
  // 场景定位
  assert.ok(s.preset.includes('场景定位'), 'GENERAL_PRESET should have "场景定位" section');
  assert.ok(s.preset.includes('可讨论的判断'), 'GENERAL_PRESET should clarify output is judgment');
  // P3 准入闸门: 不含场景特定知识 / 模式教学
  assert.ok(!s.preset.includes('LinDangAgent'), 'GENERAL_PRESET MUST NOT contain research-specific terms');
  assert.ok(!/fanout|debate|summary|@pikachu/i.test(s.preset),
    'GENERAL_PRESET MUST NOT contain mode/dispatch teaching');
  console.log('  ✓ testGeneralPresetEnhanced');
}

// === general scene defaultCovenant = COVENANT_GENERAL ===
function testGeneralDefaultCovenantIsCovenantGeneral() {
  const s = scenes.getScene('general');
  assert.strictEqual(s.defaultCovenant, scenes.COVENANT_GENERAL,
    'general scene defaultCovenant should be COVENANT_GENERAL');
  assert.ok(!s.preset.includes('LinDangAgent'), 'general preset MUST NOT mention LinDangAgent');
  console.log('  ✓ testGeneralDefaultCovenantIsCovenantGeneral');
}

// === research scene defaultCovenant = COVENANT_GENERAL + separator + COVENANT_RESEARCH ===
function testResearchDefaultCovenantIsCombined() {
  const s = scenes.getScene('research');
  assert.ok(s.defaultCovenant.startsWith('# 房间公约 · 圆桌协作手册'),
    'research defaultCovenant should start with COVENANT_GENERAL');
  assert.ok(s.defaultCovenant.includes('# 投研圆桌 · 研究纪律'),
    'research defaultCovenant should include new COVENANT_RESEARCH (P1 重写)');
  assert.ok(s.defaultCovenant.includes('\n\n---\n\n'),
    'research defaultCovenant should have separator between general and research');
  console.log('  ✓ testResearchDefaultCovenantIsCombined');
}

// === P0 24 轮共享核心版: COVENANT_RESEARCH 必须含 24 轮收敛核心机制 ===
function testCovenantResearch24Round() {
  const c = scenes.COVENANT_RESEARCH;
  // 元规则 (24 轮元规则,凌驾所有具体规则)
  assert.ok(c.includes('元规则'), 'COVENANT_RESEARCH should declare 元规则');
  assert.ok(c.includes('此刻买/不买/等一等'),
    'COVENANT_RESEARCH 元规则必须保留"此刻买/不买/等一等"决策增量原则');
  // 系统身份与目标 + GPT 金句
  assert.ok(c.includes('该盯什么') && c.includes('该怕什么'),
    'COVENANT_RESEARCH should keep GPT 金句"该盯什么/该怕什么"');
  // 5 派定锚原则
  assert.ok(c.includes('基本面定锚') && c.includes('资金面定节奏'),
    'COVENANT_RESEARCH should keep 5-anchor 核心原则');
  // 反问轮 (24 轮新增机制)
  assert.ok(c.includes('反问轮'), 'COVENANT_RESEARCH should describe 反问轮');
  assert.ok(c.includes('直接分析'), 'COVENANT_RESEARCH 反问轮必须留 skip 路径');
  // 主分析轮 5 段
  assert.ok(c.includes('局型识别'), 'COVENANT_RESEARCH should require 局型识别');
  assert.ok(c.includes('主矛盾'), 'COVENANT_RESEARCH should require 主矛盾');
  assert.ok(c.includes('关键假设'), 'COVENANT_RESEARCH should require 关键假设 (限 2 条)');
  assert.ok(c.includes('多空对抗'), 'COVENANT_RESEARCH should require 多空对抗');
  assert.ok(c.includes('收束 3 句'), 'COVENANT_RESEARCH should require 收束 3 句');
  // "此刻"硬约束 (24 轮收敛: 替代旧版"建议关注/可跟踪"模糊收口)
  assert.ok(c.includes('"此刻"硬约束') || c.includes('此刻硬约束'),
    'COVENANT_RESEARCH 必须含"此刻"硬约束');
  assert.ok(c.includes('催化时间窗口') && c.includes('资金信号'),
    'COVENANT_RESEARCH "此刻"硬约束必须列出 价格位置/催化窗口/资金信号 三选一');
  // 4 档结论 (24 轮替代旧版"推荐/不推荐/中性/观望")
  assert.ok(c.includes('强烈推荐') && c.includes('可买需条件')
            && c.includes('不建议买') && c.includes('强烈回避'),
    'COVENANT_RESEARCH 必须列出 4 档结论 (强烈推荐/可买需条件/不建议买/强烈回避)');
  assert.ok(c.includes('建议关注') === false || /禁止.*建议关注/.test(c),
    'COVENANT_RESEARCH 必须明示禁止"建议关注/可跟踪"模糊收口');
  // 红线 3 条 (从旧版打捞)
  assert.ok(c.includes('红线'), 'COVENANT_RESEARCH should keep 红线');
  assert.ok(c.includes('蹭概念'), 'COVENANT_RESEARCH should mention 蹭概念 red line');
  assert.ok(c.includes('破关键支撑'), 'COVENANT_RESEARCH should mention 破支撑 red line');
  assert.ok(c.includes('财务造假'), 'COVENANT_RESEARCH should mention 财务造假 red line');
  // 共用铁律 (24 轮收敛 8 条)
  assert.ok(c.includes('数据先于观点'), 'COVENANT_RESEARCH 铁律 1: 数据先于观点');
  assert.ok(c.includes('多空同列'), 'COVENANT_RESEARCH 铁律 2: 多空同列');
  assert.ok(c.includes('数字精确反推'), 'COVENANT_RESEARCH 铁律: 禁止数字精确反推 (LLM 幻觉防护)');
  assert.ok(c.includes('史实类比'), 'COVENANT_RESEARCH 铁律: 禁止史实类比 (LLM 幻觉防护)');
  // 用户画像指针 (B 路线: 外置)
  assert.ok(c.includes('research-profile.md'), 'COVENANT_RESEARCH should reference external profile');
  // 准入: 不重复 GENERAL/L1
  assert.ok(!c.includes('timeline.md 路径'), 'COVENANT_RESEARCH MUST NOT duplicate timeline 机制');
  assert.ok(!c.includes('## 五元组格式'), 'COVENANT_RESEARCH MUST NOT duplicate 五元组 definition');
  // 准入: 不含具体工具/命令 (应在 PRESET)
  assert.ok(!c.includes('fetch_lindang'), 'COVENANT_RESEARCH MUST NOT contain MCP tool names (PRESET territory)');
  assert.ok(!c.includes('cli.py'), 'COVENANT_RESEARCH MUST NOT contain CLI commands (PRESET territory)');
  // 准入: 不直接写用户偏好数字 (应在 profile)
  assert.ok(!/15%|35%|30%|20%/.test(c), 'COVENANT_RESEARCH MUST NOT contain weight numbers (profile territory)');
  // P0 决议: 旧版"推荐/不推荐/中性/观望" 4 档已被 24 轮版替代
  assert.ok(!/推荐\s*\/\s*不推荐\s*\/\s*中性\s*\/\s*观望/.test(c),
    'COVENANT_RESEARCH MUST NOT keep 旧版"推荐/不推荐/中性/观望" (已被 4 档替代)');
  console.log('  ✓ testCovenantResearch24Round');
}

// === P2 L3 偏置层: RESEARCH_SLOT_BIASES 必须存在,三派关键词正确 ===
function testResearchSlotBiasesExist() {
  assert.strictEqual(typeof scenes.RESEARCH_SLOT_BIASES, 'object',
    'RESEARCH_SLOT_BIASES should be exported as object');
  const biases = scenes.RESEARCH_SLOT_BIASES;
  // 三派 key 完整
  assert.ok(biases.pikachu && biases.charmander && biases.squirtle,
    'RESEARCH_SLOT_BIASES must contain pikachu/charmander/squirtle keys');
  // 每派关键认知功能词必须正确归位
  assert.ok(biases.pikachu.includes('对抗硬度'),
    'Pikachu 偏置必须明示"对抗硬度派"定位');
  assert.ok(biases.pikachu.includes('信息密度自检'),
    'Pikachu 偏置必须含信息密度自检机制');
  assert.ok(biases.pikachu.includes('主轮留白'),
    'Pikachu 偏置必须含主轮留白原则 (反同质化核心)');

  assert.ok(biases.charmander.includes('反直觉校验'),
    'Charmander 偏置必须明示"反直觉校验派"定位');
  assert.ok(biases.charmander.includes('生命周期'),
    'Charmander 偏置必须含机会生命周期标注');
  assert.ok(biases.charmander.includes('阶段 1') && biases.charmander.includes('阶段 4'),
    'Charmander 生命周期必须列出 4 个阶段');

  assert.ok(biases.squirtle.includes('极简克制'),
    'Squirtle 偏置必须明示"极简克制派"定位');
  assert.ok(biases.squirtle.includes('默认压缩'),
    'Squirtle 偏置必须含默认压缩机制');
  assert.ok(biases.squirtle.includes('行动闭环'),
    'Squirtle 偏置必须含行动闭环优先');

  // 偏置层长度上限 (防膨胀回流共享核心)
  for (const [slot, bias] of Object.entries(biases)) {
    assert.ok(bias.length < 1500,
      `${slot} 偏置过长 (${bias.length} 字符,上限 1500 防止膨胀)`);
    assert.ok(bias.length > 200,
      `${slot} 偏置过短 (${bias.length} 字符,可能没注入有效内容)`);
  }
  console.log('  ✓ testResearchSlotBiasesExist');
}

// === P4: 五元组 SSoT schema ===
function testFiveElementSchema() {
  // schema 数组导出
  assert.ok(Array.isArray(scenes.BRIEF_SUMMARY_FIELDS), 'BRIEF_SUMMARY_FIELDS should be exported array');
  assert.strictEqual(scenes.BRIEF_SUMMARY_FIELDS.length, 5, '五元组恰好 5 字段');
  // 字段标题稳定
  const titles = scenes.BRIEF_SUMMARY_FIELDS.map(([n]) => n);
  assert.deepStrictEqual(titles, ['目标', '关键事实', '关键分歧', '当前结论', '下一步'], '五字段标题稳定');
  // 约束 4 条独立
  assert.ok(Array.isArray(scenes.BRIEF_SUMMARY_CONSTRAINTS), 'BRIEF_SUMMARY_CONSTRAINTS should be exported array');
  assert.strictEqual(scenes.BRIEF_SUMMARY_CONSTRAINTS.length, 4, '约束恰好 4 条独立');
  assert.ok(scenes.BRIEF_SUMMARY_CONSTRAINTS.includes('不展开论证'), 'should contain 不展开论证');
  assert.ok(scenes.BRIEF_SUMMARY_CONSTRAINTS.includes('不重复事实细节'), 'should contain 不重复事实细节');
  // render helpers
  assert.strictEqual(typeof scenes.renderFiveElementItems, 'function', 'renderFiveElementItems should be function');
  assert.strictEqual(typeof scenes.renderBriefSummaryConstraints, 'function', 'renderBriefSummaryConstraints should be function');
  // render output 结构
  const items = scenes.renderFiveElementItems();
  assert.ok(items.includes('1. **目标**'), 'render: index 1 = 目标');
  assert.ok(items.includes('5. **下一步**'), 'render: index 5 = 下一步');
  // 约束渲染 inline / list 风格
  const inline = scenes.renderBriefSummaryConstraints('inline');
  assert.ok(inline.startsWith('约束:'), 'inline style starts with 约束:');
  assert.ok(inline.includes('，'), 'inline style uses 顿号');
  const list = scenes.renderBriefSummaryConstraints('list');
  assert.ok(list.startsWith('- 不超过 500 字'), 'list style uses - prefix');
  // SSoT: COVENANT_GENERAL 必须包含 render 输出 (与 buildBriefSummaryPrompt 共用)
  assert.ok(scenes.COVENANT_GENERAL.includes(items),
    'COVENANT_GENERAL must use renderFiveElementItems() output (P4 SSoT)');
  console.log('  ✓ testFiveElementSchema');
}

// === P2: RESUME_REMINDERS / getResumeReminder 已删除 ===
function testResumeRemindersDeleted() {
  // P2 决议: 死代码删除 (main.js 调用次数 = 0)
  assert.strictEqual(scenes.getResumeReminder, undefined,
    'P2: getResumeReminder must be removed (was dead code, never called by main.js)');
  assert.strictEqual(scenes.RESUME_REMINDERS, undefined,
    'P2: RESUME_REMINDERS constant should not be exported');
  console.log('  ✓ testResumeRemindersDeleted');
}

// === buildSystemPrompt：用户传非空 covenant 覆盖 default ===
function testBuildSystemPromptUserOverride() {
  const customPrompt = scenes.buildSystemPrompt('general', '## 我的偏好\n简洁回答');
  assert.ok(customPrompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(customPrompt.includes('我的偏好'), 'should contain user covenant');
  assert.ok(!customPrompt.includes('## 关于 timeline.md'),
    'user override should NOT include default COVENANT_GENERAL');
  assert.ok(customPrompt.includes('---'), 'non-empty covenant: separator present');
  console.log('  ✓ testBuildSystemPromptUserOverride');
}

// === buildSystemPrompt：null covenant 回退到 scene.defaultCovenant ===
function testBuildSystemPromptNullFallbackGeneral() {
  const prompt = scenes.buildSystemPrompt('general', null);
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'general null covenant should fall back to COVENANT_GENERAL');
  assert.ok(prompt.includes('---'), 'general null covenant: separator present');
  console.log('  ✓ testBuildSystemPromptNullFallbackGeneral');
}

function testBuildSystemPromptNullFallbackResearch() {
  const prompt = scenes.buildSystemPrompt('research', null);
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('LinDangAgent'), 'research preset present');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'should include COVENANT_GENERAL');
  assert.ok(prompt.includes('# 投研圆桌 · 研究纪律'), 'should include new COVENANT_RESEARCH');
  assert.ok(prompt.includes('---'), 'separator present');
  console.log('  ✓ testBuildSystemPromptNullFallbackResearch');
}

// === buildSystemPrompt：空字符串 covenant → 不回退 ===
function testBuildSystemPromptEmptyStringNoSeparator() {
  const promptEmpty = scenes.buildSystemPrompt('general', '');
  assert.ok(promptEmpty.includes('## 关于 timeline.md'),
    'empty string covenant currently fallback to defaultCovenant');
  console.log('  ✓ testBuildSystemPromptEmptyStringNoSeparator (records current behavior)');
}

// === P2 buildSystemPrompt: research + slotId='pikachu' → 含 Pikachu 偏置不含 Squirtle/Charmander ===
function testBuildSystemPromptResearchSlotInjection() {
  const prompt = scenes.buildSystemPrompt('research', null, 'pikachu');
  // 共享核心 + L3 偏置都在
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('LinDangAgent'), 'should contain RESEARCH_PRESET');
  assert.ok(prompt.includes('# 投研圆桌 · 研究纪律'), 'should contain COVENANT_RESEARCH (24 轮版)');
  // Pikachu 偏置注入
  assert.ok(prompt.includes('[Pikachu 偏置]'), 'research+pikachu should inject Pikachu bias');
  assert.ok(prompt.includes('对抗硬度'), 'pikachu bias header should appear');
  assert.ok(prompt.includes('主轮留白'), 'pikachu-specific 主轮留白 mechanism should appear');
  // 其他两派偏置不应注入
  assert.ok(!prompt.includes('[Squirtle 偏置]'), 'pikachu slot MUST NOT leak Squirtle bias');
  assert.ok(!prompt.includes('[Charmander 偏置]'), 'pikachu slot MUST NOT leak Charmander bias');
  assert.ok(!prompt.includes('生命周期'), 'pikachu slot MUST NOT contain Charmander 生命周期 mechanism');
  console.log('  ✓ testBuildSystemPromptResearchSlotInjection');
}

// === P2 buildSystemPrompt: research + slotId='charmander' → 含 Charmander 偏置 ===
function testBuildSystemPromptCharmanderInjection() {
  const prompt = scenes.buildSystemPrompt('research', null, 'charmander');
  assert.ok(prompt.includes('[Charmander 偏置]'), 'research+charmander should inject Charmander bias');
  assert.ok(prompt.includes('反直觉校验'), 'charmander-specific 反直觉校验 mechanism should appear');
  assert.ok(prompt.includes('阶段 1') && prompt.includes('阶段 4'),
    'charmander 4 阶段生命周期 should appear');
  assert.ok(!prompt.includes('[Pikachu 偏置]'), 'charmander slot MUST NOT leak Pikachu bias');
  assert.ok(!prompt.includes('[Squirtle 偏置]'), 'charmander slot MUST NOT leak Squirtle bias');
  console.log('  ✓ testBuildSystemPromptCharmanderInjection');
}

// === P2 buildSystemPrompt: research + slotId='squirtle' → 含 Squirtle 偏置 ===
function testBuildSystemPromptSquirtleInjection() {
  const prompt = scenes.buildSystemPrompt('research', null, 'squirtle');
  assert.ok(prompt.includes('[Squirtle 偏置]'), 'research+squirtle should inject Squirtle bias');
  assert.ok(prompt.includes('极简克制'), 'squirtle-specific 极简克制 mechanism should appear');
  assert.ok(prompt.includes('默认压缩'), 'squirtle 默认压缩 mechanism should appear');
  assert.ok(!prompt.includes('[Pikachu 偏置]'), 'squirtle slot MUST NOT leak Pikachu bias');
  assert.ok(!prompt.includes('[Charmander 偏置]'), 'squirtle slot MUST NOT leak Charmander bias');
  console.log('  ✓ testBuildSystemPromptSquirtleInjection');
}

// === P2 buildSystemPrompt: general + slotId='pikachu' → 不注入任何 L3 偏置 (non-research 限定) ===
function testBuildSystemPromptGeneralNoSlotInjection() {
  const prompt = scenes.buildSystemPrompt('general', null, 'pikachu');
  // 共享核心存在
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'should contain COVENANT_GENERAL');
  // L3 偏置绝不应在 non-research 场景注入 (P2 设计契约)
  assert.ok(!prompt.includes('[Pikachu 偏置]'),
    'general scene MUST NOT inject Pikachu bias even with valid slotId');
  assert.ok(!prompt.includes('[Squirtle 偏置]'),
    'general scene MUST NOT inject any L3 bias');
  assert.ok(!prompt.includes('[Charmander 偏置]'),
    'general scene MUST NOT inject any L3 bias');
  console.log('  ✓ testBuildSystemPromptGeneralNoSlotInjection');
}

// === P2 buildSystemPrompt: research + slotId 缺省 → 不注入 L3 (向后兼容) ===
function testBuildSystemPromptResearchNoSlotBackwardCompat() {
  // 三参数老调用 (slotId=undefined)
  const prompt1 = scenes.buildSystemPrompt('research', null);
  assert.ok(prompt1.includes('LinDangAgent'), 'should contain RESEARCH_PRESET (3-arg call works)');
  assert.ok(prompt1.includes('# 投研圆桌 · 研究纪律'), 'should contain COVENANT_RESEARCH');
  assert.ok(!prompt1.includes('[Pikachu 偏置]'), 'no slot → no Pikachu bias');
  assert.ok(!prompt1.includes('[Charmander 偏置]'), 'no slot → no Charmander bias');
  assert.ok(!prompt1.includes('[Squirtle 偏置]'), 'no slot → no Squirtle bias');

  // slotId === null 显式 null 也兼容
  const prompt2 = scenes.buildSystemPrompt('research', null, null);
  assert.ok(!prompt2.includes('[Pikachu 偏置]'), 'null slot → no bias');

  // 无效 slotId 不抛错,不注入
  const prompt3 = scenes.buildSystemPrompt('research', null, 'unknown-slot');
  assert.ok(!prompt3.includes('[Pikachu 偏置]'), 'unknown slot → no bias');
  console.log('  ✓ testBuildSystemPromptResearchNoSlotBackwardCompat');
}

// === 文件管理完整链路（含 per-slot 文件名 + cleanup 兼容） ===
function testFileManagement() {
  const d = tmpDir();
  const mid = 'test-meeting-FM';

  // 老路径: 5 参数 (slotId 缺省)
  const pf = scenes.writePromptFile(d, mid, 'research', '自定义公约');
  assert.ok(fs.existsSync(pf), 'prompt file should exist');
  assert.ok(pf.endsWith(`${mid}-prompt.md`), 'no slotId → 老文件名');
  const content = fs.readFileSync(pf, 'utf-8');
  assert.ok(content.includes(scenes.BASE_RULES), 'prompt file has BASE_RULES');
  assert.ok(content.includes('自定义公约'), 'prompt file has custom covenant');

  // P2 新路径: per-slot 文件名
  const pfPika = scenes.writePromptFile(d, mid, 'research', null, 'pikachu');
  assert.ok(pfPika.endsWith(`${mid}-pikachu-prompt.md`),
    `slotId='pikachu' → per-slot 文件名,得到 ${pfPika}`);
  assert.ok(fs.existsSync(pfPika), 'per-slot prompt file should exist');
  const slotContent = fs.readFileSync(pfPika, 'utf-8');
  assert.ok(slotContent.includes('[Pikachu 偏置]'),
    'per-slot prompt file should contain Pikachu bias');

  // covenant snapshot 不变 (不按 slot 区分)
  scenes.writeCovenantSnapshot(d, mid, '快照公约');
  const read = scenes.readCovenantSnapshot(d, mid);
  assert.strictEqual(read, '快照公约', 'covenant snapshot roundtrip');

  // cleanup 必须清掉 老文件名 + per-slot 文件名 (startsWith 匹配)
  scenes.writePromptFile(d, mid, 'research', null, 'charmander');
  scenes.writePromptFile(d, mid, 'research', null, 'squirtle');
  scenes.cleanup(d, mid);
  const promptDir = path.join(d, 'arena-prompts');
  const remaining = fs.readdirSync(promptDir).filter(f => f.startsWith(`${mid}-`));
  assert.strictEqual(remaining.length, 0,
    `cleanup should remove all meeting files (含 per-slot),剩 ${remaining.join(',')}`);
  console.log('  ✓ testFileManagement');
}

// === getScene: 已知 → 对象，未知 → null ===
function testGetScene() {
  assert.ok(scenes.getScene('general') !== null);
  assert.ok(scenes.getScene('research') !== null);
  assert.strictEqual(scenes.getScene('nonexistent'), null);
  assert.strictEqual(scenes.getScene(undefined), null);
  console.log('  ✓ testGetScene');
}

// === dev scene · plan-dev-scenario.md ===
function testDevSceneRegistered() {
  const dev = scenes.getScene('dev');
  assert.ok(dev !== null, 'dev scene should be registered');
  assert.strictEqual(dev.key, 'dev', 'dev.key must equal "dev" (orchestrator detects via this)');
  assert.strictEqual(dev.name, '开发圆桌');
  // dev 不走 research MCP, 不带 dataPack
  assert.strictEqual(dev.mcpConfig, null);
  assert.strictEqual(dev.dataPackEnabled, false);
  // dev preset 必须含 L1 永真规则关键句 + L2a 姿态自适应
  assert.ok(dev.preset.includes('开发圆桌 · L1 永真规则'), 'dev preset must contain L1 header');
  assert.ok(dev.preset.includes('姿态自适应'), 'dev preset must contain L2a 姿态自适应');
  assert.ok(dev.preset.includes('supervisor'), 'dev preset must define topology');
  assert.ok(dev.preset.includes('Driver'), 'dev preset must mention Driver/worker');
  assert.ok(dev.preset.includes('clarify'), 'dev preset must list clarify stance');
  assert.ok(dev.preset.includes('handoff'), 'dev preset must list handoff stance');
  assert.ok(dev.preset.includes('review'), 'dev preset must list review stance');
  // 模糊意图询问确认必须在 L2a 同段 (避免 AI 主动猜意图直接生成)
  assert.ok(dev.preset.includes('回\'是\'就触发'), 'dev preset must include 询问确认 example');
  console.log('  ✓ testDevSceneRegistered');
}

function testDevSceneDefaultCovenantReuseGeneral() {
  // plan §6 Non-goal: 不复用摘要按钮作 handoff, 但 covenant 复用 GENERAL 不冲突
  //   (COVENANT_GENERAL 描述既有摘要按钮机制 — handoff 是另一回事)
  const dev = scenes.getScene('dev');
  assert.strictEqual(dev.defaultCovenant, scenes.COVENANT_GENERAL,
    'dev 应复用 COVENANT_GENERAL 作 defaultCovenant (timeline / 协作礼仪 / 摘要按钮原状)');
  console.log('  ✓ testDevSceneDefaultCovenantReuseGeneral');
}

function testDevKeywordsExposed() {
  // plan §4.1: handoff 9 / review 5
  assert.ok(Array.isArray(scenes.DEV_KEYWORDS.handoff));
  assert.ok(Array.isArray(scenes.DEV_KEYWORDS.review));
  assert.ok(scenes.DEV_KEYWORDS.handoff.length >= 5, '至少 5 个 handoff 关键词 (允许子串/正则混合)');
  assert.ok(scenes.DEV_KEYWORDS.review.length >= 5, '至少 5 个 review 关键词');
  console.log('  ✓ testDevKeywordsExposed');
}

function testDetectDevTriggerHandoff() {
  // plan §4.1 关键词命中 (post-review 收紧后的清单, 见 DEV_KEYWORDS 说明)
  for (const kw of ['生成交接单', '交接单', '可以开工', '开始写代码', '切 Driver', '切driver']) {
    assert.strictEqual(scenes.detectDevTrigger(kw, false), 'handoff', `"${kw}" → handoff`);
  }
  // 正则形式 "让 X 实操" / "交给 X 做"
  assert.strictEqual(scenes.detectDevTrigger('让 Pikachu 实操', false), 'handoff');
  assert.strictEqual(scenes.detectDevTrigger('让Pikachu实操', false), 'handoff');
  assert.strictEqual(scenes.detectDevTrigger('交给 Squirtle 做', false), 'handoff');
  // 防误触: 已删除 '让 ' / '交接' / '干吧' 三个过短关键词
  //   日常对话不应被识别为 handoff
  assert.strictEqual(scenes.detectDevTrigger('让我想想再说', false), null,
    '"让我想想"不应触发 handoff (无 实操/实现/做 紧跟)');
  assert.strictEqual(scenes.detectDevTrigger('我们先交接班吧', false), null,
    '"交接班"不应触发 handoff');
  assert.strictEqual(scenes.detectDevTrigger('干吧别闹了', false), null,
    '"干吧别闹了"不应触发 handoff');
  console.log('  ✓ testDetectDevTriggerHandoff');
}

function testDetectDevTriggerReview() {
  for (const kw of ['审一下', '看 diff', '看diff', '复审', '帮我审', 'review']) {
    assert.strictEqual(scenes.detectDevTrigger(kw, false), 'review', `"${kw}" → review`);
  }
  console.log('  ✓ testDetectDevTriggerReview');
}

function testDetectDevTriggerFirstTurnDefaultsClarify() {
  // 首轮默认 clarify (即使无关键词)
  assert.strictEqual(scenes.detectDevTrigger('我想做 X 功能', true), 'clarify');
  assert.strictEqual(scenes.detectDevTrigger('', true), 'clarify');
  // 中间轮无关键词 → null (沿用 L2a 自选, 不强行追注)
  assert.strictEqual(scenes.detectDevTrigger('我想做 X 功能', false), null);
  // brainstorm 关键词追注 clarify (中间轮也命中)
  assert.strictEqual(scenes.detectDevTrigger('帮我想想还有别的方案吗', false), 'clarify');
  assert.strictEqual(scenes.detectDevTrigger('问清楚一点', false), 'clarify');
  console.log('  ✓ testDetectDevTriggerFirstTurnDefaultsClarify');
}

function testDetectDevTriggerLightTaskDirectDiscuss() {
  // plan §2.2 轻任务直通: "X 函数怎么改" 不被强制走 clarify (中间轮 + 无关键词 → null)
  // 注: 首轮发问"X 函数怎么改"仍会进 clarify, 这是设计妥协 (首轮无 timeline 上下文,
  //   AI 自己根据 L2a "边界清晰的轻任务可跳过 clarify" 提示自适应)
  assert.strictEqual(scenes.detectDevTrigger('foo 函数应该怎么改', false), null,
    '中间轮无关键词 → null, 让 AI 按 L2a 姿态自选 (轻任务直通 discuss)');
  console.log('  ✓ testDetectDevTriggerLightTaskDirectDiscuss');
}

function testBuildDevL2bSection() {
  const clarify = scenes.buildDevL2bSection('clarify');
  assert.ok(clarify && clarify.includes('clarify 详细规则'));
  assert.ok(clarify.includes('[必答]') && clarify.includes('[建议]') && clarify.includes('[可选]'));

  const handoff = scenes.buildDevL2bSection('handoff');
  assert.ok(handoff && handoff.includes('handoff 两步法'));
  assert.ok(handoff.includes('Decision Recall'));
  assert.ok(handoff.includes('Open Questions'));
  assert.ok(handoff.includes('Next Action'));

  const review = scenes.buildDevL2bSection('review');
  assert.ok(review && review.includes('review 三段式'));
  assert.ok(review.includes('已验证事实'));
  assert.ok(review.includes('风险'));

  // null/未知 → null
  assert.strictEqual(scenes.buildDevL2bSection(null), null);
  assert.strictEqual(scenes.buildDevL2bSection('unknown'), null);
  console.log('  ✓ testBuildDevL2bSection');
}

function testDevSystemPromptIsolatedFromOtherScenes() {
  // plan §9 验证: 切回投研/通用场景, 开发 prompt 不污染
  const general = scenes.buildSystemPrompt('general', '');
  const research = scenes.buildSystemPrompt('research', '');
  // 不应含 dev 特有标记
  assert.ok(!general.includes('开发圆桌 · L1 永真规则'), 'general scene must not leak dev L1');
  assert.ok(!general.includes('handoff 两步法'), 'general scene must not leak dev L2b');
  assert.ok(!research.includes('开发圆桌 · L1 永真规则'), 'research scene must not leak dev L1');
  assert.ok(!research.includes('handoff 两步法'), 'research scene must not leak dev L2b');
  // dev system prompt 应含 dev preset
  const dev = scenes.buildSystemPrompt('dev', '');
  assert.ok(dev.includes('开发圆桌 · L1 永真规则'), 'dev system prompt must contain dev preset');
  // L2b 详细规则 NOT 在 system prompt (按 trigger per-turn 追注)
  assert.ok(!dev.includes('clarify 详细规则 · 本轮触发追注'),
    'dev system prompt 不应含 L2b 详细规则 (per-turn 追注, 不进 cache)');
  console.log('  ✓ testDevSystemPromptIsolatedFromOtherScenes');
}

console.log('Running roundtable-scenes unit tests (P0-P5 prompt 重构)...');
let failed = 0;
const tests = [
  testL1BaseRulesIsMinimal,
  testL1BaseRulesAiVsUserAccessV2,
  testL2CovenantGeneralExported,
  testRegistryStructure,
  testResearchPresetCore,
  testResearchPresetBashEscapeSafe,
  testGeneralPresetEnhanced,
  testGeneralDefaultCovenantIsCovenantGeneral,
  testResearchDefaultCovenantIsCombined,
  testCovenantResearch24Round,
  testResearchSlotBiasesExist,
  testFiveElementSchema,
  testResumeRemindersDeleted,
  testBuildSystemPromptUserOverride,
  testBuildSystemPromptNullFallbackGeneral,
  testBuildSystemPromptNullFallbackResearch,
  testBuildSystemPromptEmptyStringNoSeparator,
  testBuildSystemPromptResearchSlotInjection,
  testBuildSystemPromptCharmanderInjection,
  testBuildSystemPromptSquirtleInjection,
  testBuildSystemPromptGeneralNoSlotInjection,
  testBuildSystemPromptResearchNoSlotBackwardCompat,
  testFileManagement,
  testGetScene,
  // dev scene tests (plan-dev-scenario.md)
  testDevSceneRegistered,
  testDevSceneDefaultCovenantReuseGeneral,
  testDevKeywordsExposed,
  testDetectDevTriggerHandoff,
  testDetectDevTriggerReview,
  testDetectDevTriggerFirstTurnDefaultsClarify,
  testDetectDevTriggerLightTaskDirectDiscuss,
  testBuildDevL2bSection,
  testDevSystemPromptIsolatedFromOtherScenes,
];
for (const t of tests) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    failed++;
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
