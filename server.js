import express from 'express';
import { createServer as createHttpServer } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInputAdapter } from './input-adapter.js';
import { resolveDefaultPort, getConnectionInfo } from './server/network.js';
import { generateTeachSkill } from './server/skill-generator.js';
import { createSessionStore } from './server/sessions/store.js';
import { createBridgeStore } from './server/bridge/store.js';
import { createTeachMessageHandler } from './server/hermes/teach-handler.js';
import { registerSystemRoutes } from './server/routes/system.js';
import { createWebSocketLayer } from './server/websocket/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIND_HOST = '0.0.0.0';
const FAVICON_PATH = path.join(__dirname, 'build', 'linka-icon.ico');
const WEB_ICON_PATH = path.join(__dirname, 'build', 'linka-logo.png');
const HERMES_INBOX = path.join(os.homedir(), '.hermes', 'linka', 'inbox');
let loggingReady = false;

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
  let connectionInfo = getConnectionInfo(port);
  let input;
  let websocketLayer;
  const sendJson = (ws, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  };

  input =
    options.inputAdapter ||
    (await createInputAdapter({
    onStateChange: (state) => {
      if (state.retrying) {
        console.warn(`[input] Backend degraded: ${input.name} (retry ${state.retryCount})`);
      } else if (state.recovered) {
        console.warn('[input] Backend recovered.');
      } else if (state.retriesExhausted) {
        console.warn('[input] Backend permanently unavailable.');
      }

      websocketLayer?.broadcast({
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
  }));

  const sessions = createSessionStore({
    connectionInfo,
    onClientConnected,
    sendJson,
    input,
  });

  function resetPairing() {
    const session = sessions.resetPairing();

    websocketLayer.broadcast({
      event: 'session_reset',
      payload: {
        message: 'Pairing was reset on the desktop app.',
      },
    });
    websocketLayer.closeAllClients(4001, 'Pairing reset');

    console.log(`[session] Pairing reset. Session ${session.sessionId}`);
    return session;
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
  const getStatus = () => ({
    product: 'LINKA',
    status: 'running',
    sessionId: sessions.getSessionSnapshot().sessionId,
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
    clients: websocketLayer?.clients.size || 0,
  });

  const getHermesEvents = async (_req, res) => {
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
  };

  // Phase 2: Pattern detection — scan inbox for recurring workflows
  // and suggest skill names with confidence scores.
  const getHermesSuggestions = async (_req, res) => {
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
  };

  registerSystemRoutes(app, {
    faviconPath: FAVICON_PATH,
    webIconPath: WEB_ICON_PATH,
    getStatus,
    getHermesEvents,
    getHermesSuggestions,
  });

  const handleTeachMessage = createTeachMessageHandler({
    input,
    captureScreen,
    sendJson,
    generateTeachSkill,
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

  websocketLayer = createWebSocketLayer({
    server,
    input,
    bridgeCaptureAvailable: captureAvailable,
    sessions,
    bridgeFactory: ({ sendJson, broadcast }) =>
      createBridgeStore({
        captureScreen,
        getDisplays,
        sendJson,
        broadcast,
      }),
    onTeachMessage: handleTeachMessage,
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
    sessions.updateConnectionInfo(connectionInfo);
  }

  console.log(`[net] Bind address: ${connectionInfo.bindHost}:${port}`);
  console.log(`[net] Recommended phone URL: ${connectionInfo.primaryUrl}`);
  console.log(`[net] Pairing URL: ${sessions.getSessionSnapshot().pairingUrl}`);
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
    ...sessions.getSessionSnapshot(),
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
      websocketLayer.dispose();
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
