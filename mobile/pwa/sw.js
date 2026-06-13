'use strict';

// 极简 Service Worker：
// - 缓存静态资源（首屏离线打开）
// - stale-while-revalidate：先回 cache 命中再后台更新，shell 资源命中即 0ms
// - 不缓存 /api/* 和 /pwa /agent WSS（这些是动态的）
// - 不缓存带 query string 的 URL（cache-bust 参数等，防止 cache 体积无限增长）
//
// 升级策略（v25 起改受控）：
// - 旧版（v24-）install 末尾 self.skipWaiting() + activate self.clients.claim()
//   → 新 SW 装上立即抢占所有 tab，正在使用的会话会被新代码 hijack
//   → 症状：modal 样式半破、artifact 预览乱码、WSS 重连失败
// - 新版改成：install 完成后只 postMessage 通知 client（『新版本就绪，点刷新』），
//   等用户主动点 → client 发回 SKIP_WAITING → SW 切换 → controllerchange → location.reload。
// - 离线兜底：cache miss + 网络挂时，导航请求返回 /offline.html（中文 + 重试按钮）。

const CACHE_NAME = 'hub-mobile-v110';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/vendor/xterm/xterm.css',
  '/vendor/xterm/xterm.js',
  '/vendor/xterm/addon-fit.js',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL);
    } catch (_) { /* 缓存失败不阻塞，运行时 fetch 兜底 */ }
    // 不再 self.skipWaiting()；改为通知所有当前 client：『新版就绪，等用户点刷新』
    // includeUncontrolled: true → 首次安装时还没 controller 也能拿到
    try {
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const c of clients) {
        try { c.postMessage({ type: 'SW_INSTALLED', version: CACHE_NAME }); } catch (_) {}
      }
    } catch (_) {}
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  // 不再 self.clients.claim()；让现有 tab 继续用旧 SW，直到用户主动 reload。
});

// 接收 client 主动点的 "现在刷新" → 才 skipWaiting
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ============================================================
// T11 Web Push (v0.5.5)
// ============================================================
// 后台/锁屏场景：用户问完锁屏，AI 回完时 standalone PWA 已被系统 freeze WSS。
// 走 OS notification 救场——hub-bridge 通过 VAPID + Push Service POST 通知，
// SW 唤醒 → showNotification → 用户点击 → openWindow('/?sid=...') → app.js
// 启动时读 ?sid 自动 switchSession。
//
// iOS 16.4+ 仅 standalone（"加入主屏"）模式有效。Android/鸿蒙 ArkWeb 直接生效。

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    try { data = { title: 'Claude 回复了', body: event.data ? event.data.text().slice(0, 80) : '' }; } catch {}
  }
  const title = data.title || 'Claude 回复了';
  const body = data.body || '';
  const sid = data.sid || '';
  // tag = sid → 同一会话连续推会合并替换（不堆积通知）
  const options = {
    body,
    tag: sid || 'hub-mobile',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { sid, seq: data.seq, ts: data.ts },
    // 在 Android 上长按可见 action；iOS 暂不渲染
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sid = event.notification.data && event.notification.data.sid;
  const url = sid ? `/?sid=${encodeURIComponent(sid)}` : '/';
  event.waitUntil((async () => {
    try {
      // 优先 focus 已打开的 tab（同源即可，path 不要求一致）
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of wins) {
        try {
          // 通知现有 client 切到该 sid（无需 reload）
          c.postMessage({ type: 'OPEN_SESSION', sid });
          if ('focus' in c) { await c.focus(); return; }
        } catch (_) {}
      }
      // 没找到 → 新开窗口
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    } catch (_) { /* swallow */ }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Chrome/Firefox 在 subscription rotation 时触发；让前端重新 subscribe
  event.waitUntil((async () => {
    try {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of wins) {
        try { c.postMessage({ type: 'PUSH_SUB_CHANGED' }); } catch {}
      }
    } catch (_) {}
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 跳过 API/WSS 升级路径 + AI Daily mini-app（705MB 视频不能进 PWA cache）
  if (url.pathname.startsWith('/api/') || url.pathname === '/pwa' || url.pathname === '/agent' ||
      url.pathname.startsWith('/ai-daily/')) {
    return;
  }
  // GET 请求才走缓存
  if (event.request.method !== 'GET') return;

  // stale-while-revalidate：cache 命中立即返回（~0ms），后台 fetch 更新 cache
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    const networkPromise = fetch(event.request).then(async (resp) => {
      // 只写：成功响应 + same-origin basic 类型 + 无 query string（防 cache-bust 污染）
      if (resp && resp.ok && resp.type === 'basic' && !url.search) {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, resp.clone());
        } catch (_) { /* cache quota 满等错误静默 */ }
      }
      return resp;
    }).catch(() => null);

    // cache 有就立即返回（不 await 网络），后台更新
    if (cached) {
      event.waitUntil(networkPromise);
      return cached;
    }
    // cache 没有就等网络
    const fresh = await networkPromise;
    if (fresh) return fresh;
    // 都失败：最后再试一次 cache（防竞态）
    const retry = await caches.match(event.request);
    if (retry) return retry;
    // 离线兜底：导航请求（HTML 页面）回 /offline.html，让用户看到中文提示 + 重试按钮
    // 非导航资源（CSS/JS/图片）直接 Response.error()，保持原行为
    if (event.request.mode === 'navigate' ||
        (event.request.headers.get('accept') || '').includes('text/html')) {
      const offline = await caches.match('/offline.html');
      if (offline) return offline;
    }
    return Response.error();
  })());
});
