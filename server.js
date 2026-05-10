import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import os from 'os';
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
import { generateTeachSkill } from './server/skill-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIND_HOST = '0.0.0.0';
const MAX_BRIDGE_MESSAGES = 30;
const MAX_BRIDGE_FILE_BYTES = 5 * 1024 * 1024;
const WS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const WS_MAX_MSG_PER_SEC = 200;
const RECONNECT_TOKEN_BYTES = 32;
const MAX_RECONNECT_TOKENS = 24;
const FAVICON_PATH = path.join(__dirname, 'build', 'linka-icon.ico');
const WEB_ICON_PATH = path.join(__dirname, 'build', 'linka-logo.png');
const HERMES_INBOX = path.join(os.homedir(), '.hermes', 'linka', 'inbox');
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

// Shared foreground-app helper: single compound AppleScript → 3 values
// Used by both server.js /hermes/events and main.js hotkey handler.
export async function getForegroundAppInfo() {
  try {
    const { execSync } = await import('child_process');
    const script = [
      `tell application "System Events"`,
      `  set p to first process whose frontmost is true`,
      `  set n to name of p`,
      `  try`,
      `    set b to bundle identifier of p`,
      `  on error`,
      `    set b to ""`,
      `  end try`,
      `  try`,
      `    set t to title of front window of p`,
      `  on error`,
      `    set t to ""`,
      `  end try`,
      `  return n & "|" & b & "|" & t`,
      `end tell`,
    ]
      .map((line) => `-e '${line}'`)
      .join(' ');
    const result = execSync(`osascript ${script}`, { encoding: 'utf8', timeout: 3000 }).trim();
    const [name, bundleId, windowTitle] = result.split('|').map((s) => s.trim());
    return { name, bundleId: bundleId || null, windowTitle: windowTitle || null };
  } catch {
    return { name: 'unknown', bundleId: null, windowTitle: null };
  }
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
    const token = createSecretToken();
    reconnectTokens.set(token, {
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ...meta,
    });
    pruneReconnectTokens();
    return token;
  }

  function invalidateReconnectToken(token) {
    if (typeof token === 'string' && token) {
      reconnectTokens.delete(token);
    }
  }

  const input = await createInputAdapter({
    onStateChange: (state) => {
      if (state.retrying) {
        console.warn(`[input] Backend degraded: ${input.name} (retry ${state.retryCount})`);
      } else if (state.recovered) {
        console.warn('[input] Backend recovered.');
      } else if (state.retriesExhausted) {
        console.warn('[input] Backend permanently unavailable.');
      }

      broadcast({
        event: 'system_state',
        payload: {
          inputBackend: input.name,
          nativeInputReady: input.ready,
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

    return {
      type: 'auth_ok',
      sessionId: activeSessionId,
      reconnectToken,
    };
  }

  function handleAuthMessage(ws, data, req) {
    const providedSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const providedToken = typeof data.token === 'string' ? data.token : '';
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

    reconnectTokens.delete(providedToken);
    clearSocketAuth(ws);
    authenticateSocket(ws, authMode);
    sendJson(
      ws,
      createAuthSuccessPayload(ws, {
        mode: authMode,
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

  // Hermes Linka: endpoint for Hermes to query captured GUI events
  app.get('/hermes/events', async (_req, res) => {
    try {
      if (typeof input.dumpEvents !== 'function') {
        res.status(501).json({ error: 'Event capture not available on this platform.' });
        return;
      }
      const result = await input.dumpEvents();
      fs.mkdirSync(HERMES_INBOX, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `manual-${timestamp}.json`;
      const filePath = path.join(HERMES_INBOX, filename);
      const appContext = await getForegroundAppInfo();
      const payload = {
        captured_at: new Date().toISOString(),
        source: 'linka-http-endpoint',
        app: appContext,
        ...result,
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
      console.log(`[hermes] Events dumped to ${filePath} (${result.count} events)`);
      res.json({ success: true, path: filePath, count: result.count });
    } catch (error) {
      console.error('[hermes] Event dump failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Phase 2: Pattern detection — scan inbox for recurring workflows
  // and suggest skill names with confidence scores.
  app.get('/hermes/suggest', async (_req, res) => {
    try {
      const limit = Math.min(Number(_req.query.limit) || 20, 100);
      const minOccurrences = Math.min(Number(_req.query.min) || 2, 10);
      const files = fs
        .readdirSync(HERMES_INBOX)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(HERMES_INBOX, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        .slice(0, limit);

      // Group captures by app name
      const byApp = {};
      for (const file of files) {
        try {
          const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
          const app = capture.app?.name || 'unknown';
          if (!byApp[app]) byApp[app] = [];
          byApp[app].push({
            file: path.basename(file),
            captured_at: capture.captured_at,
            count: capture.count || 0,
            user_intent: capture.user_intent || null,
            source: capture.source || 'unknown',
            events: capture.events?.length || 0,
          });
        } catch (_e) {
          /* skip corrupt files */
        }
      }

      // Score pattern similarity: same app + similar event count (±30%)
      const suggestions = [];
      for (const [app, captures] of Object.entries(byApp)) {
        if (captures.length < minOccurrences) continue;

        // Cluster by event count similarity
        const clusters = [];
        for (const cap of captures) {
          let matched = false;
          for (const cluster of clusters) {
            const avg = cluster.reduce((s, c) => s + c.count, 0) / cluster.length;
            if (avg > 0 && Math.abs(cap.count - avg) / avg < 0.3) {
              cluster.push(cap);
              matched = true;
              break;
            }
          }
          if (!matched) clusters.push([cap]);
        }

        for (const cluster of clusters) {
          if (cluster.length < minOccurrences) continue;
          const avgCount = Math.round(cluster.reduce((s, c) => s + c.count, 0) / cluster.length);
          const hasIntent = cluster.filter((c) => c.user_intent).length;
          const intentHints = cluster
            .filter((c) => c.user_intent)
            .map((c) => c.user_intent)
            .slice(0, 3);

          // Generate a suggested skill name from app + intent or event count
          const appSlug = app.toLowerCase().replace(/[^a-z0-9]/g, '-');
          let suggestionName;
          if (intentHints.length > 0) {
            const first = intentHints[0]
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, '')
              .trim();
            suggestionName = `${appSlug}-${first.slice(0, 30).replace(/\s+/g, '-')}`;
          } else {
            suggestionName = `${appSlug}-workflow-${avgCount}events`;
          }

          const confidence = Math.min(
            0.95,
            (cluster.length / Math.max(minOccurrences, 3)) * 0.5 +
              (hasIntent / cluster.length) * 0.3 +
              (avgCount > 3 ? 0.15 : 0.05),
          );

          suggestions.push({
            app,
            suggestion: suggestionName,
            confidence: Math.round(confidence * 100) / 100,
            captures: cluster.length,
            avg_event_count: avgCount,
            intent_hints: intentHints,
            latest: cluster[0]?.captured_at || null,
          });
        }
      }

      suggestions.sort((a, b) => b.confidence - a.confidence);
      res.json({
        suggestions: suggestions.slice(0, 10),
        total_captures_analyzed: files.length,
        apps_found: Object.keys(byApp).length,
      });
    } catch (error) {
      console.error('[hermes] Suggest failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Phase 2.5: Get front window position/size for coordinate offset on replay
  async function getWindowBounds() {
    try {
      const { execSync } = await import('child_process');
      // macOS 15+ AppleScript has a bug where `item N of position` returns
      // "N, " (trailing comma+space), breaking string concatenation.
      // Use Swift via Process instead for reliable bounds extraction.
      const swiftCmd =
        'swift -e \'import AppKit;let a=NSWorkspace.shared.frontmostApplication!;let l=CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as![[String:Any]];for w in l{if(w["kCGWindowOwnerPID"]as!Int)==a.processIdentifier,let b=w["kCGWindowBounds"]as?[String:Double]{print("\\(b["X"]!),\\(b["Y"]!),\\(b["Width"]!),\\(b["Height"]!)");break}}\'';
      const result = execSync(swiftCmd, { encoding: 'utf8', timeout: 5000 }).trim();
      if (!result) return null;
      const [x, y, w, h] = result.split(',').map(Number);
      if ([x, y, w, h].some(isNaN)) return null;
      return { x, y, width: w, height: h };
    } catch {
      return null;
    }
  }

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
    // Also serve public/ for CSS, JS, manifest (moved there for Vite compatibility)
    const publicDir = path.join(__dirname, 'public');
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir, { fallthrough: true }));
    }
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

        // Hermes Linka: Teach mode — start/stop recording
        if (data.type === 'teach_start') {
          if (typeof input.teachStart === 'function') {
            try {
              const status = await input.teachStart();
              // Phase 2: Capture reference screenshot and window bounds
              if (captureScreen && typeof captureScreen === 'function') {
                try {
                  ws._teachScreenshot = await captureScreen();
                  console.log('[teach] Reference screenshot captured.');
                } catch (err) {
                  console.warn('[teach] Screenshot capture failed:', err?.message || err);
                  ws._teachScreenshot = null;
                }
              }
              // Fallback: use macOS screencapture CLI when Electron desktopCapturer fails
              if (!ws._teachScreenshot && process.platform === 'darwin') {
                try {
                  const { execSync } = await import('child_process');
                  const tmpPath = '/tmp/linka_teach_screenshot.png';
                  execSync(`screencapture -x -C -t png "${tmpPath}"`, { timeout: 5000 });
                  const fs = await import('fs');
                  const buf = fs.readFileSync(tmpPath);
                  ws._teachScreenshot = `data:image/png;base64,${buf.toString('base64')}`;
                  fs.unlinkSync(tmpPath);
                  console.log('[teach] Reference screenshot captured via screencapture fallback.');
                } catch (fallbackErr) {
                  console.warn(
                    '[teach] Screencapture fallback also failed:',
                    fallbackErr?.message || fallbackErr,
                  );
                  ws._teachScreenshot = null;
                }
              }
              ws._teachWindowBounds = await getWindowBounds();
              if (ws._teachWindowBounds) {
                console.log(
                  `[teach] Window bounds: ${ws._teachWindowBounds.x},${ws._teachWindowBounds.y} ${ws._teachWindowBounds.width}x${ws._teachWindowBounds.height}`,
                );
              }
              sendJson(ws, { event: 'teach_status', payload: status });
            } catch (error) {
              sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
            }
          } else {
            sendJson(ws, {
              event: 'teach_error',
              payload: { message: 'Teach not available on this platform.' },
            });
          }
          return;
        }
        if (data.type === 'teach_stop') {
          if (typeof input.teachStop === 'function') {
            try {
              const result = await input.teachStop();
              sendJson(ws, { event: 'teach_events', payload: result });
            } catch (error) {
              sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
            }
          } else {
            sendJson(ws, {
              event: 'teach_error',
              payload: { message: 'Teach not available on this platform.' },
            });
          }
          return;
        }

        // Hermes Linka: save recorded workflow as a skill
        if (data.event === 'teach_save') {
          const { name, events, app, app_history, user_prompt } = data.payload || {};
          if (!name || !Array.isArray(events)) {
            sendJson(ws, { event: 'teach_error', payload: { message: 'Missing name or events.' } });
            return;
          }
          try {
            const skillDir = path.join(os.homedir(), '.hermes', 'skills', 'linka');
            fs.mkdirSync(skillDir, { recursive: true });
            const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
            const filePath = path.join(skillDir, `${safeName}.md`);

            // Phase 2: Save reference screenshot alongside skill
            let hasScreenshot = false;
            const screenshot = ws._teachScreenshot;
            if (
              screenshot &&
              typeof screenshot === 'string' &&
              screenshot.startsWith('data:image/')
            ) {
              try {
                const screenshotPath = path.join(skillDir, `${safeName}.png`);
                const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
                fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
                hasScreenshot = true;
                console.log(`[teach] Screenshot saved: ${screenshotPath}`);
              } catch (_) {
                /* non-fatal */
              }
            }
            delete ws._teachScreenshot;

            const content = generateTeachSkill(
              name,
              events,
              app || {},
              hasScreenshot,
              ws._teachWindowBounds,
              app_history || null,
              user_prompt || null,
            );
            delete ws._teachWindowBounds;
            fs.writeFileSync(filePath, content);
            console.log(`[teach] Skill saved: ${filePath}`);
            sendJson(ws, {
              event: 'teach_saved',
              payload: { name: safeName, path: filePath, hasScreenshot },
            });
          } catch (error) {
            console.error('[teach] Save failed:', error);
            sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
          }
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
    // Hermes Linka: expose the input adapter for event capture
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
