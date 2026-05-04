import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInputAdapter } from './input-adapter.js';

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

function createSessionId() {
  return randomUUID();
}

function createSecretToken() {
  return randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url');
}

function tokenMatches(actual, provided) {
  if (typeof actual !== 'string' || typeof provided !== 'string') return false;

  const actualBuffer = Buffer.from(actual);
  const providedBuffer = Buffer.from(provided);
  if (actualBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, providedBuffer);
}

function withPairingParams(baseUrl, sessionId, pairingToken) {
  const url = new URL(baseUrl);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('pairingToken', pairingToken);
  return url.toString();
}

function getBridgeContentBytes(content) {
  if (typeof content !== 'string') return 0;

  const base64 = content.startsWith('data:') ? content.slice(content.indexOf(',') + 1) : content;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function resolveDefaultPort() {
  if (process.env.NODE_ENV === 'production') {
    return Number(process.env.PORT || 3067);
  }

  return Number(process.env.LINKA_PORT || 3000);
}

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

function isLikelyVirtualAdapter(name, address) {
  const label = String(name || '').toLowerCase();
  return (
    /virtual|virtualbox|vmware|hyper-v|vethernet|host-only|bluetooth|docker|wsl|loopback|tailscale|zerotier|npcap|tunnel/.test(
      label,
    ) ||
    address.startsWith('169.254.') ||
    address.startsWith('192.168.56.')
  );
}

function scoreNetworkCandidate(name, address) {
  let score = 0;
  const label = String(name || '').toLowerCase();

  if (
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  ) {
    score += 50;
  }
  if (/wi-?fi|wireless|wlan/.test(label)) score += 40;
  if (/ethernet|lan/.test(label)) score += 25;
  if (isLikelyVirtualAdapter(name, address)) score -= 100;
  if (address.endsWith('.1')) score -= 15;

  return score;
}

function getNetworkCandidates(port) {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        const score = scoreNetworkCandidate(name, entry.address);
        candidates.push({
          name,
          address: entry.address,
          url: `http://${entry.address}:${port}`,
          likelyVirtual: isLikelyVirtualAdapter(name, entry.address),
          score,
        });
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function getConnectionInfo(port) {
  const candidates = getNetworkCandidates(port);
  const recommended =
    candidates.find((candidate) => !candidate.likelyVirtual) || candidates[0] || null;
  return {
    bindHost: BIND_HOST,
    port,
    localhostUrl: `http://localhost:${port}`,
    primaryUrl: recommended?.url || `http://localhost:${port}`,
    urls: [`http://localhost:${port}`, ...candidates.map((candidate) => candidate.url)],
    candidates,
  };
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

function generateTeachSkill(name, events, app, hasScreenshot = false, windowBounds = null) {
  const now = new Date().toISOString();
  const appName = app?.name || 'unknown';
  const prefix = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  const steps = events
    .map((e, i) => {
      const ts = new Date(e.ts * 1000).toISOString().slice(11, 23);
      const mods = e.modifiers?.length ? e.modifiers.join('+') + '+' : '';
      switch (e.type) {
        case 'mouse_moved':
          return `${i + 1}. [${ts}] Move mouse to (${e.x?.toFixed(0)}, ${e.y?.toFixed(0)})`;
        case 'left_down':
          return `${i + 1}. [${ts}] Left click down at (${e.x?.toFixed(0)}, ${e.y?.toFixed(0)})`;
        case 'left_up':
          return `${i + 1}. [${ts}] Left click up at (${e.x?.toFixed(0)}, ${e.y?.toFixed(0)})`;
        case 'right_down':
          return `${i + 1}. [${ts}] Right click down at (${e.x?.toFixed(0)}, ${e.y?.toFixed(0)})`;
        case 'right_up':
          return `${i + 1}. [${ts}] Right click up at (${e.x?.toFixed(0)}, ${e.y?.toFixed(0)})`;
        case 'scroll':
          return `${i + 1}. [${ts}] Scroll ${e.dy > 0 ? 'down' : 'up'} by ${Math.abs(e.dy || 0)}px`;
        case 'key_combo':
          return `${i + 1}. [${ts}] Press ${mods}${e.key || '?'}`;
        case 'mouse_drag':
          return `${i + 1}. [${ts}] Drag to (${e.x?.toFixed(0)}, ${e.y?.toFixed(0)})`;
        default:
          return `${i + 1}. [${ts}] ${e.type}`;
      }
    })
    .join('\n');

  const stepCount = events.length;

  const appContext = appName !== 'unknown'
    ? `in **${appName}**`
    : `on macOS`;

  const screenshotSection = hasScreenshot
    ? `\n## 📸 Reference Screenshot\n\n\`~/.hermes/skills/linka/${prefix}.png\` — captured at recording time. Use with \`vision_analyze\` to locate UI elements when the window has moved.\n\n**Usage:** \`vision_analyze(image_url="~/.hermes/skills/linka/${prefix}.png", question="Describe the UI elements visible at each click coordinate")\`\n`
    : '';

  const windowSection = windowBounds
    ? `\n## 🪟 Window Position (at recording)\n\n- **App:** ${appName}\n- **Position:** (${windowBounds.x}, ${windowBounds.y})\n- **Size:** ${windowBounds.width}×${windowBounds.height}\n\nTo replay after the window moved:\n1. Get current window position via AppleScript: \`osascript -e 'tell application "System Events" to get position of front window of first process whose frontmost is true'\`\n2. Calculate offset: \`offsetX = currentX - ${windowBounds.x}\`, \`offsetY = currentY - ${windowBounds.y}\`\n3. Adjust all click coordinates: \`newX = recordedX + offsetX\`, \`newY = recordedY + offsetY\`\n`
    : '';

  return `---
name: ${prefix}
description: Auto-generated from Linka Teach — recorded from ${appName} on ${now.slice(0, 10)}
version: 1.0.0
app: ${appName}
events: ${stepCount}
screenshot: ${hasScreenshot}
windowBounds: ${windowBounds ? JSON.stringify(windowBounds) : 'null'}
---

# ${name}

Workflow recorded ${appContext} on ${now.slice(0, 10)} (${stepCount} events).

## Steps

${steps}
${screenshotSection}${windowSection}
## 🤖 Hermes Usage

To replay this workflow:

1. Open **${appName}** and bring it to the foreground.
2. Take a current screenshot via Linka bridge_capture_request or \`screencapture\` CLI.
3. Use \`vision_analyze\` with the reference screenshot to locate each click target on the current screen. Recalculate coordinates if the window moved.
4. Execute each click at the adjusted coordinates using CGEvent at \`.cghidEventTap\` (Quartz-space, origin bottom-left).
5. Insert a 300-500ms delay between clicks for UI responsiveness.
6. Use \`vision_analyze\` as a double-check: after each click, verify the expected UI change (button highlight, new panel, text appearing). If the result doesn't match the reference, pause and ask the user.
7. Use OCR via \`vision_analyze\` on the current screen to confirm you're clicking the right button/label — cross-reference with the reference screenshot's visible text.

**Replay command:** screenshot → compare → recalculate → click → verify. Repeat for each step.

## Raw Events

\`\`\`json
${JSON.stringify(events, null, 2)}
\`\`\`
`;
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

  // Helper: get foreground app info via AppleScript
  async function getForegroundAppInfo() {
    try {
      const { execSync } = await import('child_process');
      const name = execSync(
        `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
        { encoding: 'utf8', timeout: 3000 },
      ).trim();
      const bundleId = execSync(
        `osascript -e 'tell application "System Events" to get bundle identifier of first process whose frontmost is true' 2>/dev/null || echo ""`,
        { encoding: 'utf8', timeout: 3000 },
      ).trim();
      const windowTitle = execSync(
        `osascript -e 'tell application "System Events" to get title of front window of first process whose frontmost is true' 2>/dev/null || echo ""`,
        { encoding: 'utf8', timeout: 3000 },
      ).trim();
      return { name, bundleId: bundleId || null, windowTitle: windowTitle || null };
    } catch {
      return { name: 'unknown', bundleId: null, windowTitle: null };
    }
  }

  // Phase 2.5: Get front window position/size for coordinate offset on replay
  async function getWindowBounds() {
    try {
      const { execSync } = await import('child_process');
      // macOS 15+ AppleScript has a bug where `item N of position` returns
      // "N, " (trailing comma+space), breaking string concatenation.
      // Use Swift via Process instead for reliable bounds extraction.
      const swiftCmd = 'swift -e \'import AppKit;let a=NSWorkspace.shared.frontmostApplication!;let l=CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as![[String:Any]];for w in l{if(w["kCGWindowOwnerPID"]as!Int)==a.processIdentifier,let b=w["kCGWindowBounds"]as?[String:Double]{print("\\(b["X"]!),\\(b["Y"]!),\\(b["Width"]!),\\(b["Height"]!)");break}}\'';
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
        const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
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
              ws._teachWindowBounds = await getWindowBounds();
              if (ws._teachWindowBounds) {
                console.log(`[teach] Window bounds: ${ws._teachWindowBounds.x},${ws._teachWindowBounds.y} ${ws._teachWindowBounds.width}x${ws._teachWindowBounds.height}`);
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
          const { name, events, app } = data.payload || {};
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
            if (screenshot && typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
              try {
                const screenshotPath = path.join(skillDir, `${safeName}.png`);
                const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
                fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
                hasScreenshot = true;
                console.log(`[teach] Screenshot saved: ${screenshotPath}`);
              } catch (_) { /* non-fatal */ }
            }
            delete ws._teachScreenshot;

            const content = generateTeachSkill(name, events, app || {}, hasScreenshot, ws._teachWindowBounds);
            delete ws._teachWindowBounds;
            fs.writeFileSync(filePath, content);
            console.log(`[teach] Skill saved: ${filePath}`);
            sendJson(ws, { event: 'teach_saved', payload: { name: safeName, path: filePath, hasScreenshot } });
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
  if (serverAddress && typeof serverAddress === 'object' && typeof serverAddress.port === 'number') {
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
