'use strict';
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');

// A narrow action-command recognizer, not a general natural-language authority
// model or an OS sandbox. Ambiguous/read-only wording stays read-only.
function actionIntent(text, type) {
  const original = String(text || '').trim();
  if (/(发送过什么|发送过哪些|创建过什么|创建过哪些|做过什么|做过哪些|要多久|需要多久|是什么意思|有什么区别|有何区别|有哪些步骤|有什么风险|安全吗|靠谱吗|可行吗|了吗|了么|了没|过吗)[？?。\s]*$/.test(original)) return false;
  // An action mentioned inside a prerequisite/advisability question is still
  // discussion, even when its opening words look like an imperative.
  if (/(?:之前|以前|前)[，,\s]*(?:还)?(?:有什么|有哪些|需要确认什么|需要注意什么|需要哪些|要确认什么|要注意什么)/.test(original)) return false;
  if (/(?:(?:是否|是不是|会不会)(?:更|不|有必要|太)?(?:合适|妥当|合理|可行|安全|可靠|必要|值得)|(?:合适|妥当|合理|必要|值得)(?:吗|么)|(?:好不好|该不该|应不应该|要不要))[？?。\s]*$/.test(original)) return false;
  let command = original;
  for (let i = 0; i < 10; i++) {
    const next = command.replace(/^(?:田哥[，,\s]*|我想让你|我希望你|我需要你|你能不能|你能否|你帮我|请你|能不能|可不可以|可以|能否|请|麻烦你|麻烦|帮我|帮忙|替我|现在|立刻|马上|先|我想要|我希望|我需要|我想)\s*/, '');
    if (next === command) break;
    command = next;
  }
  if (/(不要|别|禁止|不必|无需|不想|不需要|不允许|不能|暂不|先不|暂停|停止)/.test(command)) return false;
  if (type === 'create') return /^(新建|创建|启动|开一个|开个).{0,30}(会话|session|任务)/i.test(command);
  return /^(发送|转交|派发|下达)\s*\S|^让.{1,100}(继续|恢复|开始|执行|完成)|^(继续|恢复)\s*\S|^把.{1,150}(发给|发送给|转交给|派发给)/i.test(command);
}

function requireAuthorizedTarget(current, action, sessions) {
  if (!actionIntent(current.text, action.type)) throw new Error('本轮未明确委托执行此操作；回顾、提问及否定要求只读取');
  if (action.type !== 'send') return;
  const target = sessions.find(s => s.id === action.targetSessionId);
  if (!target) throw new Error('目标会话未打开，请先定位目标');
  // Explicit stable ID removes title ambiguity; a same-name session does not.
  if (String(current.text).includes(target.id)) return;
  const title = String(target.title || target.name || '');
  if (title.length < 2 || !String(current.text).includes(title)) throw new Error('本轮委托未绑定这个目标，请使用会话完整标题或 ID');
  if (sessions.filter(s => String(s.title || s.name || '') === title).length !== 1) throw new Error('存在同名会话，请使用准确会话 ID 指定目标');
}

function bindOperation(store, current, operationKey, action) {
  const key = String(operationKey || '');
  if (!key || key.length > 120) throw new Error('缺少有效 operationKey');
  const payload = action.type === 'send'
    ? { type: 'send', targetSessionId: action.targetSessionId, text: action.text }
    : { type: 'create', title: action.title, text: action.text };
  const encoded = JSON.stringify(payload), fingerprint = digest(encoded);
  const intentId = digest(`${current.id}:payload:${encoded}`);
  const bindingKey = `operation:${digest(`${current.id}:key:${key}`)}`;
  const createKey = `create-operation:${digest(String(current.id))}`;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const old = store.get(bindingKey);
    if (old && old.fingerprint !== fingerprint) throw new Error('同一 operationKey 已绑定不同任务内容，未重复派发');
    if (action.type === 'create') {
      const reserved = store.get(createKey);
      if (reserved && reserved.fingerprint !== fingerprint) throw new Error('本轮已有新建任务；首版每轮创建一个会话，新增任务请另发要求');
      if (!reserved) store.set(createKey, { fingerprint, intentId });
    }
    if (!old) store.set(bindingKey, { fingerprint, intentId });
    store.db.exec('COMMIT');
    return old?.intentId || intentId;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
module.exports = { actionIntent, requireAuthorizedTarget, bindOperation };
