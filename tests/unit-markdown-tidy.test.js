'use strict';
// 中文加粗宽容处理：成对 ** 即加粗（标点紧贴星号也算），代码里不动，不成对的星号原样保留；
// 经与 Hub 相同的「原始 HTML 转义」marked 渲染后，只有加粗变成 <strong>，其余尖括号文字不丢。
const {test}=require('node:test'),assert=require('node:assert/strict');
const {tidyMarkdown,restoreBold,OPEN,CLOSE}=require('../core/hub-assistant/markdown-tidy');
const {Marked}=require('marked');
const hubMarked=new Marked({renderer:{html(token){return String(token.text??token.raw??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}}});
const render=t=>restoreBold(hubMarked.parse(tidyMarkdown(t),{breaks:true,gfm:true})).trim();
test('CJK bold next to punctuation renders as bold; code and stray asterisks untouched',()=>{
 assert.equal(tidyMarkdown('**注意：**这里要改'),OPEN+'注意：'+CLOSE+'这里要改');
 assert.equal(tidyMarkdown('`**不动**` 和 **动**'),'`**不动**` 和 '+OPEN+'动'+CLOSE);
 assert.equal(tidyMarkdown('```\n**代码里不动**\n```'),'```\n**代码里不动**\n```');
 assert.equal(tidyMarkdown('a ** b ** c'),'a ** b ** c');
 assert.equal(render('**注意：**这里要改'),'<p><strong>注意：</strong>这里要改</p>');
 assert.equal(render('结论是**通过**。'),'<p>结论是<strong>通过</strong>。</p>');
 assert.equal(render('**整句加粗，以句号结尾。**'),'<p><strong>整句加粗，以句号结尾。</strong></p>');
 assert.match(render('把 <文件名> 发我，**好**'),/&lt;文件名&gt;.*<strong>好<\/strong>/,'literal angle brackets are kept');
});
