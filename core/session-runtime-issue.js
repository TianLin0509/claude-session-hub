'use strict';
const { getSessionRuntimeTruth } = require('./session-runtime-truth');
const { hasStreamDisconnectIssue } = require('./stream-disconnect');

// Attention is a projection, not another runtime state writer. In particular a
// disconnected native runtime remains unknown until the provider reconciles it.
function sessionRuntimeIssue(session, truth = getSessionRuntimeTruth(session)) {
  if (!session || session.status === 'dormant' || truth.state === 'dormant') return null;
  if (truth.state === 'failed') return { label:'运行异常', message:truth.evidence || truth.reason || session.lastError || '本轮执行失败' };
  if (hasStreamDisconnectIssue(session)) return { label:'连接异常', message:session.connectionIssue.message || '连接已中断' };
  const native = session.nativeRuntime;
  if (native?.connection === 'disconnected' && native.state !== 'interrupted' && !session._resumePending) {
    return { label:'连接异常', message:native.reason || '连接已断开，状态待核对' };
  }
  if (native?.submission?.status === 'unknown' || native?.submission?.sendStatus === 'unknown' || native?.cancellation?.status === 'unknown') {
    return { label:'状态待核对', message:native.reason || '提交或停止操作尚未获得原生确认' };
  }
  return null;
}
module.exports = { sessionRuntimeIssue };
