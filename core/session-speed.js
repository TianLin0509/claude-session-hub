'use strict';
const pendingSpeedSwitches = new Set();

// Explicit model ids only: /fast on can promote an unsupported Claude model.
function claudeSupportsFast(model) {
  return /^(?:claude-)?opus-(?:5|4[.-]8)(?:-\d{8})?(?:\[1m\])?$/i.test(String(model || ''));
}

function speedControl(session, tuning) {
  const kind = String(session?.kind || '').replace(/-resume$/, '');
  const native = kind === 'codex' && session.runtimeBackend === 'codex-app-server';
  const claude = kind === 'claude' && claudeSupportsFast(session.currentModel?.id);
  const supported = native && tuning?.fromCache && tuning.supportsFast;
  const visible = !!(supported || claude || (native && (!tuning?.fromCache || session.codexSpeedTier === 'fast')));
  const tier = native ? session.codexSpeedTier : session?.fastMode === false ? 'standard' : 'fast';
  const label = {fast:'Fast',standard:'标准',inherit:'跟随配置',flex:'Flex'}[tier] || '速度';
  return {visible, label, tier, kind, interactive:!!(supported || claude)};
}
module.exports = {claudeSupportsFast, speedControl, pendingSpeedSwitches};
