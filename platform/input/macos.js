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
  const result = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-framework',
      'ApplicationServices',
      '-framework',
      'AppKit',
      sourcePath,
      '-o',
      helperPath,
    ],
    {
      encoding: 'utf8',
    },
  );

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
  let retryCount = 0;
  let retryTimer = null;
  let draining = false;
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 2000;
  const NON_CRITICAL_COMMANDS = new Set(['move', 'scroll']);

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
      if (retryTimer) clearTimeout(retryTimer);
      if (volumeFlushTimer) clearTimeout(volumeFlushTimer);
      if (alive && helper) {
        helper.stdin.end();
        helper.kill();
      }
    },
    // Hermes Linka: dump captured events buffer
    dumpEvents() {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          responseResolvers.delete('events_dump');
          resolve({ count: 0, events: [], error: 'timeout' });
        }, 5000);

        responseResolvers.set('events_dump', (response) => {
          clearTimeout(timeout);
          resolve(response);
        });

        send({ type: 'dump_events' });
      });
    },
    getCaptureStatus() {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          responseResolvers.delete('capture_status');
          resolve({ active: false, buffer_count: 0 });
        }, 3000);

        responseResolvers.set('capture_status', (response) => {
          clearTimeout(timeout);
          resolve(response);
        });

        send({ type: 'capture_status' });
      });
    },
    // Hermes Linka: Teach mode — start/stop recording with marker
    teachStart() {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          responseResolvers.delete('teach_status');
          resolve({ active: false, buffer_count: 0, error: 'timeout' });
        }, 5000);

        responseResolvers.set('teach_status', (response) => {
          clearTimeout(timeout);
          resolve(response);
        });

        send({ type: 'teach_start' });
      });
    },
    teachStop() {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          responseResolvers.delete('teach_events');
          responseResolvers.delete('_teach_events_meta');
          responseResolvers.delete('_teach_events_resolve');
          resolve({ count: 0, events: [], error: 'timeout' });
        }, 10000);

        responseResolvers.set('teach_events', (response) => {
          clearTimeout(timeout);
          // Events come via EVENTS_JSON, stash resolve+meta
          responseResolvers.set('_teach_events_resolve', resolve);
          responseResolvers.set('_teach_events_meta', () => response);
        });

        send({ type: 'teach_stop' });
      });
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
    volumeFlushTimer.unref?.();
  }

  function updateStatus(response) {
    permissionGranted = Boolean(response.ready);
    adapter.ready = permissionGranted;
    stateMessage =
      typeof response.message === 'string' && response.message
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
    draining = false;
    stdoutBuffer = '';

    helper.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Hermes Linka: capture raw EVENTS_JSON payload
        if (trimmed.startsWith('EVENTS_JSON:')) {
          const jsonPayload = trimmed.slice('EVENTS_JSON:'.length);

          // Handle teach events (check first since both use EVENTS_JSON)
          const teachMetaResolver = responseResolvers.get('_teach_events_meta');
          if (teachMetaResolver) {
            responseResolvers.delete('_teach_events_meta');
            const meta = teachMetaResolver();
            let events = [];
            try {
              events = JSON.parse(jsonPayload);
            } catch (_e) {
              /* ignore */
            }
            const teachResolver = responseResolvers.get('_teach_events_resolve');
            if (teachResolver) {
              responseResolvers.delete('_teach_events_resolve');
              teachResolver({ ...meta, events });
            }
            continue;
          }

          const metaResolver = responseResolvers.get('_events_dump_meta');
          if (metaResolver) {
            responseResolvers.delete('_events_dump_meta');
            const meta = metaResolver();
            let events = [];
            try {
              events = JSON.parse(jsonPayload);
            } catch (_e) {
              // ignore parse errors
            }
            const eventsResolver = responseResolvers.get('_events_dump_resolve');
            if (eventsResolver) {
              responseResolvers.delete('_events_dump_resolve');
              eventsResolver({ ...meta, events });
            }
          }
          continue;
        }

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
          } else if (response.type === 'events_dump') {
            // Hermes Linka: events dump response — also capture EVENTS_JSON line
            const resolver = responseResolvers.get('events_dump');
            if (resolver) {
              responseResolvers.delete('events_dump');
              // The actual event array comes on the next line as EVENTS_JSON:...
              // Stash the resolve callback and the metadata
              responseResolvers.set('_events_dump_resolve', resolver);
              responseResolvers.set('_events_dump_meta', () => response);
            }
          } else if (response.type === 'capture_status') {
            const resolver = responseResolvers.get('capture_status');
            if (resolver) {
              responseResolvers.delete('capture_status');
              resolver(response);
            }
          } else if (response.type === 'teach_status') {
            const resolver = responseResolvers.get('teach_status');
            if (resolver) {
              responseResolvers.delete('teach_status');
              resolver(response);
            }
          } else if (response.type === 'teach_events') {
            const resolver = responseResolvers.get('teach_events');
            if (resolver) {
              responseResolvers.delete('teach_events');
              resolver(response); // sets _teach_events_resolve and _teach_events_meta for EVENTS_JSON
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
      scheduleRetry();
    });

    helper.once('error', (error) => {
      alive = false;
      console.warn(`[input:macos] helper failed: ${error.message}`);
      adapter.ready = false;
      adapter.name = 'macos-quartz (unavailable)';
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryCount++;

    if (retryCount > MAX_RETRIES) {
      console.warn('[input:macos] Max retries reached. Input is unavailable.');
      onStateChange?.({ name: 'macos-quartz', ready: false, retriesExhausted: true });
      return;
    }

    console.warn(`[input:macos] Retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`);
    onStateChange?.({ name: 'macos-quartz', ready: false, retrying: true, retryCount });

    retryTimer = setTimeout(() => {
      retryTimer = null;
      try {
        spawnHelper();
        retryCount = 0;
        console.warn('[input:macos] Helper recovered.');
        onStateChange?.({ name: 'macos-quartz', ready: true, recovered: true });
      } catch (error) {
        console.warn(`[input:macos] Respawn failed: ${error.message}`);
        scheduleRetry();
      }
    }, RETRY_DELAY_MS);
    retryTimer.unref?.();
  }

  function send(command) {
    if (!alive || !helper || helper.stdin.destroyed) {
      return;
    }

    if (draining && NON_CRITICAL_COMMANDS.has(command.type)) {
      return;
    }

    const ok = helper.stdin.write(`${JSON.stringify(command)}\n`);
    if (!ok) {
      draining = true;
      console.warn('[input:macos] helper stdin is saturated; buffering.');
    }
  }

  process.once('exit', () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (volumeFlushTimer) clearTimeout(volumeFlushTimer);
    if (alive && helper) {
      helper.stdin.end();
      helper.kill();
    }
  });

  spawnHelper();
  return adapter;
}
