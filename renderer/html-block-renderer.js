'use strict';
// renderer/html-block-renderer.js
// Phase 7 / 2026-05-10：把 AI 输出的 ```html``` fenced code block 转 iframe sandbox 描述对象
// 纯函数模块，方便 Node 单测；DOM 操作在 meeting-room.js 包装层完成
// 设计参考：spec.html § 1-5（iframe sandbox + 高度桥协议）

// 桥脚本：iframe srcdoc 内自动 ResizeObserver 监听 documentElement scrollHeight 变化
// 通过 postMessage 把高度上报给 parent；parent 端 message listener 校验后设置 iframe.style.height
const HTML_BLOCK_BRIDGE = '<script>(function(){const o=new ResizeObserver(()=>{parent.postMessage({type:"rt-html-resize",height:document.documentElement.scrollHeight},"*")});o.observe(document.documentElement)})();</script>';

const DEFAULT_MAX_BYTES = 65536; // 64KB

/**
 * 把 HTML 源码字符串转为渲染描述对象。
 * @param {string} htmlText - AI 输出的 HTML 源码（来自 ```html``` 代码块的 textContent）
 * @param {object} [options]
 * @param {number} [options.maxBytes=65536] - 超此字节走降级
 * @returns {{kind:'iframe', sandbox:string, className:string, srcdoc:string} | {kind:'oversize', message:string}}
 */
function transformHtmlBlock(htmlText, options) {
  const maxBytes = (options && options.maxBytes) || DEFAULT_MAX_BYTES;
  const text = String(htmlText || '');

  if (text.length > maxBytes) {
    const sizeKB = (text.length / 1024).toFixed(1);
    const limitKBNum = maxBytes / 1024;
    // 阈值整除 1024 时显示整数（如 64KB），否则显示 1 位小数（如 1.0KB）
    const limitKB = Number.isInteger(limitKBNum) ? String(limitKBNum) : limitKBNum.toFixed(1);
    return {
      kind: 'oversize',
      message: '⚠ HTML 块过大（' + sizeKB + 'KB > ' + limitKB + 'KB），已折叠不渲染',
    };
  }

  return {
    kind: 'iframe',
    sandbox: 'allow-scripts',
    className: 'rt-html-block',
    srcdoc: HTML_BLOCK_BRIDGE + text,
  };
}

/**
 * 校验 postMessage 高度协议数据，返回应设置的 iframe 高度（像素），不合法则返回 null。
 * 协议：parent 端监听 window 'message' 事件，调用本函数判断是否要设高度。
 * @param {*} eventData - event.data
 * @returns {number|null}
 */
function decideHtmlBlockHeight(eventData) {
  if (!eventData || eventData.type !== 'rt-html-resize') return null;
  const h = Number(eventData.height);
  if (!Number.isFinite(h) || h <= 0 || h >= 8000) return null;
  return h;
}

module.exports = {
  transformHtmlBlock,
  decideHtmlBlockHeight,
  // 暴露常量供调用方/测试用
  HTML_BLOCK_BRIDGE,
  DEFAULT_MAX_BYTES,
};
