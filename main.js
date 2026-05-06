import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  Tray,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  shell,
} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import {
  capturePlatformScreenFallback,
  configurePlatformAutoStart,
  getPlatformTrayIconPath,
} from './platform/desktop.js';
import { getForegroundAppInfo, startServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tray = null;
let statusWindow = null;
let serverInfo = null;
let lastClientEvent = null;

const gotTheLock = app.requestSingleInstanceLock();
const iconPath = getPlatformTrayIconPath(__dirname);
const APP_NAME = 'Linka';
const APP_ID = 'com.linka.desktop';
const START_HIDDEN_ARG = '--hidden';
const AUTO_START_ENABLED = process.env.LINKA_AUTO_START === 'true' || false;
const DEFAULT_PRODUCTION_PORT = 3067;

function getElectronPort() {
  return Number(process.env.PORT || DEFAULT_PRODUCTION_PORT);
}

ipcMain.handle('copy-text', (_event, value) => {
  clipboard.writeText(String(value || ''));
  return true;
});

ipcMain.handle('open-url', (_event, value) => {
  shell.openExternal(String(value || ''));
  return true;
});

ipcMain.handle('reset-pairing', async () => {
  const nextSession = serverInfo?.resetPairing?.();
  syncSessionInfo(nextSession);
  rebuildTray();
  await refreshConnectionWindow();
  return {
    pairingUrl: getPairingUrl(),
    primaryUrl: getPrimaryLanUrl(),
  };
});

ipcMain.handle('close-window', () => {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.close();
  }
  return true;
});

function getPrimaryLanUrl() {
  const PORT = getElectronPort();
  return (
    serverInfo?.primaryUrl ||
    serverInfo?.urls?.find((url) => !url.includes('localhost')) ||
    serverInfo?.urls?.[0] ||
    `http://localhost:${PORT}`
  );
}

function getPairingUrl() {
  return serverInfo?.pairingUrl || getPrimaryLanUrl();
}

function syncSessionInfo(nextSessionInfo) {
  if (!serverInfo || !nextSessionInfo) return;
  Object.assign(serverInfo, nextSessionInfo);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getHostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return url;
  }
}

function buildDesktopBridgeUrl(url) {
  try {
    const nextUrl = new URL(url);
    nextUrl.hash = 'bridge';
    return nextUrl.toString();
  } catch (_error) {
    return `${url}#bridge`;
  }
}

async function buildQrDataUrl(value) {
  return QRCode.toDataURL(value, {
    width: 220,
    margin: 3,
    color: { dark: '#000', light: '#fff' },
  });
}

function buildLocalImageDataUrl(filePath) {
  try {
    const extension = path.extname(filePath).toLowerCase();
    const mimeType =
      extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : null;
    if (!mimeType) return '';
    const content = fs.readFileSync(filePath);
    return `data:${mimeType};base64,${content.toString('base64')}`;
  } catch (_error) {
    return '';
  }
}

async function buildConnectionHtml() {
  const primaryUrl = getPrimaryLanUrl();
  const pairingUrl = getPairingUrl();
  const qrDataUrl = await buildQrDataUrl(pairingUrl);
  const logoDataUrl = buildLocalImageDataUrl(path.join(__dirname, 'build', 'linka-logo.png'));
  const nativeState = serverInfo?.nativeInputReady
    ? 'Input Ready'
    : serverInfo?.permissionMissing
      ? 'Permissions Missing'
      : 'Input not ready';
  const inputMessage = serverInfo?.message || 'Scan the QR code from your phone to pair.';
  const desktopUrl = serverInfo?.localhostPairingUrl || `http://localhost:${getElectronPort()}`;
  const desktopBridgeUrl = buildDesktopBridgeUrl(desktopUrl);
  const hostLabel = getHostFromUrl(primaryUrl);

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${APP_NAME}</title>
      <style>
        * { box-sizing: border-box; }
        :root {
          color-scheme: dark;
          --bg: #0a0d10;
          --panel: rgba(15, 20, 24, 0.97);
          --line: rgba(255, 255, 255, 0.08);
          --text: #eef4f2;
          --muted: #8ca097;
          --accent: #00d98b;
          font-family: "Segoe UI", Roboto, Arial, sans-serif;
        }
        body {
          margin: 0;
          min-height: 100vh;
          overflow: hidden;
          background: linear-gradient(180deg, #0a0d10, #090b0d);
          color: var(--text);
        }
        body, button {
          font: inherit;
        }
        main {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 20px;
        }
        .card {
          width: min(360px, 100%);
          padding: 22px 24px 24px;
          display: grid;
          gap: 14px;
          border: 1px solid var(--line);
          border-radius: 20px;
          background: var(--panel);
          box-shadow: 0 18px 60px rgba(0, 0, 0, 0.34);
        }
        .logo {
          width: 126px;
          height: 126px;
          margin: 0 auto;
          object-fit: contain;
          background: transparent;
          border-radius: 24px;
        }
        h1 {
          margin: 0;
          font-size: 26px;
          line-height: 1;
          letter-spacing: -0.03em;
          text-align: center;
        }
        p {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.45;
          text-align: center;
        }
        .qr {
          width: 100%;
          max-width: 252px;
          margin: 0 auto;
          padding: 12px;
          border-radius: 18px;
          background: #fff;
        }
        img {
          width: 100%;
          aspect-ratio: 1;
          display: block;
          border-radius: 12px;
          background: #fff;
        }
        .status {
          padding: 10px 12px;
          border: 1px solid var(--line);
          border-radius: 12px;
          font-size: 13px;
          text-align: center;
        }
        button {
          min-height: 44px;
          border: 0;
          border-radius: 12px;
          background: var(--accent);
          color: #052316;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 120ms ease, opacity 120ms ease;
        }
        button:hover {
          transform: translateY(-1px);
          opacity: 0.96;
        }
        .host {
          color: var(--muted);
          font-size: 12px;
          letter-spacing: 0.04em;
        }
      </style>
    </head>
    <body>
      <main>
        <section class="card">
          <img class="logo" src="${escapeHtml(logoDataUrl)}" alt="${APP_NAME} logo">
          <h1>${APP_NAME}</h1>
          <p>${escapeHtml(inputMessage)}</p>
          <div class="qr">
            <img src="${escapeHtml(qrDataUrl)}" alt="QR code for ${escapeHtml(primaryUrl)}">
          </div>
          <div class="status">${escapeHtml(nativeState)}</div>
          <button id="openDesktopBtn" type="button">Open Bridge</button>
          <p class="host">${escapeHtml(hostLabel)}</p>
        </section>
      </main>
      <script>
        const desktopBridgeUrl = ${JSON.stringify(desktopBridgeUrl)};
        const openDesktopBtn = document.getElementById('openDesktopBtn');

        openDesktopBtn.addEventListener('click', () => {
          window.linka?.openUrl?.(desktopBridgeUrl);
        });
      </script>
    </body>
  </html>`;
}

async function refreshConnectionWindow() {
  if (!statusWindow || statusWindow.isDestroyed()) {
    return;
  }

  const html = await buildConnectionHtml();
  statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function showConnectionWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: 380,
    minHeight: 720,
    resizable: false,
    title: APP_NAME,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'connection-preload.cjs'),
    },
  });

  statusWindow.setMenu(null);
  refreshConnectionWindow();
  statusWindow.on('closed', () => {
    statusWindow = null;
  });
}

function closeConnectionWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    // Hide the window immediately to improve perceived responsiveness
    statusWindow.hide();

    // Defer the actual close operation to avoid blocking the event loop
    // or causing macOS WindowServer hangs when the only window of a dock-hidden app closes.
    setTimeout(() => {
      if (statusWindow && !statusWindow.isDestroyed()) {
        statusWindow.close();
      }
    }, 150);
  }
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return nativeImage.createEmpty();
  }

  if (process.platform === 'darwin') {
    const sized = icon.resize({ width: 22, height: 22 });
    sized.setTemplateImage(true);
    return sized;
  }

  return icon;
}

function getAvailableDisplays() {
  const displays = screen.getAllDisplays();
  return displays.map((display, index) => ({
    id: String(display.id),
    label: `Monitor ${index + 1}`,
    bounds: display.bounds,
    isPrimary: index === 0,
  }));
}

async function capturePrimaryScreenWithElectron(targetDisplayId) {
  const displays = screen.getAllDisplays();
  const targetDisplay = targetDisplayId
    ? displays.find((d) => String(d.id) === targetDisplayId)
    : null;
  const display = targetDisplay || screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scaleFactor = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.round(width * scaleFactor),
    height: Math.round(height * scaleFactor),
  };

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
  });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No screen source was available.');
  }

  return `data:image/png;base64,${source.thumbnail.toPNG().toString('base64')}`;
}

async function captureAllScreens(targetDisplayId) {
  try {
    return await capturePrimaryScreenWithElectron(targetDisplayId);
  } catch (error) {
    console.warn(`[capture] Electron screen capture failed: ${error?.message || error}`);
  }

  return capturePlatformScreenFallback();
}

function shouldShowConnectionWindow() {
  return !process.argv.includes(START_HIDDEN_ARG);
}

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

function configureAutoStart() {
  configurePlatformAutoStart({
    app,
    appName: APP_NAME,
    enabled: AUTO_START_ENABLED && !isPortableBuild(),
    startHiddenArg: START_HIDDEN_ARG,
  });
}

function rebuildTray() {
  const primaryUrl = getPrimaryLanUrl();
  const pairingUrl = getPairingUrl();
  const nativeLabel = serverInfo?.nativeInputReady
    ? `Input: ${serverInfo.inputBackend}`
    : `Input: ${serverInfo?.inputBackend || 'not ready'}`;

  const contextMenu = Menu.buildFromTemplate([
    { label: `${APP_NAME} Status: Running`, enabled: false },
    { label: nativeLabel, enabled: false },
    { label: `Phone URL: ${primaryUrl}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Connection Info', click: showConnectionWindow },
    { label: 'Open Controller on This PC', click: () => shell.openExternal(pairingUrl) },
    {
      label: 'Copy Phone URL',
      click: () => {
        clipboard.writeText(pairingUrl);
      },
    },
    {
      label: 'Reset Pairing',
      click: async () => {
        const nextSession = serverInfo?.resetPairing?.();
        syncSessionInfo(nextSession);
        rebuildTray();
        if (statusWindow && !statusWindow.isDestroyed()) {
          const html = await buildConnectionHtml();
          statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        }
      },
    },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => app.quit() },
  ]);

  tray.setToolTip(`${APP_NAME}\n${primaryUrl}`);
  tray.setContextMenu(contextMenu);
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes(START_HIDDEN_ARG)) {
      showConnectionWindow();
    }
  });

  app.on('ready', async () => {
    app.setAppUserModelId(APP_ID);

    if (app.isPackaged) {
      process.env.NODE_ENV = 'production';
      process.env.PORT ||= String(DEFAULT_PRODUCTION_PORT);
    }

    configureAutoStart();

    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      process.env.LINKA_LOG_FILE = path.join(logDir, 'linka.log');
      serverInfo = await startServer({
        captureScreen: captureAllScreens,
        getDisplays: getAvailableDisplays,
        onClientConnected: (event) => {
          lastClientEvent = {
            ...event,
            connectedAt: Date.now(),
          };
          setImmediate(() => {
            refreshConnectionWindow();
          });
        },
      });
    } catch (error) {
      console.error(`Failed to start ${APP_NAME} server:`, error);
      app.quit();
      return;
    }

    tray = new Tray(createTrayIcon());
    rebuildTray();

    if (shouldShowConnectionWindow()) {
      showConnectionWindow();
    }

    // Hermes Linka: register global hotkey Ctrl+Shift+Cmd+L to dump events
    try {
      const hermesHotkey = 'CommandOrControl+Shift+Alt+L';
      const registered = globalShortcut.register(hermesHotkey, async () => {
        try {
          console.log('[hermes] Hotkey pressed. Dumping events...');
          const adapter = serverInfo?.inputAdapter;
          if (!adapter || typeof adapter.dumpEvents !== 'function') {
            console.warn('[hermes] Input adapter not ready for event dump.');
            return;
          }
          const result = await adapter.dumpEvents();

          // Get foreground app info via shared helper (single AppleScript call)
          let appContext = { name: 'unknown', bundleId: null, windowTitle: null };
          try {
            appContext = await getForegroundAppInfo();
          } catch (_e) {
            /* ignore */
          }

          const inbox = path.join(os.homedir(), '.hermes', 'linka', 'inbox');
          fs.mkdirSync(inbox, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `hotkey-${timestamp}-${appContext.name.replace(/[^a-zA-Z0-9]/g, '-')}.json`;
          const filePath = path.join(inbox, filename);
          const payload = {
            captured_at: new Date().toISOString(),
            source: 'linka-hotkey',
            app: appContext,
            ...result,
          };
          fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
          console.log(`[hermes] ${result.count} events dumped to ${filePath}`);
        } catch (error) {
          console.error('[hermes] Hotkey dump failed:', error);
        }
      });

      if (registered) {
        console.log(`[hermes] Hotkey ${hermesHotkey} registered for event capture.`);
      } else {
        console.warn(`[hermes] Hotkey ${hermesHotkey} registration failed (may be in use).`);
      }
    } catch (error) {
      console.warn('[hermes] Could not register hotkey:', error.message);
    }
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
