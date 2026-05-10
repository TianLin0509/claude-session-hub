'use strict';
// 临时 CDP 诊断：连 9223 看 _renderHtmlCodeBlocks 是否真的生效
const { connectCDP } = require('../tests/helpers/cdp-client');

(async () => {
  const ws = process.argv[2];
  if (!ws) { console.error('usage: node cdp-diag.js <wsUrl>'); process.exit(1); }
  const client = await connectCDP(ws);

  // 1. testing hook 是否暴露
  const hookType = await client.eval('typeof (window.__rtTesting && window.__rtTesting._renderMarkdown)');
  console.log('1. __rtTesting._renderMarkdown type:', hookType);

  // 2. 尝试 require html-block-renderer 看是否报错
  const mod = await client.eval(`(() => {
    try {
      const m = require('./html-block-renderer.js');
      return { ok: true, keys: Object.keys(m), bridgeLen: (m.HTML_BLOCK_BRIDGE || '').length };
    } catch (e) { return { ok: false, error: e.message + ' | ' + (e.stack || '').split('\\n').slice(0,3).join(' / ') }; }
  })()`);
  console.log('2. require html-block-renderer:', JSON.stringify(mod));

  // 3. 实际跑一次 _renderMarkdown，看结果是 iframe 还是 pre
  // 注意：single-quote string 里反引号 ` 不需要转义；用 + 拼接更稳妥
  const md = '```html\n<table><tr><td>hi</td></tr></table>\n```';
  const r = await client.eval(`(() => {
    const fn = window.__rtTesting && window.__rtTesting._renderMarkdown;
    if (!fn) return { error: 'no _renderMarkdown' };
    const out = fn(${JSON.stringify(md)});
    return {
      length: out.length,
      hasIframe: out.includes('<iframe'),
      hasRtHtmlBlock: out.includes('rt-html-block'),
      hasSandbox: out.includes('sandbox'),
      hasPreCode: out.includes('<pre><code'),
      preview: out.slice(0, 300),
    };
  })()`);
  console.log('3. _renderMarkdown output:', JSON.stringify(r, null, 2));

  // 4. 直接调 _renderHtmlCodeBlocks 看 selector 命中
  const selectorTest = await client.eval(`(() => {
    const fn = window.__rtTesting && window.__rtTesting._renderMarkdown;
    const out = fn(${JSON.stringify(md)});
    const div = document.createElement('div');
    div.innerHTML = out;
    return {
      htmlBlockCount: div.querySelectorAll('iframe.rt-html-block').length,
      preCodeCount: div.querySelectorAll('pre code.language-html').length,
      allCode: Array.from(div.querySelectorAll('code')).map(c => c.className).slice(0, 5),
    };
  })()`);
  console.log('4. selector breakdown:', JSON.stringify(selectorTest, null, 2));

  // 5. inspect 真实圆桌消息 DOM：找含 language-html 的现有节点 vs iframe
  const liveDom = await client.eval(`(() => {
    const allHtmlCode = document.querySelectorAll('pre code.language-html');
    const allHtmlIframe = document.querySelectorAll('iframe.rt-html-block');
    const allCodeAny = document.querySelectorAll('pre code');
    const codeByLang = {};
    allCodeAny.forEach(c => {
      const m = (c.className||'').match(/language-([\\w-]+)/);
      const lang = m ? m[1] : '(none)';
      codeByLang[lang] = (codeByLang[lang]||0) + 1;
    });
    // 拿一个含"DOCTYPE html"的节点看 outerHTML 前 300 字
    let sample = null;
    for (const c of allCodeAny) {
      if ((c.textContent||'').slice(0, 50).includes('DOCTYPE')) {
        sample = {
          parentTag: c.parentElement && c.parentElement.tagName,
          codeClass: c.className,
          parentClass: c.parentElement && c.parentElement.className,
          ancestorChain: (() => {
            const arr = []; let n = c.parentElement;
            for (let i=0; i<6 && n; i++) { arr.push(n.tagName + (n.className?'.'+n.className.split(' ')[0]:'')); n = n.parentElement; }
            return arr.join(' > ');
          })(),
          outerHTMLHead: c.outerHTML.slice(0, 200),
        };
        break;
      }
    }
    return {
      preCodeLanguageHtml: allHtmlCode.length,
      iframeRtHtmlBlock: allHtmlIframe.length,
      codeByLang,
      doctypeSample: sample,
    };
  })()`);
  console.log('5. live DOM inspect:', JSON.stringify(liveDom, null, 2));

  // 6. broader scan：count all pre / iframe / .doctype text occurrences in DOM
  const wider = await client.eval(`(() => {
    const allPre = document.querySelectorAll('pre').length;
    const allIframe = document.querySelectorAll('iframe').length;
    const allCode = document.querySelectorAll('code').length;
    const allArenaMsg = document.querySelectorAll('[class*="meeting"], [class*="message"], [class*="rt-"], [class*="card"]').length;
    const bodyText = (document.body.innerText || '').slice(0, 200);
    // 找 'DOCTYPE' / '<html lang' 字符串的 ancestor
    const html = document.documentElement.outerHTML;
    const hasDoctypeInHtml = html.includes('DOCTYPE html');
    const hasHtmlLangInHtml = html.includes('html lang=');
    return {
      allPreCount: allPre,
      allIframeCount: allIframe,
      allCodeCount: allCode,
      arenaRelatedNodeCount: allArenaMsg,
      bodyTextHead: bodyText,
      hasDoctypeStringInDOM: hasDoctypeInHtml,
      hasHtmlLangInDOM: hasHtmlLangInHtml,
    };
  })()`);
  console.log('6. wider scan:', JSON.stringify(wider, null, 2));

  await client.close();
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
