// 临时 E2E 脚本: 用 CDP 注入 3 张场景卡, 截图存盘
// 用法: node .tmp-e2e/snap-scene-cards.js
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9224;
const OUT_DIR = path.resolve(__dirname, 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson(`http://localhost:${PORT}/json`);
  const page = targets.find(t => t.type === 'page' && t.title === '圆桌');
  if (!page) throw new Error('page target not found');
  console.log('connecting:', page.webSocketDebuggerUrl);

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let id = 0;
  const pending = new Map();
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(msg.error) : resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  // 三个场景 inject 同一份样式 + 不同卡片渲染
  // 用 _scenes 的 SCENE_REGISTRY + 我们刚加的 _renderSceneOnboardingCard 逻辑
  // 由于 _renderSceneOnboardingCard 是 closure 内部 function, 没暴露到 window
  // 所以直接复刻逻辑(代码已在 meeting-room.js, 这里只测视觉)
  const scenes = ['general', 'research', 'dev'];
  for (const scene of scenes) {
    console.log(`--- rendering ${scene} ---`);

    // 清掉历史 LS 标记 + 注入卡片到一个独立的预览容器
    const exprResult = await send('Runtime.evaluate', {
      expression: `
        (function() {
          // 清 LS 让卡片显示
          try {
            localStorage.removeItem('hub-general-scenario-onboarding-dismissed-v1');
            localStorage.removeItem('hub-research-scenario-onboarding-dismissed-v1');
            localStorage.removeItem('hub-dev-scenario-onboarding-dismissed-v1');
          } catch {}

          // 内联复刻 SCENE_ONBOARDING_CONTENT (与 meeting-room.js 同步)
          const content = {
            general: {
              head: '🎯 通用圆桌 · 使用提示',
              bullets: [
                '三家平等给观点，不预设领域；技术辩论、代码评审、开放讨论都行。',
                '默认提问 → 三家并行；输入"<strong>@debate</strong>"触发辩论；工具栏"<strong>🗒 摘要</strong>"让上家浓缩五元组，"<strong>📝 总结</strong>"让指定 AI 综合所有轮次。',
                '想点名某家：用"<strong>@pikachu / @charmander / @squirtle</strong>"指定发言人。',
                '圆桌产物是<strong>可讨论的判断</strong>，不是研报或可执行方案。需要落地操作时，结论里会建议你切独立 session 实操。',
              ],
            },
            research: {
              head: '📊 投研圆桌 · 使用提示',
              bullets: [
                '三家偏置已固化：<strong>Pikachu</strong> 对抗硬度派（最尖锐空头）/ <strong>Charmander</strong> 反直觉校验派（找盲点）/ <strong>Squirtle</strong> 极简克制派（快速初筛）。',
                '输入个股代码 / 问题即可；三家会自动调 LinDangAgent 拿最新数据，从基本面 + 资金面 + 技术面 + 情绪面给观点。',
                '结论必走 <strong>4 档</strong>（强烈推荐 / 可买需条件 / 不建议买 / 强烈回避），不允许"建议关注 / 可跟踪"等模糊话术。',
                '想跳过首轮反问，直接输入"<strong>直接分析</strong>"；想看深度推演（含对手盘 + 预期差分层），输入"<strong>@深度</strong>"。',
              ],
            },
            dev: {
              head: '🛠️ 开发圆桌 · 使用提示',
              bullets: [
                '三家先帮你问清需求、讨论方案，默认只交给 1 个 Driver 实操。',
                '你可以跳过问题；跳过项会在交接单里作为默认假设回显。',
                '需要交接时输入"<strong>生成交接单</strong>"；Driver 改完后输入"<strong>帮我审一下</strong>"。',
                '如需一对一深聊，可切主驾模式手动使用 superpowers brainstorm skill。',
              ],
            },
          };
          const c = content['${scene}'];
          const bulletsHtml = c.bullets.map(b => '<li>' + b + '</li>').join('');
          const cardHtml = '<div class="mr-rt-scene-card" style="max-width:780px;margin:40px auto;">' +
            '<div class="mr-rt-scene-card-head">' + c.head + '</div>' +
            '<ul class="mr-rt-scene-card-body">' + bulletsHtml + '</ul>' +
            '<div class="mr-rt-scene-card-actions">' +
              '<button class="mr-rt-scene-card-btn">我知道了</button>' +
              '<button class="mr-rt-scene-card-btn mr-rt-scene-card-btn-secondary">不再显示</button>' +
            '</div>' +
          '</div>';

          // 替换 body 内容做纯卡片预览
          document.body.innerHTML = cardHtml;
          document.body.style.background = '#0d1117';
          return 'INJECTED_${scene}';
        })()
      `,
      returnByValue: true,
    });
    console.log('eval:', exprResult.result.value);

    // 等一帧渲染
    await new Promise(r => setTimeout(r, 250));

    // 截图
    const shotResult = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const filePath = path.join(OUT_DIR, `scene-card-${scene}.png`);
    fs.writeFileSync(filePath, Buffer.from(shotResult.data, 'base64'));
    console.log('saved:', filePath);
  }

  ws.close();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
