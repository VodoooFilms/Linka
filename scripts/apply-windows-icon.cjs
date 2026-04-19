const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const iconPath = path.join(root, 'build', 'icon.ico');
const rceditPath = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const targets = [
  path.join(root, 'dist_electron', 'win-unpacked', 'Linka.exe'),
];

if (process.platform !== 'win32') {
  process.exit(0);
}

if (!fs.existsSync(iconPath)) {
  throw new Error(`Missing Windows icon: ${iconPath}`);
}

if (!fs.existsSync(rceditPath)) {
  throw new Error(`Missing rcedit executable: ${rceditPath}`);
}

for (const target of targets) {
  if (!fs.existsSync(target)) {
    continue;
  }

  const result = spawnSync(rceditPath, [target, '--set-icon', iconPath], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to apply icon to ${target}`);
  }
}
