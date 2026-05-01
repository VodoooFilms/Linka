import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function clampNumber(value, min = -2400, max = 2400) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function getNativeInputExePath() {
  return path.join(
    __dirname,
    '..',
    '..',
    'native',
    'win-input',
    'bin',
    'Release',
    'net8.0',
    'win-x64',
    'publish',
    'Linka.NativeInput.exe',
  );
}

export function createWindowsSendInputAdapter(onStateChange) {
  const helperPath = getNativeInputExePath();

  if (process.platform !== 'win32' || !fs.existsSync(helperPath)) {
    return null;
  }

  let alive = false;
  let helper = null;
  let retryCount = 0;
  let retryTimer = null;
  let draining = false;
  let stdoutBuffer = '';
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 2000;
  const NON_CRITICAL_COMMANDS = new Set(['move', 'scroll']);
  const responseResolvers = new Map();

  const adapter = {
    name: 'win-sendinput',
    ready: true,
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
      send({ type: 'scroll', dy: clampNumber(dy * 40, -2400, 2400) });
    },
    zoom(direction = 'in') {
      send({ type: 'zoom', direction: direction === 'out' ? 'out' : 'in' });
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
        send({ type: 'volume', value: Math.max(0, Math.min(1, number)) });
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
      if (alive && helper) {
        helper.stdin.end();
        helper.kill();
      }
    },
  };

  function stateChangeHandler(state) {
    adapter.ready = state.ready;
    if (state.recovered) {
      adapter.name = 'win-sendinput';
    }
    if (state.retriesExhausted) {
      adapter.name = 'win-sendinput (unavailable)';
    }
    onStateChange?.(state);
  }

  function spawnHelper() {
    helper = spawn(helperPath, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
        try {
          const response = JSON.parse(trimmed);
          const resolver = responseResolvers.get(response.type);
          if (resolver) {
            responseResolvers.delete(response.type);
            resolver(response);
          }
        } catch (_error) {
          // ignore non-JSON stdout
        }
      }
    });

    helper.stdin.on('drain', () => {
      draining = false;
    });

    helper.once('exit', (code, signal) => {
      alive = false;
      console.warn(`[input] win-sendinput helper exited code=${code} signal=${signal}`);
      scheduleRetry();
    });

    helper.once('error', (error) => {
      alive = false;
      console.warn(`[input] win-sendinput helper failed: ${error.message}`);
      scheduleRetry();
    });

    helper.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[input:win-sendinput] ${text}`);
    });
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryCount++;

    if (retryCount > MAX_RETRIES) {
      console.warn('[input] win-sendinput max retries reached. Input is unavailable.');
      stateChangeHandler({ name: 'win-sendinput', ready: false, retriesExhausted: true });
      return;
    }

    console.warn(`[input] win-sendinput retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`);
    stateChangeHandler({ name: 'win-sendinput', ready: false, retrying: true, retryCount });

    retryTimer = setTimeout(() => {
      retryTimer = null;
      try {
        spawnHelper();
        retryCount = 0;
        console.warn('[input] win-sendinput helper recovered.');
        stateChangeHandler({ name: 'win-sendinput', ready: true, recovered: true });
      } catch (error) {
        console.warn(`[input] win-sendinput respawn failed: ${error.message}`);
        scheduleRetry();
      }
    }, RETRY_DELAY_MS);
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
    }
  }

  process.once('exit', () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (alive && helper) {
      helper.stdin.end();
      helper.kill();
    }
  });

  spawnHelper();

  return adapter;
}
