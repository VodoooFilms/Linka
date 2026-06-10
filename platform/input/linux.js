import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const VENDORED_XDOTOOL_PATH = path.join(PROJECT_ROOT, 'vendor', 'linux-runtime', 'usr', 'bin', 'xdotool');
const VENDORED_LIB_DIR = path.join(
  PROJECT_ROOT,
  'vendor',
  'linux-runtime',
  'usr',
  'lib',
  'x86_64-linux-gnu',
);

function clampNumber(value, min = -2400, max = 2400) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function hasCommand(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

function hasExecutable(filePath) {
  return spawnSync('test', ['-x', filePath], { stdio: 'ignore' }).status === 0;
}

function buildLinuxEnv(extra = {}) {
  const nextEnv = { ...process.env, ...extra };
  nextEnv.DISPLAY ||= ':0.0';
  nextEnv.XAUTHORITY ||= path.join(process.env.HOME || '/home/toin', '.Xauthority');
  if (hasExecutable(VENDORED_XDOTOOL_PATH)) {
    nextEnv.LD_LIBRARY_PATH = nextEnv.LD_LIBRARY_PATH
      ? `${VENDORED_LIB_DIR}:${nextEnv.LD_LIBRARY_PATH}`
      : VENDORED_LIB_DIR;
  }
  return nextEnv;
}

function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    env: options.env || process.env,
  });

  if (!options.capture) {
    child.unref();
    return child;
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function createWarningLogger(prefix) {
  const shown = new Set();

  return function warn(message) {
    if (shown.has(message)) return;
    shown.add(message);
    console.warn(`${prefix} ${message}`);
  };
}

function mapButton(button = 'left') {
  switch (button) {
    case 'middle':
      return '2';
    case 'right':
      return '3';
    default:
      return '1';
  }
}

function mapModifier(modifier = '') {
  switch (String(modifier).toLowerCase()) {
    case 'cmd':
    case 'command':
    case 'meta':
    case 'super':
      return 'Super_L';
    case 'ctrl':
    case 'control':
      return 'ctrl';
    case 'alt':
    case 'option':
      return 'alt';
    case 'shift':
      return 'shift';
    default:
      return String(modifier);
  }
}

function mapKey(key = '') {
  const value = String(key);
  const lower = value.toLowerCase();
  const aliases = {
    enter: 'Return',
    return: 'Return',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    del: 'Delete',
    space: 'space',
    tab: 'Tab',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'Page_Up',
    pagedown: 'Page_Down',
  };

  if (aliases[lower]) {
    return aliases[lower];
  }

  if (/^f\d{1,2}$/i.test(value)) {
    return value.toUpperCase();
  }

  return value;
}

function createVolumeController() {
  const hasPactl = hasCommand('pactl');
  const hasWpctl = hasCommand('wpctl');

  if (!hasPactl && !hasWpctl) {
    return {
      available: false,
      async getState() {
        return null;
      },
      setVolume() {},
      setMute() {},
      toggleMute() {},
    };
  }

  if (hasPactl) {
    return {
      available: true,
      async getState() {
        try {
          const [volumeOutput, muteOutput] = await Promise.all([
            runCommand('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { capture: true }),
            runCommand('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { capture: true }),
          ]);
          const percentMatch = volumeOutput.match(/(\d+)%/);
          return {
            volume: percentMatch ? Math.max(0, Math.min(1, Number(percentMatch[1]) / 100)) : null,
            muted: /yes/i.test(muteOutput),
          };
        } catch (_error) {
          return null;
        }
      },
      setVolume(value) {
        runCommand('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Math.round(value * 100)}%`]);
      },
      setMute(muted) {
        runCommand('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']);
      },
      toggleMute() {
        runCommand('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
      },
    };
  }

  return {
    available: true,
    async getState() {
      try {
        const output = await runCommand('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], {
          capture: true,
        });
        const volumeMatch = output.match(/Volume:\s+([0-9.]+)/i);
        return {
          volume: volumeMatch ? Math.max(0, Math.min(1, Number(volumeMatch[1]))) : null,
          muted: /\[MUTED\]/i.test(output),
        };
      } catch (_error) {
        return null;
      }
    },
    setVolume(value) {
      runCommand('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', String(value)]);
    },
    setMute(muted) {
      runCommand('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0']);
    },
    toggleMute() {
      runCommand('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);
    },
  };
}

function createX11Backend() {
  const xdotoolPath = hasExecutable(VENDORED_XDOTOOL_PATH)
    ? VENDORED_XDOTOOL_PATH
    : hasCommand('xdotool')
      ? 'xdotool'
      : null;

  if (!xdotoolPath) {
    return null;
  }

  const commandEnv = buildLinuxEnv();
  let pendingMoveDx = 0;
  let pendingMoveDy = 0;
  let moveInFlight = false;

  function flushMove() {
    if (moveInFlight) {
      return;
    }

    const dx = clampNumber(pendingMoveDx, -500, 500);
    const dy = clampNumber(pendingMoveDy, -500, 500);
    pendingMoveDx = 0;
    pendingMoveDy = 0;

    if (dx === 0 && dy === 0) {
      return;
    }

    moveInFlight = true;
    const child = runCommand(
      xdotoolPath,
      ['mousemove_relative', '--', String(dx), String(dy)],
      { env: commandEnv },
    );

    child.once('exit', () => {
      moveInFlight = false;
      if (pendingMoveDx !== 0 || pendingMoveDy !== 0) {
        flushMove();
      }
    });

    child.once('error', () => {
      moveInFlight = false;
      if (pendingMoveDx !== 0 || pendingMoveDy !== 0) {
        flushMove();
      }
    });
  }

  return {
    name: hasExecutable(VENDORED_XDOTOOL_PATH) ? 'linux-xdotool-bundled' : 'linux-xdotool',
    ready: true,
    move(dx, dy) {
      pendingMoveDx += dx;
      pendingMoveDy += dy;
      flushMove();
    },
    mouseDown(button = 'left') {
      runCommand(xdotoolPath, ['mousedown', mapButton(button)], { env: commandEnv });
    },
    mouseUp(button = 'left') {
      runCommand(xdotoolPath, ['mouseup', mapButton(button)], { env: commandEnv });
    },
    click(button = 'left', double = false) {
      const args = ['click'];
      if (double) {
        args.push('--repeat', '2', '--delay', '80');
      }
      args.push(mapButton(button));
      runCommand(xdotoolPath, args, { env: commandEnv });
    },
    scroll(dy) {
      const button = dy < 0 ? '5' : '4';
      const steps = Math.max(1, Math.min(20, Math.round(Math.abs(dy) / 60) || 1));
      runCommand(xdotoolPath, ['click', '--repeat', String(steps), button], { env: commandEnv });
    },
    zoom(direction = 'in') {
      runCommand(xdotoolPath, [
        'keydown',
        'ctrl',
        'click',
        direction === 'out' ? '5' : '4',
        'keyup',
        'ctrl',
      ], { env: commandEnv });
    },
    type(text = '') {
      if (!text) return;
      runCommand(xdotoolPath, ['type', '--delay', '0', '--', String(text)], { env: commandEnv });
    },
    keyTap(key, modifiers = []) {
      const combo = [...modifiers.map(mapModifier), mapKey(key)].join('+');
      runCommand(xdotoolPath, ['key', '--clearmodifiers', combo], { env: commandEnv });
    },
  };
}

export function createLinuxInputAdapter(onStateChange) {
  if (process.platform !== 'linux') {
    return null;
  }

  const warn = createWarningLogger('[input:linux]');
  const backend = createX11Backend();
  const volume = createVolumeController();

  if (!backend && !volume.available) {
    return null;
  }

  const adapter = {
    name: backend?.name || 'linux-volume-only',
    ready: Boolean(backend?.ready),
    move(dx, dy) {
      if (!backend) return warn('Move is unavailable. Install xdotool on X11.');
      backend.move(dx, dy);
    },
    mouseDown(button = 'left') {
      if (!backend) return warn('Mouse down is unavailable. Install xdotool on X11.');
      backend.mouseDown(button);
    },
    mouseUp(button = 'left') {
      if (!backend) return warn('Mouse up is unavailable. Install xdotool on X11.');
      backend.mouseUp(button);
    },
    click(button = 'left', double = false) {
      if (!backend) return warn('Click is unavailable. Install xdotool on X11.');
      backend.click(button, double);
    },
    scroll(dy) {
      if (!backend) return warn('Scroll is unavailable. Install xdotool on X11.');
      backend.scroll(dy);
    },
    zoom(direction = 'in') {
      if (!backend) return warn('Zoom is unavailable. Install xdotool on X11.');
      backend.zoom(direction);
    },
    type(text = '') {
      if (!backend) return warn('Typing is unavailable. Install xdotool on X11.');
      backend.type(text);
    },
    keyTap(key, modifiers = []) {
      if (!backend) return warn('Key tap is unavailable. Install xdotool on X11.');
      backend.keyTap(key, modifiers);
    },
    setVolume(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      volume.setVolume(Math.max(0, Math.min(1, number)));
    },
    setMute(muted) {
      volume.setMute(Boolean(muted));
    },
    toggleMute() {
      volume.toggleMute();
    },
    async getVolumeState() {
      return volume.getState();
    },
    close() {},
  };

  onStateChange?.({
    name: adapter.name,
    ready: adapter.ready,
    permissionMissing: false,
    message: backend
      ? 'Linux input ready through xdotool.'
      : 'Linux audio ready. Install xdotool on X11 for mouse and keyboard control.',
  });

  return adapter;
}
