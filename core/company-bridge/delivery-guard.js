'use strict';
// 把对端的回执送进本机会话时的兜底（2026-10-18，家里 v1.6.517 真机 Q-1018-07）：
// 第 1 轮回执里有 9 个制表符，粘进 Claude 后变成了空格；发送入口按「提交内容和原文只差空白」报 content-mismatch
// （ok:false，不带 unconfirmed / stuck，也不带 error），投递方当成「明确没发进去」，每 60 秒重投一次，
// 会话里实际已经收到 6 份同样的回执，第 2 轮也早发出去了。根因在发送入口对 content-mismatch 的口径
// （受保护链路 core/pty-prompt-submit.js / prompt-submission-receipts.js，先不改），这里在投递方兜底：
//   1. content-mismatch = 内容已进会话（只差空白），按已送达处理、标「有出入」，不再重投；
//   2. 重投前先看目标会话的原生记录里有没有这条回执（按编号 + 轮次标记），有就直接标已送达；
//   3. 同一线程已经从这个会话发出了更晚的一轮：更早的轮次标已送达（Agent 显然已经看到并接着问了）；
//   4. 明确失败最多重投 3 次，之后停止，列表里标「可能已送达，未能确认」。
// 家里收公司回执（home.js）与公司收家里回复（ask-home.js）共用。
const fs = require('node:fs');

const MAX_DELIVERY_FAILURES = 3;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

// 发送入口的回执是不是「明确没发进去」：没回执、notSent、ok:false 且不是确认迟到 / 卡住 / 只差空白。
function contentArrivedWithDiff(receipt) { return !!receipt && receipt.sendStatus === 'content-mismatch' && !receipt.notSent; }
function explicitFailure(receipt) {
  if (!receipt || receipt.notSent) return true;
  if (contentArrivedWithDiff(receipt)) return false;
  return receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck';
}

// 会话的原生记录文件：Claude / CodeAgent 是绑定的 transcriptPath；Codex 按 codexSid 找 rollout。找不到返回 null。
function transcriptFile(meta) {
  if (!meta) return null;
  if (meta.transcriptPath) return meta.transcriptPath;
  if (meta.codexSid) {
    try {
      const parser = require('../codex-transcript-parser');
      return meta.codexSessionsRoot ? parser.findCodexRolloutBySid(meta.codexSid, meta.codexSessionsRoot) : parser.findCodexRolloutBySid(meta.codexSid);
    } catch { return null; }
  }
  return null;
}
// 原生记录里有没有一条「用户发来的消息」含这段文字（Agent 自己的回答里引用了标记不算）：true / false / null（没有记录可查）。
// Claude / CodeAgent 是 "type":"user"，Codex rollout 是 "role":"user" 或 "type":"user_message"。只看最后 16 MB。
const USER_LINE = /"type"\s*:\s*"user(?:_message)?"|"role"\s*:\s*"user"/;
function transcriptHasText(meta, needle, fsModule = fs) {
  const file = transcriptFile(meta);
  if (!file || !needle) return null;
  try {
    const size = fsModule.statSync(file).size;
    let text;
    if (size <= MAX_SCAN_BYTES) text = fsModule.readFileSync(file, 'utf8');
    else {
      const fd = fsModule.openSync(file, 'r');
      try { const buf = Buffer.alloc(MAX_SCAN_BYTES); fsModule.readSync(fd, buf, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES); text = buf.toString('utf8'); }
      finally { fsModule.closeSync(fd); }
    }
    return text.split('\n').some(line => line.includes(needle) && USER_LINE.test(line));
  } catch { return null; }
}

// 投递前的核对：不用再投时返回要落下的字段，否则 null。marker 是回执开头的「【… 编号 · 第 N 轮」。
function alreadyDelivered(t, r, { meta, marker, now, hasText = transcriptHasText }) {
  if (t.rounds.some(x => x.round > r.round && x.sentAt)) {
    return { delivered: true, deliveredAt: null, deliveryError: null, deliveryNote: `这个会话已经就同一编号发出了第 ${Math.max(...t.rounds.map(x => x.round))} 轮，按已送达处理` };
  }
  if (hasText(meta, marker) === true) return { delivered: true, deliveredAt: now, deliveryError: null, deliveryNote: '会话的原生记录里已有这条回执，按已送达处理' };
  return null;
}
// 明确没发进去：记次数；到上限就停，标「可能已送达，未能确认」。返回 { patch, final }。
function failure(r, message) {
  const n = (Number(r.deliveryFailures) || 0) + 1;
  if (n >= MAX_DELIVERY_FAILURES) {
    return { final: true, patch: { delivered: true, deliveredAt: null, deliveryFailures: n, deliveryUnconfirmed: true,
      deliveryError: `可能已送达，未能确认（发送入口连续 ${n} 次报没发进去：${message}）；停止自动重投` } };
  }
  return { final: false, patch: { deliveryError: message, deliveryFailures: n } };
}
// 发送入口报「只差空白」：内容已进会话。
const MISMATCH_NOTE = '内容已进会话（和原文只差空白字符，如制表符被换成空格）';

module.exports = { MAX_DELIVERY_FAILURES, explicitFailure, contentArrivedWithDiff, transcriptFile, transcriptHasText, alreadyDelivered, failure, MISMATCH_NOTE };
