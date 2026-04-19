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

function createWindowsSendInputAdapter() {
  const helperPath = getNativeInputExePath();

  if (process.platform !== 'win32' || !fs.existsSync(helperPath)) {
    return null;
  }

  const helper = spawn(helperPath, {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });

  let alive = true;

  helper.once('exit', (code, signal) => {
    alive = false;
    console.warn(`[input] win-sendinput helper exited code=${code} signal=${signal}`);
  });

  helper.once('error', (error) => {
    alive = false;
    console.warn(`[input] win-sendinput helper failed: ${error.message}`);
  });

  helper.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.warn(`[input:win-sendinput] ${text}`);
  });

  function send(command) {
    if (!alive || helper.stdin.destroyed) {
      return;
    }

    helper.stdin.write(`${JSON.stringify(command)}\n`);
  }

  process.once('exit', () => {
    if (alive) {
      helper.kill();
    }
  });

  return {
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
      send({ type: 'scroll', dy: clampNumber(dy, -1200, 1200) });
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
    close() {
      if (alive) {
        helper.stdin.end();
        helper.kill();
      }
    },
  };
}

async function createRobotAdapter() {
  try {
    const robotModule = await import('robotjs');
    const robot = robotModule.default || robotModule;

    if (robot.setMouseDelay) {
      robot.setMouseDelay(0);
    }

    return {
      name: 'robotjs',
      ready: true,
      move(dx, dy) {
        const mouse = robot.getMousePos();
        robot.moveMouse(Math.round(mouse.x + dx), Math.round(mouse.y + dy));
      },
      mouseDown(button = 'left') {
        robot.mouseToggle('down', button);
      },
      mouseUp(button = 'left') {
        robot.mouseToggle('up', button);
      },
      click(button = 'left', double = false) {
        robot.mouseClick(button, Boolean(double));
      },
      scroll(dy) {
        robot.scrollMouse(0, Math.round(dy));
      },
      zoom(direction = 'in') {
        const amount = direction === 'out' ? -5 : 5;
        robot.keyToggle('control', 'down');
        try {
          robot.scrollMouse(0, amount);
        } finally {
          robot.keyToggle('control', 'up');
        }
      },
      type(text = '') {
        robot.typeString(String(text));
      },
      keyTap(key, modifiers = []) {
        robot.keyTap(key, modifiers);
      },
      setVolume(value) {
        console.warn(`[input] Volume control is not implemented by ${this.name}: ${value}`);
      },
      setMute(muted) {
        console.warn(`[input] Mute control is not implemented by ${this.name}: ${muted}`);
      },
      toggleMute() {
        console.warn(`[input] Mute toggle is not implemented by ${this.name}`);
      },
      close() {},
    };
  } catch (error) {
    console.warn('[input] robotjs is not available.');
    console.warn(`[input] ${error?.message || error}`);
    return null;
  }
}

function createLogOnlyAdapter() {
  return {
    name: 'log-only',
    ready: false,
    move(dx, dy) {
      console.log(`[input:log] move dx=${dx} dy=${dy}`);
    },
    mouseDown(button = 'left') {
      console.log(`[input:log] mouseDown ${button}`);
    },
    mouseUp(button = 'left') {
      console.log(`[input:log] mouseUp ${button}`);
    },
    click(button = 'left', double = false) {
      console.log(`[input:log] click ${button} double=${Boolean(double)}`);
    },
    scroll(dy) {
      console.log(`[input:log] scroll dy=${dy}`);
    },
    zoom(direction = 'in') {
      console.log(`[input:log] zoom ${direction === 'out' ? 'out' : 'in'}`);
    },
    type(text = '') {
      console.log(`[input:log] type ${text}`);
    },
    keyTap(key, modifiers = []) {
      console.log(`[input:log] keyTap ${key} modifiers=${modifiers.join('+')}`);
    },
    setVolume(value) {
      console.log(`[input:log] volume ${value}`);
    },
    setMute(muted) {
      console.log(`[input:log] mute ${muted}`);
    },
    toggleMute() {
      console.log('[input:log] togglemute');
    },
    close() {},
  };
}

export async function createInputAdapter() {
  const winSendInput = createWindowsSendInputAdapter();
  if (winSendInput) {
    return winSendInput;
  }

  const robot = await createRobotAdapter();
  if (robot) {
    return robot;
  }

  console.warn('[input] No native input backend is available. Commands will be logged only.');
  return createLogOnlyAdapter();
}
