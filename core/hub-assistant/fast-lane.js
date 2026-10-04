'use strict';
// 快速通道：手机发来的简单问题（闲聊、常识、计算、天气汇率新闻等实时信息）直接交给百炼快速模型
// （强制联网搜索、流式），约 1 秒出答案；涉及田哥工作与 Hub 里的事一律交还完整助理。
// 2026-10-04 实测：不强制联网时实时数字会编造，所以必须 forced_search。
// 模型选 qwen3.8-flash：去掉关键词预筛后，12 道题（6 道该直答、6 道该交还）连测三轮全对，直答约 2 秒；
// qwen-flash 速度相近，但 6 道该交还的工作题全部自己编答案（如「已记录，下午三点开会」），不能当前台。
const HANDOFF = '【交给助理】';
// 明显涉及 Hub 与工作的说法直接走完整助理，不多花一次模型调用。
const WORK_RE = /会话|进展|派工|派给|新建|新开|任务|session|仿真|报告|代码|文件|项目|助理|记住|记下|关注|继续|跑完|结果|codex|claude|千问|模型|切换|合并|部署|html|ppt|群聊|工作台|账本|提醒我|交给|安排/i;

function systemPrompt({ userPrefs = '', now = new Date() } = {}) {
  const day = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return [
    `你是田哥的 AI Hub 助理的快速通道，负责当场答复简单问题。现在是${day} ${now.toTimeString().slice(0, 5)}，田哥常在江苏南通。`,
    '你能直接回答：闲聊、常识、计算、翻译，以及天气、汇率、新闻、时间这类实时信息（已开启联网搜索，数字和事实以搜索结果为准，并说明是何时何地的数据）。',
    `凡是涉及田哥的工作和 AI Hub 里的事——会话、任务进展、派工、新建或继续任务、文件、项目、代码、报告、之前让助理做的事、要记住的偏好——只输出「${HANDOFF}」，不加别的，由完整助理处理。`,
    '回答用中文口语，一到三句，先给结论，开头称呼「田哥」。遵守田哥的偏好：',
    String(userPrefs || '').replace(/^#.*$/gm, '').replace(/^>.*$/gm, '').trim().slice(0, 1500) || '（暂无）',
  ].join('\n');
}

class FastLane {
  constructor({ credentials, fetchImpl = fetch, model = 'qwen3.8-flash', timeoutMs = 6000 } = {}) {
    this.credentials = credentials; this.fetch = fetchImpl; this.model = model; this.timeoutMs = timeoutMs;
  }
  eligible(text) { const t = String(text || '').trim(); return !!t && t.length <= 300 && !WORK_RE.test(t); }
  // 返回 {handoff:true}（交还完整助理）或 {text, model, ms, firstMs}；出错由调用方回退到完整助理。
  async answer(question, { history = [], userPrefs = '', now = new Date() } = {}) {
    const { key, base } = this.credentials();
    const messages = [{ role: 'system', content: systemPrompt({ userPrefs, now }) }];
    for (const row of history.slice(-6)) if (row?.text) messages.push({ role: row.role === 'user' ? 'user' : 'assistant', content: String(row.text).slice(0, 400) });
    messages.push({ role: 'user', content: String(question) });
    const started = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let text = '', firstMs = null;
    try {
      const response = await this.fetch(base + '/compatible-mode/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: this.model, stream: true, enable_thinking: false, enable_search: true, search_options: { forced_search: true, search_strategy: 'turbo' }, messages }),
      });
      if (!response.ok) throw new Error('快速通道请求失败（' + response.status + '）');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (data === '[DONE]') continue;
          let delta = ''; try { delta = JSON.parse(data).choices?.[0]?.delta?.content || ''; } catch {}
          if (!delta) continue;
          if (firstMs === null) firstMs = Date.now() - started;
          text += delta;
          // 一看到交还标记就停，不白等后面的输出。
          if (text.includes(HANDOFF)) { controller.abort(); return { handoff: true, ms: Date.now() - started }; }
        }
      }
    } finally { clearTimeout(timer); }
    const clean = text.trim();
    if (!clean || clean.includes(HANDOFF)) return { handoff: true, ms: Date.now() - started };
    return { text: clean, model: this.model, ms: Date.now() - started, firstMs };
  }
}
module.exports = { FastLane, HANDOFF, systemPrompt, WORK_RE };
