'use strict';
const OPEN = '[AI_HUB_ASSISTANT_CONTEXT_V1]';
const CLOSE = '[/AI_HUB_ASSISTANT_CONTEXT_V1]';

// Display projection only. Native text, receipt identity and stored records stay intact.
function assistantContextDisplay(text, purpose) {
  if (purpose !== 'hub-assistant' || typeof text !== 'string') return null;
  const rawText=text;
  // Claude's real PTY transcript wraps long bracketed pastes. Only unwrap one
  // complete native wrapper; surrounding user prose remains visible intact.
  const pasted=text.match(/^\s*<pasted_content(?:\s+id="[^"<>]*")?>\s*([\s\S]*?)\s*<\/pasted_content>\s*$/);
  if(pasted)text=pasted[1];
  if(!text.startsWith(OPEN))return null;
  const end = text.lastIndexOf(CLOSE);
  if (end < 0) return null;
  const json = text.slice(OPEN.length, end).trim();
  // Use the complete JSON object, not a delimiter split within userText. The
  // native terminal may normalize envelope CR/LF while retaining JSON escapes.
  const suffix = text.slice(end + CLOSE.length);
  if (suffix && !/^\s*本轮工具委托 requestToken：[0-9a-f-]+\s*$/i.test(suffix)) return null;
  try {
    const data = JSON.parse(json);
    if (!data || typeof data.userText !== 'string' || typeof data.role !== 'string'
      || !data.sessions || !Array.isArray(data.sessions.sessions)
      || !data.history || typeof data.history !== 'object' || Array.isArray(data.history)) return null;
    return { userText: data.userText, rawText };
  } catch { return null; }
}

module.exports = { assistantContextDisplay };
