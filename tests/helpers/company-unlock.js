'use strict';
// 公司版「AI特战队专用功能」的隐藏入口（2026-10-15）：设置菜单开着时在键盘上敲出口令才出现。
// 口令原文不进仓库：测试从本机环境变量 HUB_UNLOCK_PHRASE 读。用 CDP 发真实按键，和人在键盘上敲一样。
function unlockPhrase() {
  const phrase = process.env.HUB_UNLOCK_PHRASE || '';
  if (!/^[a-z]+$/i.test(phrase)) throw new Error('这个测试要解锁公司版隐藏入口：请先设置环境变量 HUB_UNLOCK_PHRASE（口令不写进仓库）');
  return phrase;
}
async function typeKeys(c, text) {
  for (const ch of text) {
    const code = 'Key' + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  }
}
// 菜单要已经打开（调用方先点 #btn-options）；敲完等菜单项出现。
async function typeUnlock(c, { phrase = unlockPhrase(), timeoutMs = 10000 } = {}) {
  await typeKeys(c, phrase);
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (await c.eval('!!document.getElementById("options-home-link")')) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('敲完口令后设置菜单里没有出现「AI特战队专用功能」');
}

module.exports = { unlockPhrase, typeKeys, typeUnlock };
