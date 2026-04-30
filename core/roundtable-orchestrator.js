'use strict';
// Roundtable Orchestrator — 投研圆桌轮次状态机
//
// 三种轮次模式：
//   fanout : 默认提问 → 三家独立回答（互不知情）
//   debate : @debate → 把另两家上一轮观点中转给第三家（可附用户补充）
//   summary: @summary @<who> → 单家收到全部历史轮次，给最终意见
//
// 持久化：
//   <arena-prompts>/<meetingId>-roundtable.json  — 状态
//   <arena-prompts>/<meetingId>-turn-N.json      — 每轮详细记录
//
// PTY 输入 / turn-complete 监听由 main.js 的 IPC handler 调度（复用 executeReview 既有模式）

const fs = require('fs');
const path = require('path');

const MAX_DEBATE_OPINION_CHARS = 5000;
const MAX_DEBATE_OPINION_KEEP = 2000;
const MAX_SUMMARY_PER_VIEW_CHARS = 3000;
// 软提醒两阶段：T1 先弹 banner 提示"还在等"，T2 再升级提醒。
//   永不自动 settle—— 真正退出由用户点"手动提取/跳过/重发"或 L1/L2 信号决定。
//   设计文档：docs/superpowers/specs/2026-04-30-roundtable-resilience-design.md
//   （旧 TURN_WATCHDOG_MS = 600000 强制超时已在 Stage 2 commit 2 移除——
//    main.js _rtWaitTurnComplete 改用 turn-completion-watcher。）
const SOFT_ALERT_T1_MS = 90000;  //  90s — 首阶段提醒
const SOFT_ALERT_T2_MS = 180000; // 180s — 二阶段升级

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

class RoundtableOrchestrator {
  constructor(hubDataDir, meetingId, scene) {
    this.hubDataDir = hubDataDir;
    this.meetingId = meetingId;
    this.scene = scene || { name: '圆桌', summaryHints: '', summaryTitleTag: false, dataPackEnabled: false };
    this.state = {
      meetingId,
      currentTurn: 0,
      currentMode: 'idle',
      turns: [], // [{ n, mode, userInput, by: { sid: text }, timestamp, meta }]
    };
    this._loadState();
  }

  _stateFilePath() {
    return path.join(arenaPromptsDir(this.hubDataDir), `${this.meetingId}-roundtable.json`);
  }
  _turnFilePath(n) {
    return path.join(arenaPromptsDir(this.hubDataDir), `${this.meetingId}-turn-${n}.json`);
  }

  _loadState() {
    const fp = this._stateFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (raw && raw.meetingId === this.meetingId) this.state = raw;
    } catch (e) {
      console.warn(`[roundtable] load state failed for ${this.meetingId}:`, e.message);
    }
  }

  _saveState() {
    const fp = this._stateFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  _saveTurnFile(turnRecord) {
    const fp = this._turnFilePath(turnRecord.n);
    fs.writeFileSync(fp, JSON.stringify(turnRecord, null, 2), 'utf-8');
  }

  getState() { return JSON.parse(JSON.stringify(this.state)); }
  getLastTurn() {
    return this.state.turns.length > 0 ? this.state.turns[this.state.turns.length - 1] : null;
  }

  // ---------------------------------------------------------------------
  // Prompt 拼装
  // ---------------------------------------------------------------------

  // 默认 fanout 轮：用户原话 +（可选）数据包前缀
  buildFanoutPrompt(turnNum, userInput, dataPack) {
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · 默认提问]`];
    if (this.scene.dataPackEnabled && dataPack && typeof dataPack === 'string' && dataPack.trim().length > 0) {
      parts.push('', '## 数据接入（Hub 自动从 LinDangAgent 拉取）', dataPack);
    }
    parts.push('', '## 用户问题', userInput || '');
    parts.push('', '请独立回答（你看不到另两家观点，本色发挥即可）。');
    return parts.join('\n');
  }

  // debate 轮：中转另两家上一轮观点给当前 AI
  // lastTurn = { by: { sid: text } }
  // targetSid = 当前接收 AI 的 sid（不会把它自己的观点发给它）
  // sidLabelFn = (sid) => label string
  buildDebatePrompt(turnNum, userInput, lastTurn, targetSid, sidLabelFn) {
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · @debate]`, ''];
    if (userInput && userInput.trim().length > 0) {
      parts.push('## 用户在本轮补充的新信息', userInput, '');
    }
    parts.push('## 另两家上一轮观点');
    let appended = 0;
    const byStatus = lastTurn?.byStatus || null; // Stage 2 容错升级，null = 老格式按 completed
    for (const [sid, text] of Object.entries(lastTurn?.by || {})) {
      if (sid === targetSid) continue;
      const label = sidLabelFn ? (sidLabelFn(sid) || 'AI') : 'AI';
      const status = byStatus ? (byStatus[sid] || 'completed') : 'completed';
      // 容错升级：absent/errored 的家不传"空内容"假装"无观点"，明确说"本轮未参与"
      if (status === 'absent') {
        parts.push('', `### ${label} 的观点`, `（${label} 本轮因故未参与，请勿引用）`);
        appended++;
        continue;
      }
      if (status === 'errored') {
        parts.push('', `### ${label} 的观点`, `（${label} 本轮发生错误未输出，请勿引用）`);
        appended++;
        continue;
      }
      let trimmed = (text || '(无输出)');
      if (trimmed.length > MAX_DEBATE_OPINION_CHARS) {
        trimmed = trimmed.slice(0, MAX_DEBATE_OPINION_KEEP)
          + '\n\n…[中段已省略以控制 prompt 长度]…\n\n'
          + trimmed.slice(-MAX_DEBATE_OPINION_KEEP);
      }
      parts.push('', `### ${label} 的观点`, trimmed);
      appended++;
    }
    if (appended === 0) parts.push('(无另两家上轮记录)');
    parts.push('', '## 你的任务');
    parts.push('请基于另两家观点 + 用户补充信息，发表新观点：可以继承、可以反驳，但要明示引用对方哪一点。');
    return parts.join('\n');
  }

  // summary 轮：summarizer 自己的 PTY 上下文已经读过前面所有轮次（fanout 自答 + debate 收对方观点）
  // 所以只发任务说明 + 最近一轮（debate）作为复习参考即可，不再回放全部历史
  buildSummaryPrompt(turnNum, summarizerSid, sidLabelFn) {
    const summarizerLabel = sidLabelFn ? (sidLabelFn(summarizerSid) || 'AI') : 'AI';
    const totalTurns = this.state.turns.length;
    const lastTurn = this.getLastTurn();
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · @summary @${summarizerLabel}]`, ''];
    parts.push('## 你的任务');
    parts.push(`你已经在自己的上下文里读过前 ${totalTurns} 轮讨论（含你自己的观点 + 另两家观点 + 用户补充）。`);
    parts.push('请直接基于上下文给出最终意见，不需要逐轮复述。');
    parts.push('');
    parts.push('输出格式建议：');
    parts.push('  1) 结论先行（推荐 / 不推荐 / 中性 / 观望，附简短理由）');
    parts.push('  2) 三方共识与关键分歧');
    parts.push(`  3) 具体行动建议（${this.scene.summaryHints || '按讨论话题自适应'}）`);
    if (this.scene.summaryTitleTag) {
      parts.push('  4) 在末尾用 `<<TITLE: xxx>>` 标记本次会话简短标题（用于决策档案命名，例：`<<TITLE: 兆易创新-买入决策>>`）');
    }

    // 仅附最近一轮作为防健忘参考，且只附另两家观点（summarizer 自己的不重复发回）
    if (lastTurn) {
      parts.push('');
      parts.push(`## 最近一轮（第 ${lastTurn.n} 轮 · ${lastTurn.mode}）参考 — 仅另两家观点，仅供唤起记忆`);
      if (lastTurn.userInput && lastTurn.userInput.trim().length > 0) {
        parts.push(`**用户输入**：${lastTurn.userInput.slice(0, 1000)}`);
      }
      let appended = 0;
      const byStatus = lastTurn.byStatus || null; // Stage 2 容错升级
      for (const [sid, text] of Object.entries(lastTurn.by || {})) {
        if (sid === summarizerSid) continue;
        const label = sidLabelFn ? (sidLabelFn(sid) || 'AI') : 'AI';
        const status = byStatus ? (byStatus[sid] || 'completed') : 'completed';
        if (status === 'absent') {
          parts.push('', `### ${label}`, `（${label} 本轮因故未参与，请勿引用）`);
          appended++;
          continue;
        }
        if (status === 'errored') {
          parts.push('', `### ${label}`, `（${label} 本轮发生错误未输出，请勿引用）`);
          appended++;
          continue;
        }
        let trimmed = text || '(无输出)';
        if (trimmed.length > MAX_SUMMARY_PER_VIEW_CHARS) {
          trimmed = trimmed.slice(0, MAX_SUMMARY_PER_VIEW_CHARS) + '…[已截断]';
        }
        parts.push('', `### ${label}`, trimmed);
        appended++;
      }
      if (appended === 0) parts.push('(无另两家上轮记录 — 你自己直接综合输出即可)');
    }
    return parts.join('\n');
  }


  // ---------------------------------------------------------------------
  // 状态记录
  // ---------------------------------------------------------------------

  // 启动一轮：返回新 turnNum
  beginTurn(mode) {
    this.state.currentTurn += 1;
    this.state.currentMode = mode;
    this._saveState();
    return this.state.currentTurn;
  }

  // 完成一轮：写持久化
  // byMap: { sid: text }
  // meta: 任意附加（如 summarizer / decisionTitle）
  // byStatus: { sid: 'completed' | 'manual_extracted' | 'absent' | 'errored' | ... }
  //   新增（Stage 2 容错升级）。null/undefined 表示老格式 — buildDebate/Summary 会按
  //   "全部 completed" 处理。下游 prompt builder 用此字段过滤 absent/errored 参与者。
  completeTurn(turnNum, mode, userInput, byMap, meta = {}, byStatus = null) {
    const record = {
      n: turnNum,
      mode,
      userInput: userInput || '',
      by: byMap || {},
      byStatus: byStatus || null,
      timestamp: Date.now(),
      ...meta,
    };
    this.state.turns.push(record);
    this.state.currentMode = 'idle';
    delete this.state.currentSummarizerKind;
    this._saveState();
    this._saveTurnFile(record);
    return record;
  }

  // 回滚（启动后失败）
  rollbackTurn(turnNum) {
    if (this.state.currentTurn === turnNum) {
      this.state.currentTurn -= 1;
      this.state.currentMode = 'idle';
      delete this.state.currentSummarizerKind;
      this._saveState();
    }
  }
}

// 单例池：每会议室一个 orchestrator
const _pool = new Map();
function getOrchestrator(hubDataDir, meetingId, scene) {
  const key = `${hubDataDir}::${meetingId}`;
  if (!_pool.has(key)) _pool.set(key, new RoundtableOrchestrator(hubDataDir, meetingId, scene));
  const orch = _pool.get(key);
  if (scene) orch.scene = scene;
  return orch;
}
function releaseOrchestrator(hubDataDir, meetingId) {
  const key = `${hubDataDir}::${meetingId}`;
  _pool.delete(key);
}

// 提取 summary 输出末尾的 <<TITLE: xxx>> 标记
function extractDecisionTitle(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/<<TITLE:\s*([^>\n]{1,80})>>/);
  return m ? m[1].trim() : null;
}

module.exports = {
  RoundtableOrchestrator,
  getOrchestrator,
  releaseOrchestrator,
  extractDecisionTitle,
  SOFT_ALERT_T1_MS,
  SOFT_ALERT_T2_MS,
};
