'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inspectPasteText}=require('../renderer/paste-text-encoding');
const corrupt='Ìï¸ç£¬Õâ´ÎÈÔ±» Hub À¹×¡£¬ÐÂ Codex »á»°Ã»ÓÐ´´½¨£¬¹¥ÂÔÉÐÎ´¿ªÊ¼ÖÆ×÷¡£';
const expected='田哥，这次仍被 Hub 拦住，新 Codex 会话没有创建，攻略尚未开始制作。';
test('screenshot GBK Western corruption is recovered without changing mixed Unicode',()=>{
  const source='正常中文🙂\n'+corrupt+'\n另一个问题';
  const result=inspectPasteText(source);
  assert.equal(result.original,source);assert.equal(result.restored,'正常中文🙂\n'+expected+'\n另一个问题');
});
test('UTF8 Western corruption can be proposed while preserving ASCII identifiers',()=>{
  const text='手机界面中文输入，保留 Codex 与 CLAUDE 的名字。';
  const bad=new TextDecoder('windows-1252').decode(Buffer.from(text,'utf8'));
  assert.equal(inspectPasteText(bad)?.restored,text);
});
test('normal Chinese, Japanese, accented prose, code, short samples and broken bytes stay untouched',()=>{
  for(const text of ['中文🙂\r\n换行与代码 C:\\项目\\文件.md','日本語の入力テストです。','François, naïve café; déjà vu!','£12.50, © 2026, ±2°, 80%','const example = "Ìï"; // test','Ìï¸ç','Õâ´ÎÈÔ±»\ufffd Hub','正常的模型：Claude，项目：AI Hub']) {
    assert.equal(inspectPasteText(text),null,text);
  }
});
