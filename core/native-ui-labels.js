'use strict';
function nativeUiLabel(session) {
  return session?.runtimeBackend==='acp'
    ? require('./ai-kinds').getKindLabel(String(session.kind || '').replace(/-resume$/,''))
    : 'Codex';
}
function nativeOpeningBanner(session) {
  return session?.runtimeBackend==='acp'
    ? `${nativeUiLabel(session)} 已连接，请在 Hub 输入框发送。`
    : 'Codex 已连接。请使用 Hub 输入框发送消息。';
}
module.exports={nativeUiLabel,nativeOpeningBanner};
