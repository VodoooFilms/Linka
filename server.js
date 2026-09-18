import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInputAdapter } from './input-adapter.js';
import {
  createSessionId,
  createSecretToken,
  randomUUID,
  tokenMatches,
  withPairingParams,
  formatBytes,
  getBridgeContentBytes,
} from './server/utils.js';
import { resolveDefaultPort, getConnectionInfo } from './server/network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIND_HOST = '0.0.0.0';
const MAX_BRIDGE_MESSAGES = 30;
const MAX_BRIDGE_FILE_BYTES = 5 * 1024 * 1024;
const WS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const WS_MAX_MSG_PER_SEC = 200;
const RECONNECT_TOKEN_BYTES = 32;
const MAX_RECONNECT_TOKENS = 24;
const RECONNECT_TOKEN_GRACE_MS = 60 * 1000;
const FAVICON_PATH = path.join(__dirname, 'build', 'linka-icon.ico');
const WEB_ICON_PATH = path.join(__dirname, 'build', 'linka-logo.png');
let loggingReady = false;
let bridgeMessages = [];

function setupFileLogging() {
  if (loggingReady || !process.env.LINKA_LOG_FILE) return;
  loggingReady = true;

  const logFile = process.env.LINKA_LOG_FILE;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const line = args
        .map((arg) => {
          if (arg instanceof Error) return arg.stack || arg.message;
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch (_error) {
            return String(arg);
          }
        })
        .join(' ');

      fs.appendFile(logFile, `[${new Date().toISOString()}] [${method}] ${line}\n`, () => {});
      original(...args);
    };
  }
}

function logRequest(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    const remote = req.socket.remoteAddress || 'unknown';
    console.log(
      `[http] ${remote} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms`,
    );
  });
  next();
}

function preventBrowserCache(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

function normalizeNumber(value, fallback = 0, min = -500, max = 500) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function handleCommand(input, data) {
  switch (data.type) {
    case 'move':
      input.move(normalizeNumber(data.dx), normalizeNumber(data.dy));
      break;
    case 'mousedown':
      input.mouseDown(data.button || 'left');
      break;
    case 'mouseup':
      input.mouseUp(data.button || 'left');
      break;
    case 'click':
      input.click(data.button || 'left', data.double || false);
      break;
    case 'scroll':
      input.scroll(normalizeNumber(data.dy, 0, -1200, 1200));
      break;
    case 'zoom':
      input.zoom(data.direction === 'out' ? 'out' : 'in');
      break;
    case 'type':
      input.type(data.text || '');
      break;
    case 'keytap':
      input.keyTap(data.key, Array.isArray(data.modifiers) ? data.modifiers : []);
      break;
    case 'volume':
      input.setVolume?.(Math.max(0, Math.min(1, Number(data.value))));
      break;
    case 'mute':
      input.setMute?.(Boolean(data.muted));
      break;
    case 'togglemute':
      input.toggleMute?.();
      break;
    default:
      console.warn(`[ws] Unknown command: ${data.type}`);
  }
}

function normalizeBridgeMessage(message) {
  if (!message || typeof message !== 'object') return null;

  const type =
    message.type === 'image'
      ? 'image'
      : message.type === 'text'
        ? 'text'
        : message.type === 'file'
          ? 'file'
          : null;
  const from = message.from === 'pc' ? 'pc' : message.from === 'phone' ? 'phone' : null;
  const content = typeof message.content === 'string' ? message.content : '';

  if (!type || !from || !content) return null;

  const result = {
    id: typeof message.id === 'string' && message.id ? message.id : randomUUID(),
    type,
    content,
    from,
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Date.now(),
  };

  if (type === 'file') {
    result.filename = typeof message.filename === 'string' ? message.filename : 'file';
    result.size = Number.isFinite(Number(message.size)) ? Number(message.size) : 0;
  }

  return result;
}

export async function startServer(options = {}) {
  setupFileLogging();
  const requestedPort = Number(options.port ?? resolveDefaultPort());
  let port = requestedPort;
  const onClientConnected =
    typeof options.onClientConnected === 'function' ? options.onClientConnected : null;
  const captureScreen = typeof options.captureScreen === 'function' ? options.captureScreen : null;
  const getDisplays = typeof options.getDisplays === 'function' ? options.getDisplays : null;
  const captureAvailable = Boolean(captureScreen);
  const app = express();
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const clients = new Set();
  let connectionInfo = getConnectionInfo(port);
  let activeSessionId = createSessionId();
  let activePairingToken = createSecretToken();
  let reconnectTokens = new Map();
  const HEARTBEAT_INTERVAL_MS = 30000;
  const HEARTBEAT_TIMEOUT_MS = 10000;
  let heartbeatTimer = null;

  function getSessionSnapshot() {
    return {
      sessionId: activeSessionId,
      pairingUrl: withPairingParams(connectionInfo.primaryUrl, activeSessionId, activePairingToken),
      localhostPairingUrl: withPairingParams(
        connectionInfo.localhostUrl,
        activeSessionId,
        activePairingToken,
      ),
    };
  }

  function pruneReconnectTokens() {
    const now = Date.now();
    for (const [token, meta] of reconnectTokens.entries()) {
      if (meta?.state === 'grace' && Number.isFinite(meta.validUntil) && meta.validUntil <= now) {
        reconnectTokens.delete(token);
      }
    }

    if (reconnectTokens.size <= MAX_RECONNECT_TOKENS) {
      return;
    }

    const ordered = [...reconnectTokens.entries()].sort(
      (a, b) => (a[1].lastSeenAt || a[1].createdAt) - (b[1].lastSeenAt || b[1].createdAt),
    );

    for (const [token] of ordered.slice(0, reconnectTokens.size - MAX_RECONNECT_TOKENS)) {
      reconnectTokens.delete(token);
    }
  }

  function issueReconnectToken(meta = {}) {
    pruneReconnectTokens();
    const now = Date.now();
    const chainId =
      typeof meta.chainId === 'string' && meta.chainId
        ? meta.chainId
        : typeof meta.deviceId === 'string' && meta.deviceId
          ? `device:${meta.deviceId}`
          : `anon:${randomUUID()}`;

    for (const [token, existing] of reconnectTokens.entries()) {
      if (existing?.sessionId !== activeSessionId || existing?.chainId !== chainId) {
        continue;
      }

      if (existing.state === 'current') {
        existing.state = 'grace';
        existing.validUntil = now + RECONNECT_TOKEN_GRACE_MS;
        existing.lastSeenAt = now;
        continue;
      }

      reconnectTokens.delete(token);
    }

    const token = createSecretToken();
    reconnectTokens.set(token, {
      ...meta,
      createdAt: now,
      lastSeenAt: now,
      sessionId: activeSessionId,
      deviceId: typeof meta.deviceId === 'string' && meta.deviceId ? meta.deviceId : null,
      chainId,
      state: 'current',
      validUntil: null,
    });
    pruneReconnectTokens();
    return token;
  }

  function invalidateReconnectToken(token) {
    if (typeof token === 'string' && token) {
      reconnectTokens.delete(token);
    }
  }

  let input = null;
  input = await createInputAdapter({
    onStateChange: (state) => {
      const backendName = input?.name || state.name || 'unknown';
      const nativeInputReady =
        typeof input?.ready === 'boolean' ? input.ready : Boolean(state.ready);

      if (state.retrying) {
        console.warn(`[input] Backend degraded: ${backendName} (retry ${state.retryCount})`);
      } else if (state.recovered) {
        console.warn('[input] Backend recovered.');
      } else if (state.retriesExhausted) {
        console.warn('[input] Backend permanently unavailable.');
      }

      broadcast({
        event: 'system_state',
        payload: {
          inputBackend: backendName,
          nativeInputReady,
          bridgeCaptureAvailable: captureAvailable,
          permissionMissing: state.permissionMissing,
          message: state.message,
        },
      });
    },
  });

  function sendJson(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  function broadcast(data) {
    for (const client of clients) {
      if (!client._authenticated) continue;
      sendJson(client, data);
    }
  }

  function clearSocketAuth(ws) {
    if (!ws) return;
    ws._authenticated = false;
    ws._sessionId = null;
    ws._reconnectToken = null;
    ws._deviceId = null;
  }

  function closeAllClients(code = 4001, reason = 'Pairing reset') {
    for (const client of clients) {
      clearTimeout(client._heartbeatTimeout);
      clearSocketAuth(client);
      client.close(code, reason);
    }
  }

  function resetPairing() {
    activeSessionId = createSessionId();
    activePairingToken = createSecretToken();
    reconnectTokens = new Map();

    broadcast({
      event: 'session_reset',
      payload: {
        message: 'Pairing was reset on the desktop app.',
      },
    });
    closeAllClients(4001, 'Pairing reset');

    const session = getSessionSnapshot();
    console.log(`[session] Pairing reset. Session ${session.sessionId}`);
    return session;
  }

  function syncBridge(ws) {
    sendJson(ws, {
      event: 'bridge_sync',
      payload: {
        messages: bridgeMessages,
      },
    });
  }

  function appendBridgeMessage(message) {
    bridgeMessages.push(message);
    if (bridgeMessages.length > MAX_BRIDGE_MESSAGES) {
      bridgeMessages = bridgeMessages.slice(-MAX_BRIDGE_MESSAGES);
    }
  }

  function authenticateSocket(ws, authMode) {
    ws._authenticated = true;
    ws._sessionId = activeSessionId;
    ws._authMode = authMode;
  }

  function createAuthSuccessPayload(ws, meta = {}) {
    const reconnectToken = issueReconnectToken(meta);
    ws._reconnectToken = reconnectToken;
    ws._deviceId = meta.deviceId || null;

    return {
      type: 'auth_ok',
      sessionId: activeSessionId,
      reconnectToken,
    };
  }

  function handleAuthMessage(ws, data, req) {
    const providedSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const providedToken = typeof data.token === 'string' ? data.token : '';
    const providedDeviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
    const authMode = data.mode === 'reconnect' ? 'reconnect' : data.mode === 'pair' ? 'pair' : null;

    if (!authMode) {
      sendJson(ws, { type: 'auth_error', reason: 'invalid_mode' });
      return false;
    }

    if (!tokenMatches(activeSessionId, providedSessionId)) {
      sendJson(ws, { type: 'auth_error', reason: 'session_changed' });
      return false;
    }

    if (authMode === 'pair') {
      if (!tokenMatches(activePairingToken, providedToken)) {
        sendJson(ws, { type: 'auth_error', reason: 'invalid_pairing' });
        return false;
      }

      clearSocketAuth(ws);
      authenticateSocket(ws, authMode);
      sendJson(
        ws,
        createAuthSuccessPayload(ws, {
          mode: authMode,
          deviceId: providedDeviceId || null,
          chainId: providedDeviceId ? `device:${providedDeviceId}` : undefined,
          remoteAddress: req.socket.remoteAddress || 'unknown',
        }),
      );
      if (input.getVolumeState) {
        input
          .getVolumeState()
          .then((state) => {
            if (state && ws.readyState === 1 && ws._authenticated) {
              sendJson(ws, { event: 'volume_state', payload: state });
            }
          })
          .catch(() => {});
      }
      onClientConnected?.({
        clients: clients.size,
        remoteAddress: req.socket.remoteAddress || 'unknown',
        authMode,
      });
      return true;
    }

    const existing = reconnectTokens.get(providedToken);
    if (!existing) {
      sendJson(ws, { type: 'auth_error', reason: 'invalid_reconnect' });
      return false;
    }

    if (existing.sessionId !== activeSessionId) {
      sendJson(ws, { type: 'auth_error', reason: 'session_changed' });
      return false;
    }

    if (
      existing.state === 'grace' &&
      Number.isFinite(existing.validUntil) &&
      existing.validUntil <= Date.now()
    ) {
      reconnectTokens.delete(providedToken);
      sendJson(ws, { type: 'auth_error', reason: 'invalid_reconnect' });
      return false;
    }

    if (existing.deviceId) {
      if (!providedDeviceId || providedDeviceId !== existing.deviceId) {
        sendJson(ws, { type: 'auth_error', reason: 'invalid_device' });
        return false;
      }
    }

    clearSocketAuth(ws);
    authenticateSocket(ws, authMode);
    sendJson(
      ws,
      createAuthSuccessPayload(ws, {
        mode: authMode,
        deviceId: providedDeviceId || existing.deviceId || null,
        chainId: existing.chainId,
        remoteAddress: req.socket.remoteAddress || 'unknown',
        previousIssuedAt: existing.createdAt,
      }),
    );
    if (input.getVolumeState) {
      input
        .getVolumeState()
        .then((state) => {
          if (state && ws.readyState === 1 && ws._authenticated) {
            sendJson(ws, { event: 'volume_state', payload: state });
          }
        })
        .catch(() => {});
    }
    onClientConnected?.({
      clients: clients.size,
      remoteAddress: req.socket.remoteAddress || 'unknown',
      authMode,
    });
    return true;
  }

  async function handleBridgeEvent(ws, data) {
    if (data.event === 'bridge_sync_request') {
      syncBridge(ws);
      return true;
    }

    if (data.event === 'bridge_clear') {
      bridgeMessages = [];
      broadcast({ event: 'bridge_clear' });
      return true;
    }

    if (data.event === 'bridge_capture_request') {
      if (!captureScreen) {
        sendJson(ws, {
          event: 'bridge_capture_error',
          payload: { message: 'Screen capture is only available in the desktop app.' },
        });
        return true;
      }

      try {
        const displayId =
          typeof data.payload?.displayId === 'string' ? data.payload.displayId : undefined;
        const content = await captureScreen(displayId);
        const message = normalizeBridgeMessage({
          id: randomUUID(),
          type: 'image',
          content,
          from: 'pc',
          timestamp: Date.now(),
        });

        if (!message) {
          throw new Error('Captured image was empty.');
        }

        appendBridgeMessage(message);
        broadcast({ event: 'bridge_message', payload: message });
        sendJson(ws, { event: 'bridge_capture_complete' });
      } catch (error) {
        console.error('[bridge] Screen capture failed:', error);
        sendJson(ws, {
          event: 'bridge_capture_error',
          payload: { message: `Screen capture failed: ${error?.message || error}` },
        });
      }
      return true;
    }

    if (data.event === 'bridge_monitors_request') {
      const displays = getDisplays ? getDisplays() : [];
      sendJson(ws, {
        event: 'bridge_monitors',
        payload: { displays },
      });
      return true;
    }

    if (data.event === 'bridge_message') {
      const message = normalizeBridgeMessage(data.payload);
      if (!message) {
        console.warn('[ws] Invalid bridge message ignored.');
        return true;
      }

      const mediaBytes =
        message.type === 'image' || message.type === 'file'
          ? getBridgeContentBytes(message.content)
          : 0;

      if (mediaBytes > MAX_BRIDGE_FILE_BYTES) {
        console.warn('[ws] Bridge file too large, ignoring.');
        sendJson(ws, {
          event: 'bridge_capture_error',
          payload: { message: `File too large (${formatBytes(mediaBytes)}). Maximum is 5MB.` },
        });
        return true;
      }

      appendBridgeMessage(message);
      broadcast({ event: 'bridge_message', payload: message });
      return true;
    }

    return false;
  }

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    next();
  });
  app.use(logRequest);
  app.use(preventBrowserCache);

  app.get('/favicon.ico', (_req, res) => {
    res.sendFile(FAVICON_PATH);
  });

  app.get('/icon.png', (_req, res) => {
    res.sendFile(WEB_ICON_PATH);
  });

  app.get('/apple-touch-icon.png', (_req, res) => {
    res.sendFile(WEB_ICON_PATH);
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      product: 'LINKA',
      status: 'running',
      sessionId: activeSessionId,
      port,
      bindHost: connectionInfo.bindHost,
      primaryUrl: connectionInfo.primaryUrl,
      localhostUrl: connectionInfo.localhostUrl,
      urls: connectionInfo.urls,
      candidates: connectionInfo.candidates,
      inputBackend: input.name,
      nativeInputReady: input.ready,
      permissionMissing: input.permissionMissing || false,
      message: input.message || '',
      clients: clients.size,
    });
  });

  if (process.env.NODE_ENV === 'production') {
    const staticRoot = path.join(__dirname, 'dist');
    console.log(`[static] Serving production files from ${staticRoot}`);
    app.use(express.static(staticRoot, { fallthrough: true }));
    app.get('*', (_req, res) => {
      const indexPath = path.join(staticRoot, 'index.html');
      res.sendFile(indexPath, (error) => {
        if (error) {
          console.error(`[static] Failed to serve ${indexPath}:`, error);
          if (!res.headersSent) res.status(500).send('LINKA client failed to load.');
        }
      });
    });
  } else {
    console.log(`[static] Serving development files from ${__dirname}`);
    app.use(express.static(__dirname, { fallthrough: true }));
    app.get('*', (_req, res) => {
      const indexPath = path.join(__dirname, 'index.html');
      res.sendFile(indexPath, (error) => {
        if (error) {
          console.error(`[static] Failed to serve ${indexPath}:`, error);
          if (!res.headersSent) res.status(500).send('LINKA client failed to load.');
        }
      });
    });
  }

  wss.on('headers', (_headers, req) => {
    console.log(`[ws] Upgrade attempt from ${req.socket.remoteAddress} ${req.url}`);
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(
      `[ws] Client connected from ${req.socket.remoteAddress}. Total clients: ${clients.size}`,
    );
    ws._authenticated = false;
    ws._sessionId = null;
    ws._reconnectToken = null;
    ws._deviceId = null;
    sendJson(ws, {
      type: 'hello',
      authRequired: true,
      inputBackend: input.name,
      nativeInputReady: input.ready,
      bridgeCaptureAvailable: captureAvailable,
      permissionMissing: input.permissionMissing,
      message: input.message,
    });

    ws._messageTimestamps = [];
    ws._rateLimited = false;

    ws.on('message', async (message) => {
      try {
        if (Buffer.isBuffer(message) && message.length > WS_MAX_PAYLOAD_BYTES) {
          return;
        }

        const now = Date.now();
        const windowStart = now - 1000;
        ws._messageTimestamps = ws._messageTimestamps.filter((t) => t > windowStart);

        if (ws._messageTimestamps.length >= WS_MAX_MSG_PER_SEC) {
          if (!ws._rateLimited) {
            ws._rateLimited = true;
            console.warn(`[ws] Rate limit hit for ${req.socket.remoteAddress}. Dropping messages.`);
          }
          return;
        }

        ws._rateLimited = false;
        ws._messageTimestamps.push(now);

        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          return sendJson(ws, { type: 'pong' });
        }

        if (data.type === 'auth') {
          const ok = handleAuthMessage(ws, data, req);
          if (!ok) {
            clearSocketAuth(ws);
            ws.close(4401, 'Authentication failed');
          }
          return;
        }

        // Auto-authenticate localhost connections (same machine).
        // The browser at localhost:3067 doesn't have the QR code's
        // sessionId/pairingToken, but it's on the same box — it IS
        // the desktop app's own UI. Grant it full access.
        const remoteAddr = req.socket.remoteAddress || '';
        const isLocalhost =
          remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
        if (!ws._authenticated && isLocalhost) {
          authenticateSocket(ws, 'local');
          sendJson(ws, {
            type: 'auth_ok',
            sessionId: activeSessionId,
            reconnectToken: issueReconnectToken({ mode: 'local', remoteAddress: remoteAddr }),
          });
          console.log(`[ws] Auto-authenticated localhost client from ${remoteAddr}`);
        }

        if (!ws._authenticated) {
          sendJson(ws, { type: 'auth_error', reason: 'auth_required' });
          ws.close(4401, 'Authentication required');
          return;
        }

        if (!(await handleBridgeEvent(ws, data))) {
          handleCommand(input, data);
        }
      } catch (error) {
        console.error('[ws] Error processing message:', error);
      }
    });

    ws.on('close', () => {
      clearTimeout(ws._heartbeatTimeout);
      clearSocketAuth(ws);
      clients.delete(ws);
      console.log(`[ws] Client disconnected. Total clients: ${clients.size}`);
    });

    ws.on('pong', () => {
      clearTimeout(ws._heartbeatTimeout);
    });
  });

  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (client._heartbeatTimeout) {
        clearTimeout(client._heartbeatTimeout);
      }

      client._heartbeatTimeout = setTimeout(() => {
        console.warn('[ws] Client heartbeat timeout. Terminating connection.');
        client.terminate();
      }, HEARTBEAT_TIMEOUT_MS);

      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, resolve);
  });

  const serverAddress = server.address();
  if (
    serverAddress &&
    typeof serverAddress === 'object' &&
    typeof serverAddress.port === 'number'
  ) {
    port = serverAddress.port;
    connectionInfo = getConnectionInfo(port);
  }

  console.log(`[net] Bind address: ${connectionInfo.bindHost}:${port}`);
  console.log(`[net] Recommended phone URL: ${connectionInfo.primaryUrl}`);
  console.log(`[net] Pairing URL: ${getSessionSnapshot().pairingUrl}`);
  console.log(`[net] Localhost URL: ${connectionInfo.localhostUrl}`);
  console.log(
    `[net] Candidates: ${connectionInfo.candidates.map((candidate) => `${candidate.url} (${candidate.name}, score=${candidate.score}${candidate.likelyVirtual ? ', virtual/link-local' : ''})`).join(' | ') || 'none'}`,
  );
  console.log(
    `Input backend: ${input.name}${input.ready ? '' : ' (not controlling native input)'}`,
  );

  return {
    port,
    bindHost: connectionInfo.bindHost,
    primaryUrl: connectionInfo.primaryUrl,
    localhostUrl: connectionInfo.localhostUrl,
    ...getSessionSnapshot(),
    urls: connectionInfo.urls,
    candidates: connectionInfo.candidates,
    inputBackend: input.name,
    nativeInputReady: input.ready,
    bridgeCaptureAvailable: captureAvailable,
    inputAdapter: input,
    resetPairing: () => {
      const session = resetPairing();
      return session;
    },
    close: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const client of clients) {
        clearTimeout(client._heartbeatTimeout);
        clearSocketAuth(client);
      }
      await new Promise((resolve) => server.close(resolve));
      input.close?.();
    },
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'server.js') {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
