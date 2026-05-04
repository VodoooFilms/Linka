#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getExpectedElectronPathFragment(platform) {
  switch (platform) {
    case 'darwin':
      return path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
    case 'win32':
      return 'electron.exe';
    default:
      return path.join('dist', 'electron');
  }
}

function printRepairGuidance(reason) {
  console.error(`[electron] ${reason}`);
  console.error('[electron] This usually means node_modules was copied from another OS.');
  console.error('[electron] Fix it on this machine with:');
  console.error('  rm -rf node_modules');
  console.error('  npm install');
  console.error('[electron] Do not copy node_modules from Windows to macOS or vice versa.');
}

function resolveElectronBinary() {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch (error) {
    printRepairGuidance(`Electron is not installed correctly: ${error.message}`);
    process.exit(1);
  }

  const normalized = path.normalize(String(electronPath || ''));
  const expectedFragment = path.normalize(getExpectedElectronPathFragment(os.platform()));

  if (!normalized.includes(expectedFragment)) {
    printRepairGuidance(
      `Electron resolved to an unexpected executable for ${os.platform()}: ${normalized}`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(normalized)) {
    printRepairGuidance(`Electron executable is missing: ${normalized}`);
    process.exit(1);
  }

  return normalized;
}

const electronBinary = resolveElectronBinary();
const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
});

let childClosed = false;
child.on('close', (code, signal) => {
  childClosed = true;
  if (code === null) {
    console.error(electronBinary, 'exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(signal, () => {
    if (!childClosed) {
      child.kill(signal);
    }
  });
}
