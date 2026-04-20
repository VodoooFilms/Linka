import express from 'express';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInputAdapter } from './input-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = Number(process.env.LINKA_PORT || 3000);
const BIND_HOST = '0.0.0.0';
let loggingReady = false;

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

export async function startServer(options = {}) {
  setupFileLogging();
  const port = Number(options.port || DEFAULT_PORT);
  const onClientConnected = typeof options.onClientConnected === 'function'
    ? options.onClientConnected
    : null;
  const app = express();
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server });
  const input = await createInputAdapter();
  await input.waitForInitialStatus?.();
  const clients = new Set();
  const connectionInfo = getConnectionInfo(port);

  app.disable('x-powered-by');
  app.use(logRequest);
  app.use(preventBrowserCache);

  app.get('/api/status', (_req, res) => {
    res.json({
      product: 'LINKA',
      status: 'running',
      hostPlatform: process.platform,
      port,
      bindHost: connectionInfo.bindHost,
      primaryUrl: connectionInfo.primaryUrl,
      localhostUrl: connectionInfo.localhostUrl,
      urls: connectionInfo.urls,
      candidates: connectionInfo.candidates,
      inputBackend: input.name,
      nativeInputReady: input.ready,
      inputWarning: input.warning || undefined,
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
    ws.send(JSON.stringify({
      type: 'hello',
      hostPlatform: process.platform,
      inputBackend: input.name,
      nativeInputReady: input.ready,
      inputWarning: input.warning || undefined,
    }));

    ws.on('message', (message) => {
      try {
        handleCommand(input, JSON.parse(message.toString()));
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
  if (input.warning) {
    console.warn(`[input] ${input.warning}`);
  }

  return {
    port,
    bindHost: connectionInfo.bindHost,
    primaryUrl: connectionInfo.primaryUrl,
    localhostUrl: connectionInfo.localhostUrl,
    urls: connectionInfo.urls,
    candidates: connectionInfo.candidates,
    inputBackend: input.name,
    nativeInputReady: input.ready,
    inputWarning: input.warning || undefined,
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
