import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_RELATIVE_PATH = path.join('native', 'mac-input', 'bin', 'Linka.NativeInput');
const HELPER_SOURCE_PATH = path.join('native', 'mac-input', 'main.swift');

function getProjectRoot() {
  return path.join(__dirname, '..', '..');
}

function getHelperBinaryPath() {
  return path.join(getProjectRoot(), HELPER_RELATIVE_PATH);
}

function getHelperSourcePath() {
  return path.join(getProjectRoot(), HELPER_SOURCE_PATH);
}

function ensureHelperDirectory() {
  fs.mkdirSync(path.dirname(getHelperBinaryPath()), { recursive: true });
}

function tryBuildHelper() {
  const sourcePath = getHelperSourcePath();
  const helperPath = getHelperBinaryPath();

  if (!fs.existsSync(sourcePath)) {
    console.warn(`[input:macos] Missing helper source: ${sourcePath}`);
    return false;
  }

  ensureHelperDirectory();
  const result = spawnSync('xcrun', [
    'swiftc',
    '-O',
    '-framework',
    'ApplicationServices',
    '-framework',
    'AppKit',
    sourcePath,
    '-o',
    helperPath,
  ], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.warn('[input:macos] Failed to build native helper.');
    if (result.stderr?.trim()) console.warn(result.stderr.trim());
    return false;
  }

  try {
    fs.chmodSync(helperPath, 0o755);
    spawnSync('codesign', ['-s', '-', '-f', helperPath]);
  } catch (_error) {
    // Ignore chmod/codesign failures
  }

  return fs.existsSync(helperPath);
}

function ensureHelperBinary() {
  const helperPath = getHelperBinaryPath();
  if (fs.existsSync(helperPath)) {
    return helperPath;
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn(`[input:macos] Missing packaged native helper: ${helperPath}`);
    return null;
  }

  return tryBuildHelper() ? helperPath : null;
}

export function createMacOSInputAdapter(onStateChange) {
  if (process.platform !== 'darwin') {
    return null;
  }

  const helperPath = ensureHelperBinary();
  if (!helperPath) {
    return null;
  }

  let helper = null;
  let alive = false;
  let stdoutBuffer = '';
  let permissionGranted = false;
  let stateMessage = 'macOS native input is unavailable.';
  const responseResolvers = new Map();
  let pendingVolumeValue = null;
  let volumeFlushTimer = null;

  const adapter = {
    name: 'macos-quartz',
    ready: false,
    move(dx, dy) {
      send({ type: 'move', dx: clampNumber(dx, -500, 500), dy: clampNumber(dy, -500, 500) });
    },
    mouseDown(button = 'left') {
      send({ type: 'mousedown', button });
    },
    mouseUp(button = 'left') {
      send({ type: 'mouseup', button });
    },
    click(button = 'left', double = false) {
      send({ type: 'click', button, double: Boolean(double) });
    },
    scroll(dy) {
      send({ type: 'scroll', dy: clampNumber(dy * 4, -4800, 4800) });
    },
    zoom(direction = 'in') {
      const key = direction === 'in' ? '=' : '-';
      send({ type: 'keytap', key, modifiers: ['command'] });
    },
    type(text = '') {
      if (text) send({ type: 'type', text: String(text) });
    },
    keyTap(key, modifiers = []) {
      send({ type: 'keytap', key, modifiers });
    },
    setVolume(value) {
      const number = Number(value);
      if (Number.isFinite(number)) {
        pendingVolumeValue = Math.max(0, Math.min(1, number));
        scheduleVolumeFlush();
      }
    },
    setMute(muted) {
      send({ type: 'mute', muted: Boolean(muted) });
    },
    toggleMute() {
      send({ type: 'togglemute' });
    },
    getVolumeState() {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          responseResolvers.delete('volume_state');
          resolve(null);
        }, 3000);

        responseResolvers.set('volume_state', (response) => {
          clearTimeout(timeout);
          resolve({ volume: response.volume, muted: response.muted });
        });

        send({ type: 'getvolume' });
      });
    },
    close() {
      if (volumeFlushTimer) clearTimeout(volumeFlushTimer);
      if (alive && helper) {
        helper.stdin.end();
        helper.kill();
      }
    },
  };

  function clampNumber(value, min = -2400, max = 2400) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function flushPendingVolume() {
    if (volumeFlushTimer) {
      clearTimeout(volumeFlushTimer);
      volumeFlushTimer = null;
    }

    if (pendingVolumeValue === null) {
      return;
    }

    const value = pendingVolumeValue;
    pendingVolumeValue = null;
    send({ type: 'volume', value });
  }

  function scheduleVolumeFlush() {
    if (volumeFlushTimer) {
      return;
    }

    // Coalesce rapid slider updates on macOS so slow system-volume calls
    // don't build a backlog of stale values behind the user's finger.
    volumeFlushTimer = setTimeout(() => {
      volumeFlushTimer = null;
      flushPendingVolume();
    }, 45);
  }

  function updateStatus(response) {
    permissionGranted = Boolean(response.ready);
    adapter.ready = permissionGranted;
    stateMessage = typeof response.message === 'string' && response.message
      ? response.message
      : permissionGranted
        ? 'macOS native input is ready.'
        : 'Accessibility permission is required.';

    adapter.message = stateMessage;

    if (permissionGranted) {
      adapter.name = 'macos-quartz';
      adapter.permissionMissing = false;
      onStateChange?.({ name: adapter.name, ready: true, recovered: true });
      return;
    }

    adapter.name = 'macos-quartz (permission required)';
    adapter.permissionMissing = response.permission === 'accessibility';
    onStateChange?.({
      name: adapter.name,
      ready: false,
      permissionMissing: adapter.permissionMissing,
      message: adapter.message,
    });
  }

  function spawnHelper() {
    helper = spawn(helperPath, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    alive = true;
    stdoutBuffer = '';

    helper.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const response = JSON.parse(trimmed);
          if (response.type === 'status') {
            updateStatus(response);
          } else if (response.type === 'volume_state') {
            const resolver = responseResolvers.get('volume_state');
            if (resolver) {
              responseResolvers.delete('volume_state');
              resolver(response);
            }
          } else if (response.type === 'error') {
            if (response.code === 'accessibility_permission_missing') {
              console.warn(`[input:macos] ${response.message || stateMessage}`);
            } else if (response.message) {
              console.warn(`[input:macos] ${response.message}`);
            }
          }
        } catch (_error) {
          // ignore non-JSON stdout
        }
      }
    });

    helper.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[input:macos] ${text}`);
    });

    helper.once('exit', (code, signal) => {
      alive = false;
      console.warn(`[input:macos] helper exited code=${code} signal=${signal}`);
      adapter.ready = false;
      adapter.name = 'macos-quartz (unavailable)';
      onStateChange?.({ name: adapter.name, ready: false, exited: true });
    });

    helper.once('error', (error) => {
      alive = false;
      console.warn(`[input:macos] helper failed: ${error.message}`);
      adapter.ready = false;
      adapter.name = 'macos-quartz (unavailable)';
      onStateChange?.({ name: adapter.name, ready: false, error: error.message });
    });
  }

  function send(command) {
    if (!alive || !helper || helper.stdin.destroyed) {
      return;
    }

    const ok = helper.stdin.write(`${JSON.stringify(command)}\n`);
    if (!ok) {
      console.warn('[input:macos] helper stdin is saturated; dropping command.');
    }
  }

  process.once('exit', () => {
    if (volumeFlushTimer) clearTimeout(volumeFlushTimer);
    if (alive && helper) {
      helper.stdin.end();
      helper.kill();
    }
  });

  spawnHelper();
  return adapter;
}
