import { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tray = null;
let statusWindow = null;
let serverInfo = null;

const gotTheLock = app.requestSingleInstanceLock();
const iconPath = path.join(__dirname, 'build', 'icon.ico');
const APP_NAME = 'Linka';
const APP_ID = 'com.linka.desktop';

ipcMain.handle('copy-text', (_event, value) => {
  clipboard.writeText(String(value || ''));
  return true;
});

ipcMain.handle('open-url', (_event, value) => {
  shell.openExternal(String(value || ''));
  return true;
});

function getPrimaryLanUrl() {
  return serverInfo?.primaryUrl || serverInfo?.urls?.find((url) => !url.includes('localhost')) || serverInfo?.urls?.[0] || 'http://localhost:3000';
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

function buildQrCodeUrl(value) {
  const encoded = encodeURIComponent(value);
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encoded}`;
}

function buildConnectionHtml() {
  const primaryUrl = getPrimaryLanUrl();
  const qrUrl = buildQrCodeUrl(primaryUrl);
  const nativeState = serverInfo?.nativeInputReady
    ? 'Ready'
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
        <img src="${escapeHtml(qrUrl)}" alt="QR code for ${escapeHtml(primaryUrl)}">
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
  statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildConnectionHtml())}`);
  statusWindow.on('closed', () => {
    statusWindow = null;
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
  app.on('ready', async () => {
    app.setAppUserModelId(APP_ID);

    if (app.isPackaged) {
      process.env.NODE_ENV = 'production';
    }

    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      process.env.LINKA_LOG_FILE = path.join(logDir, 'linka.log');
      serverInfo = await startServer();
    } catch (error) {
      console.error(`Failed to start ${APP_NAME} server:`, error);
      app.quit();
      return;
    }

    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    rebuildTray();
    showConnectionWindow();

    if (app.dock) app.dock.hide();
  });
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
