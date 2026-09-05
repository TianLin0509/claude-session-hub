'use strict';

/*
 * Semantic workflow templates.
 * Templates only prefill the editable serial-workflow form. They never lock it:
 * callers may freely change steps, assignees, names, and prompts afterwards.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WorkflowTemplates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REVIEW_RESULT_CONTRACT = [
    '最后严格输出四行：',
    'RESULT: PASS 或 FAIL',
    'BLOCKERS: 无，或列出必须修复的问题',
    'VERIFIED: 实际执行的验证及结果',
    'NEXT: 无，或下一步建议',
  ].join('\n');

  const TASK_PRESETS = [
    { id: 'task-safe-resume', name: '续跑', desc: '先校准当前状态，再继续未完成项', minMembers: 2, recommended: true },
    { id: 'task-review-verify', name: '审查', desc: '缺陷、回归、验证分步审查后收口', minMembers: 2 },
    { id: 'task-feature-delivery', name: '功能', desc: '范围与验收、实现、验证串行交付', minMembers: 2 },
    { id: 'task-root-cause-fix', name: '修 Bug', desc: '并行诊断、最小修复、独立回归', minMembers: 2 },
    { id: 'task-research-decision', name: '调研', desc: '支持证据、反证、缺失信息、决策', minMembers: 2 },
    // 开发场景的默认工作流。**通用**：prompt 里不出现任何项目名或绝对路径，
    // 全部走仓库内相对路径 —— 群聊的工作目录就是项目根，所以 .agents/AUTHOR.md 对任何项目都成立。
    // 项目差异沉淀在各自仓库的 .agents/ 里，改流程只改那几个 .md，不用回来动 Hub。
    { id: 'dev-task', name: '开发任务', desc: '工作位实现 ↔ 合并位审，PASS 即合并', minMembers: 2, recommended: true },
  ];

  const TEMPLATES = [
    {
      id: 'review-plan-build-finalize',
      name: '审视 → 方案 → 落地 → 终审',
      desc: '2–3 个 AI 先并行审视，再由单个 AI 收敛、落地和终审',
      minMembers: 2,
      recommended: true,
    },
    {
      id: 'three-agent-two-improvements',
      name: '三 AI · 两点优化接力',
      desc: '每一棒先修前序问题，再落地两个不重复优化点',
      minMembers: 2,
    },
    {
      id: 'fast-review-loop',
      name: '快速实现闭环',
      desc: '1 个执行者 + 1–2 个评审；FAIL 回修，PASS 立即结束',
      minMembers: 2,
    },
    {
      id: 'parallel-review-synthesis',
      name: '多审一决',
      desc: '2–3 个 AI 独立给意见，再由 1 个 AI 裁决收口',
      minMembers: 2,
    },
  ];

  function memberIds(members) {
    return (members || []).map(m => m && m.memberId).filter(Boolean);
  }

  function one(ids, index) {
    return [ids[index] || ids[0]].filter(Boolean);
  }

  function config(steps, stepConfigs, loop) {
    return {
      enabled: steps.length > 0,
      steps,
      stepConfigs,
      loop: Object.assign({ enabled: false, policyVersion: 2, maxRounds: 3, consecutivePass: 1, polish: false }, loop || {}),
    };
  }

  function getTemplateMeta(templateId) {
    return TASK_PRESETS.concat(TEMPLATES).find(t => t.id === templateId) || null;
  }

  function createTemplateConfig(templateId, members) {
    const ids = memberIds(members);
    const template = getTemplateMeta(templateId);
    if (!template || ids.length < template.minMembers) return null;

    if (templateId === 'task-safe-resume') {
      return config(
        [ids.slice(0, 3), one(ids, 0), one(ids, 1)],
        [
          { name: '状态校准', prompt: '独立核对当前会话和可用工作区证据。只列：原目标、已完成且有证据的部分、未完成或未验证部分、最优先的下一步。不要开始执行，不要猜测缺失状态。' },
          { name: '继续执行', prompt: '综合前序状态校准，只执行最高优先级未完成项。不要重复已完成工作，不要开启新方向；上下文仍不足时明确阻断。完成后运行最小相关验证。' },
          { name: '续跑验收', prompt: '检查本轮是否偏离原目标、重复工作或遗漏验证。必要时修正；最终只报告本轮新增动作、验证结果和剩余阻断。' },
        ],
      );
    }

    if (templateId === 'task-review-verify') {
      return config(
        [one(ids, 0), one(ids, 1), one(ids, 2), one(ids, 0)],
        [
          { name: '缺陷审查', prompt: '保持只读。只找会导致目标不成立、数据错误、崩溃或安全问题的可复现缺陷；按严重度给位置、影响和证据。不要讨论风格偏好。' },
          { name: '回归审查', prompt: '阅读前序结果但不要复述。重点检查状态一致性、边界条件、兼容性和可能回归；只报告新增的可行动问题与验证方法。' },
          { name: '验证缺口', prompt: '阅读前序结果但不要复述。核对现有测试与证据是否真的覆盖验收标准；亲自执行可行验证，指出未验证项和假阳性风险。保持只读。' },
          { name: '验收裁决', prompt: `综合全部审查结果，去重并裁决阻断项。不要修改代码。${REVIEW_RESULT_CONTRACT}` },
        ],
      );
    }

    if (templateId === 'task-feature-delivery') {
      return config(
        [one(ids, 0), one(ids, 1), one(ids, 2)],
        [
          { name: '范围与验收', prompt: '核对目标、非目标、现有实现和约束，给出唯一执行方案与可验证验收标准。不要开始改代码。' },
          { name: '聚焦实现', prompt: '按前序已收敛方案完成实现。保持改动聚焦，不顺手重构无关模块；运行最小相关验证并记录证据。' },
          { name: '交付验收', prompt: '审查前序实现，按验收标准逐项执行真实验证。发现阻断问题时做必要修复并回归；输出改动、证据、遗留和回退方式。' },
        ],
      );
    }

    if (templateId === 'task-root-cause-fix') {
      return config(
        [ids.slice(0, 3), one(ids, 0), ids.slice(1, 3)],
        [
          { name: '并行诊断', prompt: '保持只读，独立完成复现、日志取证和调用链分析，提出可证伪的根因假设。根因未确认前不要改代码；避免复述显而易见的症状。' },
          { name: '最小修复', prompt: '根据前序证据裁决唯一根因，只做解决根因所需的最小改动。不得掩盖症状或扩大范围；完成后执行最小相关验证。' },
          { name: '独立回归', prompt: '审查根因证据与实际改动，独立执行复现用例和相邻回归。发现阻断问题时明确 FAIL；否则给出 PASS、验证证据和剩余风险。' },
        ],
      );
    }

    if (templateId === 'task-research-decision') {
      return config(
        [one(ids, 0), one(ids, 1), one(ids, 2), one(ids, 0)],
        [
          { name: '支持证据', prompt: '优先核验一手和当前来源，寻找最支持候选方案的事实证据；区分事实、推断与未知，并标注来源边界。' },
          { name: '最强反证', prompt: '阅读前序材料但不要迎合。寻找会推翻候选方案的最强反证、失败条件和隐含成本；优先核验一手来源。' },
          { name: '缺失信息', prompt: '识别当前结论仍依赖的未知信息、不可比项和验证缺口，给出最低成本的补证动作；不要重复支持或反对意见。' },
          { name: '决策收口', prompt: '综合支持证据、反证和缺失信息，比较收益、成本、风险与可逆性。给出唯一推荐、成立条件、待查问题和下一步动作。' },
        ],
      );
    }

    // ── 开发场景默认工作流 ──────────────────────────────────────────────────
    // prompt 只指向仓库内的相对路径，不在这里复制规则，也不写死任何项目。
    // 群聊的工作目录 = 项目根，所以 .agents/AUTHOR.md 对每个整理过的项目都成立。
    // 想改流程就改那个项目的 .md，不用回来动 Hub。
    // 项目还没整理过（没有 .agents/）时，agent 会读不到合同 —— 那说明该先跑
    // project-prep skill 把项目整理成规范形态。
    if (templateId === 'dev-task') {
      return config(
        [one(ids, 0), one(ids, 1)],
        [
          {
            name: '工作位实现',
            timeoutMs: 30 * 60 * 1000,   // 实现最费时，给引擎允许的上限
            prompt: [
              '读本仓库的 .agents/AUTHOR.md，按它工作。',
              '任务就是本群聊里我上一条消息说的那件事；没说清就先问我一句，不要猜。',
              '若收到上一轮合并位的 BLOCKERS，只修 BLOCKERS 里列的东西，不要顺手扩需求。',
              '最后按合同输出 PROGRESS / VERIFIED / RISK / REPORT 四行人话，不要贴代码。',
            ].join('\n'),
          },
          {
            name: '合并位审查',
            timeoutMs: 25 * 60 * 1000,   // 它要真跑测试，不能只留给模型思考的时间
            prompt: [
              '读本仓库的 .agents/MERGER.md，按它工作。',
              '你和上一步不是同一个会话，独立性成立 —— 但如果这个分支其实是你写的，直接说出来。',
              '重点：先确认主干有没有被别的任务推进过，并基于最新主干跑 dry-run；只有冲突或集成测试失败才要求工作位 rebase 修复。',
              '必须亲自跑验证（合同里的 --dry-run），不采信工作位报的任何结果。',
              'PASS 才由你执行合并，FAIL 一律不合。',
              REVIEW_RESULT_CONTRACT,
            ].join('\n'),
          },
        ],
        { enabled: true, maxRounds: 3 },
      );
    }

    if (templateId === 'review-plan-build-finalize') {
      return config(
        [ids.slice(0, 3), one(ids, 0), one(ids, 1), one(ids, 2)],
        [
          { name: '并行审视', prompt: '独立审视目标、现状或已有草案。只给：最多 3 个关键风险、最多 3 条改进、1 个推荐方向；不要改代码。' },
          { name: '主方案', prompt: '综合前序审视，给出唯一可执行方案：范围、关键步骤、验收标准、风险与回退；不要开始实现。' },
          { name: '优化并落地', prompt: '按已收敛方案实施。允许做必要的小幅优化；不要扩散范围。完成后运行相关验证，汇报改动、证据和遗留。' },
          { name: '修复并终审', prompt: '审查全部前序改动；先修复确认的 bug，再做必要优化；运行回归验证。最后给 PASS/FAIL、修复内容、验证证据和剩余风险。' },
        ],
      );
    }

    if (templateId === 'three-agent-two-improvements') {
      return config(
        [one(ids, 0), one(ids, 1), one(ids, 2)],
        [
          { name: '第一棒', prompt: '审视当前实现，选择价值最高且可验证的 2 个优化点，直接落地并测试。不要做无关重构。' },
          { name: '第二棒', prompt: '先审查并修复前一步的 bug；再提出并落地 2 个不重复、可验证的优化点；运行相关测试。' },
          { name: '第三棒与收口', prompt: '先审查并修复全部前序改动；再落地 2 个不重复优化点；跑回归并给最终结论、证据和剩余风险。若第二个候选明显低价值或高风险，不要为了凑数强改，说明原因即可。' },
        ],
      );
    }

    if (templateId === 'fast-review-loop') {
      return config(
        [one(ids, 0), ids.slice(1, 3)],
        [
          { name: '实现或修复', prompt: '实现目标并运行验证。若收到上一轮阻断项，只修阻断项；不要主动扩展新需求。' },
          { name: '并行验收', prompt: '只读审查并亲自验证，不修改代码。只有存在会让目标不成立的问题才判 FAIL。' },
        ],
        { enabled: true, maxRounds: 3 },
      );
    }

    if (templateId === 'parallel-review-synthesis') {
      return config(
        [ids.slice(0, 3), one(ids, 0)],
        [
          { name: '独立意见', prompt: '独立分析问题，给出结论、关键依据、最大风险和推荐动作；不要迎合其他 AI，不要修改代码。' },
          { name: '裁决收口', prompt: '综合前序意见，明确共识、分歧和取舍，输出一个最终建议与下一步；不要简单拼接原文。' },
        ],
      );
    }
    return null;
  }

  function normalizeStepConfigs(steps, stepConfigs) {
    return (steps || []).map((_step, index) => {
      const item = Array.isArray(stepConfigs) && stepConfigs[index] && typeof stepConfigs[index] === 'object'
        ? stepConfigs[index]
        : {};
      const out = {
        name: typeof item.name === 'string' ? item.name : '',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
      };
      // timeoutMs 是可选的按步超时。loop-engine 会读它（缺省 10 分钟，钳位 1–30 分钟），
      // 但这里以前只保留 name/prompt，模板填的值在归一化时被吃掉，引擎永远读到 undefined。
      // 只在是有限正数时保留，避免把 NaN/字符串塞进去让引擎的 clamp 退回默认值。
      const t = Number(item.timeoutMs);
      if (Number.isFinite(t) && t > 0) out.timeoutMs = t;
      return out;
    });
  }

  function buildSerialStepPrompt(goal, stepConfig, index, total) {
    const cfg = stepConfig && typeof stepConfig === 'object' ? stepConfig : {};
    const prompt = String(cfg.prompt || '').trim();
    if (!prompt) return String(goal || '');
    const name = String(cfg.name || '').trim();
    return [
      `【串行工作流 · 第 ${index + 1}/${total} 步${name ? ` · ${name}` : ''}】`,
      `总目标：${String(goal || '').trim()}`,
      '',
      '本步骤职责：',
      prompt,
      '',
      index > 0 ? '请先阅读群内前序步骤结果，只完成本步骤职责。' : '只完成本步骤职责，不要提前代替后续步骤。',
      '涉及代码修改时必须运行最小相关验证。输出保持简洁：结论、动作、验证、风险。',
    ].join('\n');
  }

  return {
    REVIEW_RESULT_CONTRACT,
    TASK_PRESETS,
    TEMPLATES,
    getTemplateMeta,
    createTemplateConfig,
    normalizeStepConfigs,
    buildSerialStepPrompt,
  };
});
