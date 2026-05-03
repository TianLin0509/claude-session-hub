'use strict';
// Stage 2 容错升级（2026-05-01）— 单家圆桌等待器
//
// 替代 main.js 老 _rtWaitTurnComplete 内联实现的"硬性 watchdog"：
//   旧版：600s 强制 timeout → 整轮 settle → 按钮锁 10 分钟。
//   新版：永不自动 settle，只在 T1=90s / T2=180s 触发非阻塞软提醒回调；
//        真正退出由用户操作（manualExtract / skip）或 transcriptTap 的协议级
//        L1/L2 事件（turn-complete / turn-error）决定。
//
// 设计文档：
//   docs/superpowers/specs/2026-04-30-roundtable-resilience-design.md
//   docs/superpowers/plans/2026-04-30-roundtable-resilience.md (Task 2)
//
// 状态机：
//   wait() called → submitted（监听 + T1/T2 定时器启动）
//      ├─→ transcriptTap turn-complete → status: 'completed'
//      ├─→ transcriptTap turn-error    → status: 'errored'
//      ├─→ manualExtract(text)         → status: 'manual_extracted'
//      ├─→ skip()                      → status: 'absent'
//      └─→ T1/T2 触发 onSoftAlert(level)，**不 settle**，等待真触发点
//
// 注意：watcher 本身不处理 L2（PTY exit）信号——P1 阶段在 main.js 里通过
//   onProcessExit 钩子注入。本文件只暴露 onProcessExit 占位，预留 P1 接入。

const {
  SOFT_ALERT_T1_MS: DEFAULT_T1_MS,
  SOFT_ALERT_T2_MS: DEFAULT_T2_MS,
} = require('./roundtable-orchestrator.js');

const PATCH_WINDOW_MS = 300_000;  // 5 分钟（spec 2026-05-03）

function createTurnCompletionWatcher(opts) {
  const {
    transcriptTap,
    hubSessionId,
    label,
    softAlertT1Ms = DEFAULT_T1_MS,
    softAlertT2Ms = DEFAULT_T2_MS,
    onSoftAlert = () => {},
    // P1 占位：接入 PTY 退出事件作为 L2 信号源。watcher 不主动监听进程，
    //   由调用方在 PTY exit 时调 watcher 的 markProcessExit() 钩子。
    onProcessExit = null, // eslint-disable-line no-unused-vars
    onTurnPatched = null,                   // 新增（2026-05-03）
    patchWindowMs = PATCH_WINDOW_MS,        // 新增（测试可注入更短的窗口）
  } = opts || {};

  if (!transcriptTap) throw new Error('createTurnCompletionWatcher: transcriptTap required');
  if (!hubSessionId) throw new Error('createTurnCompletionWatcher: hubSessionId required');

  let resolveFn = null;
  let settled = false;
  let t1Timer = null;
  let t2Timer = null;
  let onTurnComplete = null;
  let onTurnError = null;

  // patch-after-settle 状态（2026-05-03）
  let patchListener = null;
  let patchWindowTimer = null;
  let settledText = '';
  let patchCancelled = false;

  const cleanup = () => {
    if (t1Timer) { clearTimeout(t1Timer); t1Timer = null; }
    if (t2Timer) { clearTimeout(t2Timer); t2Timer = null; }
    if (onTurnComplete) { transcriptTap.removeListener('turn-complete', onTurnComplete); onTurnComplete = null; }
    if (onTurnError) { transcriptTap.removeListener('turn-error', onTurnError); onTurnError = null; }
  };

  const _cleanupPatch = () => {
    if (patchListener) { transcriptTap.removeListener('turn-complete', patchListener); patchListener = null; }
    if (patchWindowTimer) { clearTimeout(patchWindowTimer); patchWindowTimer = null; }
  };

  const settle = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    settledText = result.text || '';
    // 仅 completed 状态才挂 patch listener（manual_extracted/absent/errored 没必要 patch）
    if (result.status === 'completed' && onTurnPatched && !patchCancelled) {
      patchListener = (evt) => {
        if (evt.hubSessionId !== hubSessionId) return;
        if (evt.signalSource !== 'stop_reason_terminal' && evt.signalSource !== 'stop_hook') return;
        if (!evt.text || evt.text === settledText) return;
        if (evt.text.length <= settledText.length) return;
        try { onTurnPatched({ sid: hubSessionId, label, text: evt.text, status: 'completed' }); }
        catch (e) { console.warn('[watcher] onTurnPatched threw:', e && e.message); }
        settledText = evt.text;  // 更新基线，可能还有 M3
      };
      transcriptTap.on('turn-complete', patchListener);
      patchWindowTimer = setTimeout(_cleanupPatch, patchWindowMs);
      if (patchWindowTimer.unref) patchWindowTimer.unref();
    }
    if (resolveFn) resolveFn(result);
  };

  return {
    /**
     * 启动监听 + 定时器，返回 settle 后的 result 对象。
     * @returns {Promise<{
     *   sid: string,
     *   label: string,
     *   status: 'completed' | 'errored' | 'manual_extracted' | 'absent',
     *   text: string,
     *   signalSource?: string,
     *   completedAt?: number,
     *   reason?: string,
     * }>}
     */
    wait() {
      if (settled) return Promise.resolve({ sid: hubSessionId, label, status: 'absent', text: '' });

      return new Promise((resolve) => {
        resolveFn = resolve;

        onTurnComplete = (evt) => {
          if (evt.hubSessionId !== hubSessionId) return;
          settle({
            sid: hubSessionId,
            label,
            status: 'completed',
            text: evt.text || '',
            signalSource: evt.signalSource || 'unknown',
            completedAt: evt.completedAt || Date.now(),
          });
        };

        onTurnError = (evt) => {
          if (evt.hubSessionId !== hubSessionId) return;
          settle({
            sid: hubSessionId,
            label,
            status: 'errored',
            text: '',
            reason: evt.reason || 'unknown',
          });
        };

        transcriptTap.on('turn-complete', onTurnComplete);
        transcriptTap.on('turn-error', onTurnError);

        // 软提醒计时器：触发后**不 settle**，仅通知调用方"这家还在等"。
        t1Timer = setTimeout(() => {
          if (settled) return;
          try { onSoftAlert('t1'); } catch (e) { console.warn('[watcher] onSoftAlert t1 throw:', e.message); }
        }, softAlertT1Ms);
        t2Timer = setTimeout(() => {
          if (settled) return;
          try { onSoftAlert('t2'); } catch (e) { console.warn('[watcher] onSoftAlert t2 throw:', e.message); }
        }, softAlertT2Ms);
      });
    },

    /**
     * 用户在 UI 点"一键提取"——绕过完成检测，直接以传入文本 settle。
     * 文本由调用方先调 transcriptTap.extractLatestGeminiTurn() 拿到。
     */
    manualExtract(text) {
      settle({
        sid: hubSessionId,
        label,
        status: 'manual_extracted',
        text: text || '',
        signalSource: 'manual',
      });
    },

    /**
     * 用户跳过本家——下游 prompt 构建器会过滤这家，不引用其内容。
     */
    skip() {
      settle({
        sid: hubSessionId,
        label,
        status: 'absent',
        text: '',
      });
    },

    /**
     * P1 钩子：PTY 子进程退出时由 main.js 调用，作为 L2 完成信号。
     *   exitCode === 0 视为"自然退出但无 L1 信号"→ completed（兜底，无文本）；
     *   exitCode !== 0 / signal 视为 errored。
     *   P0 阶段不调用此方法；watcher 暴露此 API 是为 commit 6（P1-1）预埋。
     */
    markProcessExit(exitInfo) {
      const { code, signal } = exitInfo || {};
      if (settled) return;
      if (code === 0 && !signal) {
        settle({
          sid: hubSessionId,
          label,
          status: 'completed',
          text: '',
          signalSource: 'process_exit_clean',
          completedAt: Date.now(),
        });
      } else {
        settle({
          sid: hubSessionId,
          label,
          status: 'errored',
          text: '',
          reason: `pty exit code=${code} signal=${signal || 'none'}`,
        });
      }
    },

    isSettled() { return settled; },

    cancelPatch() {
      patchCancelled = true;
      _cleanupPatch();
    },
  };
}

module.exports = {
  createTurnCompletionWatcher,
  // 重新导出常量，让 main.js / 测试可以从单一入口拿
  SOFT_ALERT_T1_MS: DEFAULT_T1_MS,
  SOFT_ALERT_T2_MS: DEFAULT_T2_MS,
};
