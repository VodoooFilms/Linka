import { spawnSync } from 'child_process';
import path from 'path';

const DEFAULT_WINDOWS_STARTUP_REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function captureAllScreensWithPowerShell() {
  const script = `
Add-Type @"
using System.Runtime.InteropServices;
public static class DpiAwareness {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@
[void][DpiAwareness]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      maxBuffer: 60 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'PowerShell screen capture failed.');
  }

  const base64 = result.stdout.trim();
  if (!base64) {
    throw new Error('PowerShell screen capture returned an empty image.');
  }

  return `data:image/png;base64,${base64}`;
}

function runRegistryCommand(args) {
  const result = spawnSync('reg.exe', args, {
    stdio: 'ignore',
    windowsHide: true,
  });

  return result.status === 0;
}

export function getPlatformTrayIconPath(rootDir) {
  if (process.platform === 'darwin') {
    return path.join(rootDir, 'build', 'linka-logo.png');
  }

  return path.join(rootDir, 'build', 'linka-icon.ico');
}

export function capturePlatformScreenFallback() {
  if (process.platform === 'win32') {
    return captureAllScreensWithPowerShell();
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('screencapture', ['-C', '-x', '-t', 'png', '-'], {
      encoding: 'buffer',
      maxBuffer: 60 * 1024 * 1024,
      timeout: 15000,
    });

    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
      throw new Error(
        result.stderr?.toString()?.trim() || 'screencapture failed to produce an image.',
      );
    }

    return `data:image/png;base64,${result.stdout.toString('base64')}`;
  }

  throw new Error('Screen capture is not available on this platform.');
}

export function isStartupRegistrationSupported(app) {
  return process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;
}

export function configurePlatformAutoStart({
  app,
  appName,
  enabled,
  startHiddenArg,
  startupRegPath = DEFAULT_WINDOWS_STARTUP_REG_PATH,
}) {
  if (!enabled) {
    return false;
  }

  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [startHiddenArg],
    });
    return true;
  }

  if (!isStartupRegistrationSupported(app)) {
    return false;
  }

  const command = `"${process.execPath}" ${startHiddenArg}`;
  return runRegistryCommand([
    'add',
    startupRegPath,
    '/v',
    appName,
    '/t',
    'REG_SZ',
    '/d',
    command,
    '/f',
  ]);
}
