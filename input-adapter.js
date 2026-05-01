import { createMacOSInputAdapter } from './platform/input/macos.js';
import { createWindowsSendInputAdapter } from './platform/input/windows.js';

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

export async function createInputAdapter(options = {}) {
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;

  if (process.platform === 'win32') {
    const winSendInput = createWindowsSendInputAdapter(onStateChange);
    if (winSendInput) {
      return winSendInput;
    }
  }

  if (process.platform === 'darwin') {
    const macOSAdapter = createMacOSInputAdapter(onStateChange);
    if (macOSAdapter) {
      return macOSAdapter;
    }
  }

  const robot = await createRobotAdapter();
  if (robot) {
    return robot;
  }

  console.warn('[input] No native input backend is available. Commands will be logged only.');
  return createLogOnlyAdapter();
}
