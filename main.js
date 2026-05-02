import { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, ipcMain, nativeImage, screen, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import {
  capturePlatformScreenFallback,
  configurePlatformAutoStart,
  getPlatformTrayIconPath,
} from './platform/desktop.js';
import { startServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tray = null;
let statusWindow = null;
let serverInfo = null;

const gotTheLock = app.requestSingleInstanceLock();
const iconPath = getPlatformTrayIconPath(__dirname);
const APP_NAME = 'Linka';
const APP_ID = 'com.linka.desktop';
const START_HIDDEN_ARG = '--hidden';
const AUTO_START_ENABLED = true;
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

function getPrimaryLanUrl() {
  const PORT = getElectronPort();
  return serverInfo?.primaryUrl || serverInfo?.urls?.find((url) => !url.includes('localhost')) || serverInfo?.urls?.[0] || `http://localhost:${PORT}`;
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

async function buildQrDataUrl(value) {
  return QRCode.toDataURL(value, {
    width: 220,
    margin: 3,
    color: { dark: '#000', light: '#fff' },
  });
}

async function buildConnectionHtml() {
  const primaryUrl = getPrimaryLanUrl();
  const qrDataUrl = await buildQrDataUrl(primaryUrl);
  const nativeState = serverInfo?.nativeInputReady
    ? 'Ready'
    : serverInfo?.permissionMissing
      ? 'Permissions Missing'
      : 'Input not ready';

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>${APP_NAME}</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          width: 100vw;
          height: 100vh;
          display: grid;
          place-items: center;
          background: #101214;
          color: #eef3f0;
          font-family: Segoe UI, Arial, sans-serif;
        }
        main {
          width: 320px;
          text-align: center;
        }
        h1 {
          margin: 0 0 14px;
          font-size: 22px;
          font-weight: 700;
        }
        img {
          width: 240px;
          height: 240px;
          display: block;
          margin: 0 auto;
          padding: 10px;
          border-radius: 10px;
          background: #fff;
        }
        p {
          margin: 14px 0 0;
          color: #aab8b3;
          font-size: 14px;
          line-height: 1.35;
        }
        .status {
          margin-top: 12px;
          color: #00d98b;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
      </style>
    </head>
    <body>
      <main>
        <h1>${APP_NAME}</h1>
        <img src="${escapeHtml(qrDataUrl)}" alt="QR code for ${escapeHtml(primaryUrl)}">
        <p>Scan with your phone camera.</p>
        <div class="status">${nativeState}</div>
      </main>
    </body>
  </html>`;
}

function showConnectionWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 420,
    height: 430,
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
  buildConnectionHtml().then((html) => {
    statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
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
  const nativeLabel = serverInfo?.nativeInputReady
    ? `Input: ${serverInfo.inputBackend}`
    : `Input: ${serverInfo?.inputBackend || 'not ready'}`;

  const contextMenu = Menu.buildFromTemplate([
    { label: `${APP_NAME} Status: Running`, enabled: false },
    { label: nativeLabel, enabled: false },
    { label: `Phone URL: ${primaryUrl}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Connection Info', click: showConnectionWindow },
    { label: 'Open Controller on This PC', click: () => shell.openExternal(primaryUrl) },
    {
      label: 'Copy Phone URL',
      click: () => {
        clipboard.writeText(primaryUrl);
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
        onClientConnected: () => {
          // ensure we close the window on the main thread
          setImmediate(() => {
            closeConnectionWindow();
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

    if (app.dock) app.dock.hide();
  });
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
