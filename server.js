import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInputAdapter } from './input-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = Number(process.env.LINKA_PORT || 3000);
const BIND_HOST = '0.0.0.0';
const MAX_BRIDGE_MESSAGES = 30;
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
      const line = args.map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch (_error) {
          return String(arg);
        }
      }).join(' ');

      fs.appendFile(logFile, `[${new Date().toISOString()}] [${method}] ${line}\n`, () => {});
      original(...args);
    };
  }
}

function isLikelyVirtualAdapter(name, address) {
  const label = String(name || '').toLowerCase();
  return /virtual|virtualbox|vmware|hyper-v|vethernet|host-only|bluetooth|docker|wsl|loopback|tailscale|zerotier|npcap|tunnel/.test(label)
    || address.startsWith('169.254.')
    || address.startsWith('192.168.56.');
}

function scoreNetworkCandidate(name, address) {
  let score = 0;
  const label = String(name || '').toLowerCase();

  if (address.startsWith('192.168.') || address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
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
  const recommended = candidates.find((candidate) => !candidate.likelyVirtual) || candidates[0] || null;
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
    console.log(`[http] ${remote} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms`);
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

  const type = message.type === 'image' ? 'image' : message.type === 'text' ? 'text' : null;
  const from = message.from === 'pc' ? 'pc' : message.from === 'phone' ? 'phone' : null;
  const content = typeof message.content === 'string' ? message.content : '';

  if (!type || !from || !content) return null;

  return {
    id: typeof message.id === 'string' && message.id ? message.id : randomUUID(),
    type,
    content,
    from,
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Date.now(),
  };
}

export async function startServer(options = {}) {
  setupFileLogging();
  const port = Number(options.port || DEFAULT_PORT);
  const onClientConnected = typeof options.onClientConnected === 'function'
    ? options.onClientConnected
    : null;
  const captureScreen = typeof options.captureScreen === 'function'
    ? options.captureScreen
    : null;
  const app = express();
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server });
  const input = await createInputAdapter();
  const clients = new Set();
  const connectionInfo = getConnectionInfo(port);

  function sendJson(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  function broadcast(data) {
    for (const client of clients) {
      sendJson(client, data);
    }
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
        const content = await captureScreen();
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

    if (data.event === 'bridge_message') {
      const message = normalizeBridgeMessage(data.payload);
      if (!message) {
        console.warn('[ws] Invalid bridge message ignored.');
        return true;
      }

      appendBridgeMessage(message);
      broadcast({ event: 'bridge_message', payload: message });
      return true;
    }

    return false;
  }

  app.disable('x-powered-by');
  app.use(logRequest);
  app.use(preventBrowserCache);

  app.get('/api/status', (_req, res) => {
    res.json({
      product: 'LINKA',
      status: 'running',
      port,
      bindHost: connectionInfo.bindHost,
      primaryUrl: connectionInfo.primaryUrl,
      localhostUrl: connectionInfo.localhostUrl,
      urls: connectionInfo.urls,
      candidates: connectionInfo.candidates,
      inputBackend: input.name,
      nativeInputReady: input.ready,
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
    console.log(`[ws] Client connected from ${req.socket.remoteAddress}. Total clients: ${clients.size}`);
    onClientConnected?.({
      clients: clients.size,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    });
    sendJson(ws, { type: 'hello', inputBackend: input.name, nativeInputReady: input.ready });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (!(await handleBridgeEvent(ws, data))) {
          handleCommand(input, data);
        }
      } catch (error) {
        console.error('[ws] Error processing message:', error);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected. Total clients: ${clients.size}`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, resolve);
  });

  console.log(`[net] Bind address: ${connectionInfo.bindHost}:${port}`);
  console.log(`[net] Recommended phone URL: ${connectionInfo.primaryUrl}`);
  console.log(`[net] Localhost URL: ${connectionInfo.localhostUrl}`);
  console.log(`[net] Candidates: ${connectionInfo.candidates.map((candidate) => `${candidate.url} (${candidate.name}, score=${candidate.score}${candidate.likelyVirtual ? ', virtual/link-local' : ''})`).join(' | ') || 'none'}`);
  console.log(`Input backend: ${input.name}${input.ready ? '' : ' (not controlling native input)'}`);

  return {
    port,
    bindHost: connectionInfo.bindHost,
    primaryUrl: connectionInfo.primaryUrl,
    localhostUrl: connectionInfo.localhostUrl,
    urls: connectionInfo.urls,
    candidates: connectionInfo.candidates,
    inputBackend: input.name,
    nativeInputReady: input.ready,
    close: async () => {
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
