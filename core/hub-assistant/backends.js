'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ALL_AI_KINDS, isCodexCliKind, getKindLabel } = require('../ai-kinds');
const BACKENDS = [...ALL_AI_KINDS];
function backendKind(kind) {
  if (!BACKENDS.includes(kind)) throw new Error('请选择 Hub 支持的 AI 会话后端');
  return kind;
}
function bindings(store) {
  const saved = store.get('backendSessions') || {};
  const old = store.get('sessionId');
  if (old && !Object.values(saved).includes(old)) saved[store.get('backendKind') || 'codex'] = old;
  return saved;
}
function reserve(store, kind, id) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = bindings(store);
    if (rows[kind] && rows[kind] !== id) throw new Error('助理创建已由另一请求预留，请重新读取助理状态');
    rows[kind] = id;
    store.set('backendSessions', rows);
    store.set('backendCreation:' + kind, {id, state:'reserved', createdAt:Date.now()});
    // Preserve the first-use reservation contract. A failed switch leaves the
    // previously active identity untouched; retries reconcile the new id only.
    if (!store.get('sessionId')) {
      store.set('sessionId', id); store.set('backendKind', kind);
      store.set('assistantCreation', {id, state:'reserved', createdAt:Date.now()});
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
function activate(store, kind, id) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (bindings(store)[kind] !== id) throw new Error('助理后端身份未预留');
    store.confirmAssistant(id);
    store.set('backendCreation:' + kind, {id, state:'confirmed', confirmedAt:Date.now()});
    store.set('backendKind', kind); store.set('sessionId', id);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
function launchOptions(service, kind, id) {
  return { ...providerLaunchOptions(service, kind, id), noInheritCursor: true };
}
// 助理常在没有界面终端的情况下由手机驱动（含按新模型重启后），ConPTY 不能等界面回应光标查询。
function providerLaunchOptions(service, kind, id) {
  const entry = service.getMcpEntry(id);
  if (isCodexCliKind(kind)) return {mcpProfile:'lean', codexMcpEntries:[entry]};
  if (require('../acp-profiles').isAcpKind(kind)) return {mcpProfile:'lean', assistantMcpServers:[{
    name:entry.name,command:entry.command,args:entry.args,
    env:Object.entries(entry.env).map(([name,value])=>({name,value}))
  }]};
  if (kind === 'gemini' || kind === 'kimi') return {mcpProfile:'lean', assistantMcpEntry:entry};
  const file = path.join(service.deps.dataDir, 'assistant', 'claude-' + id + '-mcp.json');
  const {command, args, env} = entry;
  fs.writeFileSync(file + '.tmp', JSON.stringify({mcpServers:{hub_assistant:{command,args,env}}}), {mode:0o600});
  fs.renameSync(file + '.tmp', file);
  // Dedicated assistant only. Hub still checks host identity and the current
  // user-request token on every management operation.
  return {mcpProfile:'lean', mcpConfigFile:file, autonomous:true};
}
module.exports = {BACKENDS, backendKind, bindings, reserve, activate, launchOptions, getKindLabel};
