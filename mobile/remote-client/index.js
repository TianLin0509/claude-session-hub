'use strict';

// 远程模式入口（公司电脑侧）。
// main.js 启动时无条件调用 startRemoteClient()——未配置时它是惰性的（不连接），
// 配置存在（${dataDir}/remote-hub.json 有 deviceToken）则自动连接。
// renderer 通过 IPC 操作；事件经 sendToRenderer('remote-event', ...) 单通道推送。

const { RemoteHubClient } = require('./remote-hub-client');

function startRemoteClient({ getHubDataDir, sendToRenderer, logger = console }) {
  const dataDir = getHubDataDir();
  const client = new RemoteHubClient({ dataDir, logger });

  // ---- 事件 → renderer（单通道，kind 区分） ----
  const push = (kind, payload) => {
    try { sendToRenderer('remote-event', { kind, payload }); } catch {}
  };
  client.on('status', (s) => push('status', s));
  client.on('hub-list', (hubs) => push('hub-list', hubs));
  client.on('session-list', (sessions) => push('session-list', sessions));
  client.on('turn', (turn) => push('turn', turn));
  client.on('session-created', (msg) => push('session-created', msg));
  client.on('session-destroyed', (msg) => push('session-destroyed', msg));
  client.on('hub-snapshot', (snapshot) => push('hub-snapshot', snapshot));
  client.on('hub-delta', (msg) => push('hub-delta', msg));
  client.on('pty-snapshot', (msg) => push('pty-snapshot', msg));
  client.on('pty-data', (msg) => push('pty-data', msg));
  client.on('pty-ack', (msg) => push('pty-ack', msg));
  client.on('error', (msg) => push('remote-error', msg));
  client.on('auth-failed', () => push('auth-failed', {}));

  // ---- IPC handlers ----
  try {
    const { ipcMain } = require('electron');
    const handle = (ch, fn) => {
      ipcMain.removeHandler && ipcMain.removeHandler(ch);
      ipcMain.handle(ch, fn);
    };

    handle('remote-get-status', () => client.status());

    handle('remote-pair', async (_e, { gatewayUrl, pin, deviceName, directIp }) => {
      try {
        await client.pair({ gatewayUrl, pin, deviceName, directIp });
        client.connect();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    handle('remote-connect', () => ({ ok: client.connect() }));
    handle('remote-disconnect', () => { client.disconnect(); return { ok: true }; });

    handle('remote-set-target-hub', (_e, { hubId }) => {
      client.setTargetHub(hubId);
      client.requestSessionList();
      return { ok: true };
    });

    handle('remote-refresh', () => {
      client.requestHubList();
      client.requestSessionList();
      client.requestHubSnapshot();
      return { ok: true };
    });

    handle('remote-desktop-snapshot', () => ({ ok: client.requestHubSnapshot() }));

    handle('remote-send-command', async (_e, { targetType, targetId, content }) => {
      try {
        const ack = await client.sendCommand(targetType, targetId, content);
        return { ok: true, queued: !!ack.queued };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // ---- 终端镜像（Phase 2）----
    handle('remote-pty-subscribe', (_e, { sessionId, sinceSeq }) => ({ ok: client.subscribePty(sessionId, sinceSeq || 0) }));
    handle('remote-pty-unsubscribe', (_e, { sessionId }) => ({ ok: client.unsubscribePty(sessionId) }));
    handle('remote-pty-input', (_e, { sessionId, dataB64 }) => ({ ok: client.sendPtyInput(sessionId, dataB64) }));
    handle('remote-pty-resize', (_e, { sessionId, cols, rows }) => ({ ok: client.resizePty(sessionId, cols, rows) }));

    handle('remote-new-session', async (_e, { kind, title }) => {
      try {
        const msg = await client.newSession(kind, title);
        return { ok: true, session: msg.session || null };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    handle('remote-send-input', (_e, { sessionId, content }) => {
      const sent = client.sendInput(sessionId, content);
      return { ok: sent, error: sent ? null : 'not connected' };
    });

    handle('remote-destroy-session', (_e, { sessionId }) => {
      const sent = client.destroySession(sessionId);
      return { ok: sent, error: sent ? null : 'not connected' };
    });
  } catch (e) {
    logger.warn(`[remote-hub] IPC register failed: ${e.message}`);
  }

  // 已配置 → 自动连接
  if (client.isConfigured()) {
    logger.log('[remote-hub] config found, auto-connecting');
    client.connect();
  } else {
    logger.log('[remote-hub] not configured (idle)');
  }

  return client;
}

module.exports = { startRemoteClient };
