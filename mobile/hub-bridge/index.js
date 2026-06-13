'use strict';

// Hub Mobile Bridge · 入口
// 由 main.js 在 CLAUDE_HUB_MOBILE_ENABLED=true 时 require 并调用 startMobileBridge()。
// 整合：OutboundClient（WSS 连 VPS）+ PairManager（PIN/设备列表）+ SessionBinder（绑 Claude 会话）。
//
// 设计：
// - 模块崩溃不影响 Hub 主进程（外层 try/catch + 状态机隔离）
// - 配置全部走 env：CLAUDE_HUB_MOBILE_ENABLED / MOBILE_VPS_URL / MOBILE_BEARER_TOKEN
// - 持久化到 ${HubDataDir}/mobile-devices.json（不污染主 state.json）

const path = require('path');
const { OutboundClient } = require('./outbound-client');
const { PairManager } = require('./pair-manager');
const { SessionBinder, MOBILE_SESSION_ID } = require('./session-binder');
const { MeetingBinder } = require('./meeting-binder');
const { DesktopSyncBinder } = require('./desktop-sync-binder');
const { PtyMirrorBinder } = require('./pty-mirror-binder');
const { ArtifactServer } = require('./artifact-server');
const { WebPushSender } = require('./web-push-sender');
const { MSG } = require('../shared/protocol');

// 调试用 IPC：让外部探针能看 binder 内部状态（subscribers、session map 等）
function _registerDebugIpc(binder, outbound) {
  try {
    const { ipcMain } = require('electron');
    ipcMain.removeHandler && ipcMain.removeHandler('mobile-dump-state');
    ipcMain.handle('mobile-dump-state', () => {
      const subs = {};
      for (const [sid, set] of binder.sessionSubscribers.entries()) {
        subs[sid] = Array.from(set).map(t => `${t.slice(0,8)}…${t.slice(-4)}`);
      }
      return {
        mobileSessionIds: Array.from(binder.mobileSessionIds),
        sessionSubscribers: subs,
        outboundState: outbound && outbound.state,
        outboundConnected: outbound && outbound.isConnected ? outbound.isConnected() : null,
      };
    });
  } catch (e) {
    console.warn('[mobile-bridge] debug IPC register failed:', e.message);
  }
}

function startMobileBridge({ sessionManager, transcriptTap, meetingManager, dispatchGroupChatTurn, getHubDataDir, captureHubView = null, sendHubViewInput = null, logger = console }) {
  const env = process.env;
  const VPS_URL = env.MOBILE_VPS_URL;          // wss://hub-lintian.com/agent
  const BEARER_TOKEN = env.MOBILE_BEARER_TOKEN; // 长 random string
  const FIXED_PIN = env.MOBILE_FIXED_PIN || null; // 6 位数字字符串，可选
  // 可选：TCP 直连该 IP 绕过 Cloudflare 边缘（国内直连 CF 长连接被间歇重置，
  // 导致 10~30s 一次 1006 断连；SNI/证书校验仍按域名走）。例：138.128.192.245
  const DIRECT_IP = env.MOBILE_VPS_DIRECT_IP || null;

  if (!VPS_URL || !BEARER_TOKEN) {
    logger.warn('[mobile-bridge] MOBILE_VPS_URL / MOBILE_BEARER_TOKEN missing — bridge disabled');
    return null;
  }

  const dataDir = (typeof getHubDataDir === 'function') ? getHubDataDir() : path.join(require('os').homedir(), '.claude-session-hub');

  let outbound, pair, binder, artifacts, meetingBinder, desktopSync, ptyMirror, webPush;
  try {
    // T11：VAPID 密钥懒生成（第一次启动写 mobile-vapid.json）。失败不阻塞 bridge
    try {
      webPush = new WebPushSender({ dataDir, subject: 'mailto:hub@localhost', logger });
      logger.log(`[mobile-bridge] web-push ready, VAPID pub=${webPush.getPublicKey().slice(0, 16)}…`);
    } catch (e) {
      logger.warn(`[mobile-bridge] web-push init failed (push disabled): ${e.message}`);
      webPush = null;
    }
    outbound = new OutboundClient({
      url: VPS_URL,
      bearerToken: BEARER_TOKEN,
      logger,
      vapidPublicKey: webPush ? webPush.getPublicKey() : null,
      directIp: DIRECT_IP,
    });
    pair = new PairManager({ dataDir, logger, fixedPin: FIXED_PIN });
    binder = new SessionBinder({ sessionManager, transcriptTap, outbound, logger, dataDir, pair, webPush });
    artifacts = new ArtifactServer({ logger });
    meetingBinder = meetingManager ? new MeetingBinder({ sessionManager, meetingManager, logger, dataDir }) : null;
    desktopSync = new DesktopSyncBinder({
      sessionManager,
      meetingManager,
      transcriptTap,
      outbound,
      dispatchGroupChatTurn,
      logger,
    });
    ptyMirror = new PtyMirrorBinder({ sessionManager, outbound, logger });
  } catch (e) {
    logger.error(`[mobile-bridge] init failed: ${e.message}`);
    return null;
  }

  const hubViewStreams = new Map();
  const clampHubViewOptions = (msg = {}) => ({
    maxWidth: Math.max(320, Math.min(Number(msg.maxWidth) || 900, 1600)),
    mimeType: String(msg.mimeType || msg.format || 'image/jpeg').toLowerCase().includes('png') ? 'image/png' : 'image/jpeg',
    quality: Math.max(35, Math.min(92, Math.round(Number(msg.quality) || 72))),
    delayMs: Math.max(45, Math.min(1000, Math.round(Number(msg.delayMs) || 95))),
  });
  const stopHubViewStream = (deviceToken, requestId = null) => {
    const stream = hubViewStreams.get(deviceToken);
    if (!stream) return false;
    if (requestId && stream.requestId && stream.requestId !== requestId) return false;
    stream.stopped = true;
    if (stream.timer) clearTimeout(stream.timer);
    hubViewStreams.delete(deviceToken);
    return true;
  };
  const startHubViewStream = (msg) => {
    if (typeof captureHubView !== 'function') {
      outbound.send({
        type: MSG.HUB_VIEW_FRAME,
        deviceToken: msg.deviceToken,
        requestId: msg.requestId,
        stream: true,
        ok: false,
        error: 'captureHubView not wired',
      });
      return;
    }
    const opts = clampHubViewOptions(msg);
    const stream = {
      deviceToken: msg.deviceToken,
      requestId: msg.requestId,
      maxWidth: opts.maxWidth,
      mimeType: opts.mimeType,
      quality: opts.quality,
      delayMs: opts.delayMs,
      expiresAt: Date.now() + 10 * 60 * 1000,
      inFlight: false,
      stopped: false,
      timer: null,
    };
    stopHubViewStream(msg.deviceToken);
    hubViewStreams.set(msg.deviceToken, stream);
    const schedule = (delayMs) => {
      if (stream.stopped) return;
      stream.timer = setTimeout(run, Math.max(0, Math.min(1000, Number(delayMs) || stream.delayMs)));
    };
    const sendFrame = (payload) => outbound.send({
      type: MSG.HUB_VIEW_FRAME,
      deviceToken: stream.deviceToken,
      requestId: stream.requestId,
      stream: true,
      streamDelayMs: stream.delayMs,
      ...payload,
    });
    const run = async () => {
      if (stream.stopped) return;
      if (Date.now() > stream.expiresAt) {
        stopHubViewStream(stream.deviceToken);
        return;
      }
      if (stream.inFlight) {
        schedule(stream.delayMs);
        return;
      }
      stream.inFlight = true;
      try {
        const frame = await captureHubView({
          maxWidth: stream.maxWidth,
          mimeType: stream.mimeType,
          quality: stream.quality,
        });
        sendFrame({
          ok: true,
          mimeType: frame.mimeType || stream.mimeType,
          imageBase64: frame.imageBase64,
          width: frame.width,
          height: frame.height,
          originalWidth: frame.originalWidth,
          originalHeight: frame.originalHeight,
          byteLength: frame.byteLength,
          quality: frame.quality,
          capturedAt: frame.capturedAt || Date.now(),
        });
      } catch (e) {
        logger.warn(`[mobile-bridge] hub-view stream capture failed: ${e && e.message}`);
        sendFrame({
          ok: false,
          error: e && e.message || 'capture_failed',
        });
      } finally {
        stream.inFlight = false;
        schedule(stream.delayMs);
      }
    };
    run();
  };

  // VPS → Hub 消息路由
  outbound.on('message', (msg) => {
    try {
      switch (msg.type) {
        case MSG.PING:
        case MSG.PONG:
          return;
        case MSG.HELLO: {
          // PWA 上线后请求当前 mobile sessions（含 sinceSeq 用于回灌）
          if (pair.isValidToken(msg.deviceToken)) {
            pair.touchDevice(msg.deviceToken);
            outbound.send({
              type: MSG.SESSION_LIST,
              deviceToken: msg.deviceToken,
              sessions: binder.listSessions(),
            });
            binder.replayTurnsSince(msg.deviceToken, msg.sinceSeq || 0);
          }
          return;
        }
        case MSG.PWA_INPUT: {
          if (!pair.isValidToken(msg.deviceToken)) {
            logger.warn(`[mobile-bridge] reject input from unknown device token ${(msg.deviceToken||'').slice(0,8)}`);
            return;
          }
          pair.touchDevice(msg.deviceToken);
          logger.log(`[mobile-bridge] input ← token=${msg.deviceToken.slice(0,8)} session=${(msg.sessionId||'').slice(0,12)} contentLen=${(msg.content||'').length}`);
          binder.handlePwaInput(msg.sessionId, msg.content, msg.deviceToken);
          return;
        }
        case MSG.NEW_SESSION: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          // setImmediate 把 createSession 推到下一个事件循环 tick：避免在 WSS message
          // callback 栈深处同步调 pty.spawn 触发 ConPTY 异常退出（mobile session 立即
          // onExit → sessions.delete → "看似建了但马上消失"）。GUI 路径走 IPC handler
          // 已经天然在 main loop 主 tick 上，无此问题。
          setImmediate(() => {
            try {
              const result = binder.createNewSession(msg.kind, msg.title);
              outbound.send({
                type: MSG.SESSION_CREATED,
                deviceToken: msg.deviceToken,
                requestId: msg.requestId,
                session: result,
              });
              outbound.send({ type: MSG.SESSION_LIST, deviceToken: msg.deviceToken, sessions: binder.listSessions() });
            } catch (e) {
              logger.error(`[mobile-bridge] createNewSession failed: ${e && e.message}`);
              outbound.send({
                type: MSG.ERROR,
                deviceToken: msg.deviceToken,
                requestId: msg.requestId,
                code: 'create_failed',
                error: e && e.message,
              });
            }
          });
          return;
        }
        case MSG.DESTROY_SESSION: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          let desktopOk = false;
          if (msg.sessionId !== MOBILE_SESSION_ID && desktopSync && typeof desktopSync.handleDestroy === 'function') {
            desktopOk = desktopSync.handleDestroy(msg);
          }
          const mobileOk = binder.destroySession(msg.sessionId);
          const ok = mobileOk || desktopOk;
          outbound.send({
            type: MSG.SESSION_DESTROYED,
            deviceToken: msg.deviceToken,
            sessionId: msg.sessionId,
            ok,
          });
          outbound.send({ type: MSG.SESSION_LIST, deviceToken: msg.deviceToken, sessions: binder.listSessions() });
          return;
        }
        case MSG.LIST_SESSIONS: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          outbound.send({
            type: MSG.SESSION_LIST,
            deviceToken: msg.deviceToken,
            sessions: binder.listSessions(),
          });
          return;
        }
        case MSG.RENAME_SESSION: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          const mobileOk = binder.handleRename(msg.sessionId, msg.title);
          let desktopOk = false;
          if (desktopSync && typeof desktopSync.handleRename === 'function') {
            desktopOk = desktopSync.handleRename(msg);
          }
          const ok = mobileOk || desktopOk;
          outbound.send({ type: MSG.SESSION_LIST, deviceToken: msg.deviceToken, sessions: binder.listSessions() });
          if (!ok) {
            outbound.send({
              type: MSG.ERROR,
              deviceToken: msg.deviceToken,
              code: 'rename_failed',
              error: 'session not found or title invalid',
            });
          }
          return;
        }
        case MSG.PIN_SESSION: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          const mobileOk = binder.handlePin(msg.sessionId, msg.pinned);
          let desktopOk = false;
          if (desktopSync && typeof desktopSync.handlePin === 'function') {
            desktopOk = desktopSync.handlePin(msg);
          }
          const ok = mobileOk || desktopOk;
          outbound.send({ type: MSG.SESSION_LIST, deviceToken: msg.deviceToken, sessions: binder.listSessions() });
          if (!ok) {
            outbound.send({
              type: MSG.ERROR,
              deviceToken: msg.deviceToken,
              code: 'pin_failed',
              error: 'session not found',
            });
          }
          return;
        }
        case MSG.HUB_SNAPSHOT_REQUEST: {
          logger.log(`[mobile-bridge] snapshot-req ← token=${(msg.deviceToken || '').slice(0, 8)} valid=${pair.isValidToken(msg.deviceToken)}`);
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          desktopSync.handleSnapshotRequest(msg);
          logger.log('[mobile-bridge] snapshot sent');
          return;
        }
        case MSG.HUB_COMMAND: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          desktopSync.handleCommand(msg);
          return;
        }
        case MSG.HUB_VIEW_REQUEST: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          const requestId = msg.requestId;
          const { maxWidth, mimeType, quality } = clampHubViewOptions(msg);
          if (typeof captureHubView !== 'function') {
            outbound.send({
              type: MSG.HUB_VIEW_FRAME,
              deviceToken: msg.deviceToken,
              requestId,
              ok: false,
              error: 'captureHubView not wired',
            });
            return;
          }
          Promise.resolve()
            .then(() => captureHubView({ maxWidth, mimeType, quality }))
            .then((frame) => {
              outbound.send({
                type: MSG.HUB_VIEW_FRAME,
                deviceToken: msg.deviceToken,
                requestId,
                ok: true,
                mimeType: frame.mimeType || 'image/png',
                imageBase64: frame.imageBase64,
                width: frame.width,
                height: frame.height,
                originalWidth: frame.originalWidth,
                originalHeight: frame.originalHeight,
                byteLength: frame.byteLength,
                quality: frame.quality,
                capturedAt: frame.capturedAt || Date.now(),
              });
            })
            .catch((e) => {
              logger.warn(`[mobile-bridge] hub-view capture failed: ${e && e.message}`);
              outbound.send({
                type: MSG.HUB_VIEW_FRAME,
                deviceToken: msg.deviceToken,
                requestId,
                ok: false,
                error: e && e.message || 'capture_failed',
              });
          });
          return;
        }
        case MSG.HUB_VIEW_SUBSCRIBE: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          startHubViewStream(msg);
          return;
        }
        case MSG.HUB_VIEW_UNSUBSCRIBE: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          stopHubViewStream(msg.deviceToken, msg.requestId || null);
          return;
        }
        case MSG.HUB_VIEW_INPUT: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          const requestId = msg.requestId;
          if (typeof sendHubViewInput !== 'function') {
            outbound.send({
              type: MSG.HUB_VIEW_INPUT_ACK,
              deviceToken: msg.deviceToken,
              requestId,
              ok: false,
              error: 'sendHubViewInput not wired',
            });
            return;
          }
          Promise.resolve()
            .then(() => sendHubViewInput({ input: msg.input || {} }))
            .then((result) => {
              outbound.send({
                type: MSG.HUB_VIEW_INPUT_ACK,
                deviceToken: msg.deviceToken,
                requestId,
                ok: true,
                result: result || null,
              });
            })
            .catch((e) => {
              logger.warn(`[mobile-bridge] hub-view input failed: ${e && e.message}`);
              outbound.send({
                type: MSG.HUB_VIEW_INPUT_ACK,
                deviceToken: msg.deviceToken,
                requestId,
                ok: false,
                error: e && e.message || 'input_failed',
              });
            });
          return;
        }
        case MSG.PTY_SUBSCRIBE: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          ptyMirror.handleSubscribe(msg);
          return;
        }
        case MSG.PTY_UNSUBSCRIBE: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          ptyMirror.handleUnsubscribe(msg);
          return;
        }
        case MSG.PTY_INPUT: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          ptyMirror.handleInput(msg);
          return;
        }
        case MSG.PTY_RESIZE: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          pair.touchDevice(msg.deviceToken);
          ptyMirror.handleResize(msg);
          return;
        }
        case MSG.PAIR_REQUEST: {
          const result = pair.verifyPin(msg.pin, msg.deviceName);
          outbound.send({
            type: MSG.PAIR_RESULT,
            requestId: msg.requestId,
            ok: result.ok,
            deviceToken: result.deviceToken || null,
            error: result.error || null,
          });
          return;
        }
        case MSG.REGISTER_PUSH_SUB: {
          // T11：PWA 上报 Web Push subscription（含 endpoint + p256dh + auth）
          // 校验 token 后存到 mobile-devices.json[token].pushSub
          // 后续 turn-complete 时 session-binder 查 pushSub 调 webPush.send 推
          if (!pair.isValidToken(msg.deviceToken)) {
            logger.warn(`[mobile-bridge] reject push-sub from unknown device ${(msg.deviceToken||'').slice(0,8)}`);
            return;
          }
          pair.touchDevice(msg.deviceToken);
          const ok = pair.setPushSub(msg.deviceToken, msg.sub, msg.ua);
          logger.log(`[mobile-bridge] push-sub ${ok ? 'registered' : 'rejected'} for device=${msg.deviceToken.slice(0,8)} endpoint=${(msg.sub && msg.sub.endpoint || '').slice(0, 60)}`);
          outbound.send({
            type: MSG.PUSH_SUB_ACK,
            deviceToken: msg.deviceToken,
            ok,
            error: ok ? null : 'bad_subscription',
          });
          return;
        }
        case MSG.NEW_MEETING: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          if (!meetingBinder) {
            outbound.send({
              type: MSG.MEETING_CREATED,
              deviceToken: msg.deviceToken,
              requestId: msg.requestId,
              ok: false,
              error: 'meetingManager not wired (Hub may need restart)',
            });
            return;
          }
          const result = meetingBinder.createMeeting({
            mode: msg.kind || msg.mode,
            title: msg.title,
            members: msg.members,
          });
          outbound.send({
            type: MSG.MEETING_CREATED,
            deviceToken: msg.deviceToken,
            requestId: msg.requestId,
            ...result,
          });
          return;
        }
        case MSG.LIST_MEETINGS: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          const meetings = meetingBinder ? meetingBinder.listMeetings() : [];
          outbound.send({
            type: MSG.MEETING_LIST,
            deviceToken: msg.deviceToken,
            requestId: msg.requestId,
            meetings,
          });
          return;
        }
        case MSG.ARTIFACT_LIST_REQUEST: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          const items = artifacts.listRecent(msg.limit || 50);
          outbound.send({
            type: MSG.ARTIFACT_LIST,
            deviceToken: msg.deviceToken,
            requestId: msg.requestId,
            items,
          });
          return;
        }
        case MSG.ARTIFACT_FETCH: {
          if (!pair.isValidToken(msg.deviceToken)) return;
          const t0 = Date.now();
          const result = artifacts.fetch(msg.path);
          const elapsed = Date.now() - t0;
          if (result.ok) {
            logger.log(`[mobile-bridge] artifact ${msg.path} fetched ${result.size}B in ${elapsed}ms`);
            outbound.send({
              type: MSG.ARTIFACT_CONTENT,
              deviceToken: msg.deviceToken,
              requestId: msg.requestId,
              path: msg.path,
              contentBase64: result.contentBase64,
              mimeType: result.mimeType,
              size: result.size,
            });
          } else {
            logger.warn(`[mobile-bridge] artifact ${msg.path} fetch failed: ${result.error}`);
            outbound.send({
              type: MSG.ARTIFACT_ERROR,
              deviceToken: msg.deviceToken,
              requestId: msg.requestId,
              path: msg.path,
              error: result.error,
            });
          }
          return;
        }
      }
    } catch (e) {
      logger.warn(`[mobile-bridge] message handler error: ${e.message}`);
    }
  });

  outbound.on('auth-failed', () => {
    logger.error('[mobile-bridge] VPS rejected bearer token — bridge halted, check MOBILE_BEARER_TOKEN');
  });

  outbound.on('state', ({ from, to }) => {
    logger.log(`[mobile-bridge] outbound state: ${from} → ${to}`);
  });

  // 启动
  try {
    binder.start();
    desktopSync.start();
    ptyMirror.start();
    outbound.connect();
    _registerDebugIpc(binder, outbound);
    logger.log(`[mobile-bridge] started, target ${VPS_URL}`);
  } catch (e) {
    logger.error(`[mobile-bridge] start failed: ${e.message}`);
    return null;
  }

  // MVP: 自动生成 PIN 写到磁盘文件，方便用户/工具拿 PIN 不依赖 UI。
  // 行为：
  //   - bridge 启动立刻写一个 PIN（5min 有效）
  //   - 每 4 分钟自动 regenerate（PIN 过期前 1 分钟）— 直到至少配对成功 1 台设备
  //   - 文件路径：${dataDir}/mobile-pairing-pin.txt
  //   - 配对成功后停止 regenerate（mobile-devices.json 有设备就停）
  const fs = require('fs');
  const pinPath = path.join(dataDir, 'mobile-pairing-pin.txt');
  const writePinFile = () => {
    try {
      // 临时模式 + 已配对：不再生成新 PIN
      if (!FIXED_PIN && pair.listDevices().length > 0) {
        if (fs.existsSync(pinPath)) fs.unlinkSync(pinPath);
        return false;
      }
      const { pin, expiresAt } = pair.generatePin();
      const expLabel = FIXED_PIN ? 'fixed=true (never expires)' : `expires=${new Date(expiresAt).toISOString()}`;
      const content = `${pin}\n${expLabel}\ngenerated=${new Date().toISOString()}\n`;
      fs.writeFileSync(pinPath, content, 'utf8');
      try { fs.chmodSync(pinPath, 0o600); } catch {}
      logger.log(`[mobile-bridge] PIN written to ${pinPath} (${expLabel})`);
      return true;
    } catch (e) {
      logger.warn(`[mobile-bridge] failed to write PIN file: ${e.message}`);
      return false;
    }
  };
  writePinFile();

  // 固定 PIN 模式下不需要 refresh（PIN 永不变化）
  let pinRefreshTimer = null;
  if (!FIXED_PIN) {
    pinRefreshTimer = setInterval(() => {
      if (pair.listDevices().length > 0) {
        if (fs.existsSync(pinPath)) { try { fs.unlinkSync(pinPath); } catch {} }
        clearInterval(pinRefreshTimer);
        logger.log('[mobile-bridge] device paired, PIN auto-generation stopped');
        return;
      }
      writePinFile();
    }, 4 * 60 * 1000);
  }

  // 暴露公共 API 给 Hub renderer / IPC handler 调用
  return {
    generatePin: () => pair.generatePin(),
    currentPinInfo: () => pair.currentPinInfo(),
    listDevices: () => pair.listDevices(),
    revokeDevice: (token) => pair.revokeDevice(token),
    shutdown: () => {
      if (pinRefreshTimer) clearInterval(pinRefreshTimer);
      for (const token of Array.from(hubViewStreams.keys())) stopHubViewStream(token);
      outbound.disconnect();
    },
  };
}

module.exports = { startMobileBridge };
