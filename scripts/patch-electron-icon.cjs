const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const iconPath = path.join(root, 'build', 'linka-icon.ico');
const rceditPath = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const electronPackagePath = require.resolve('electron/package.json', { paths: [root] });
const electronDist = path.join(path.dirname(electronPackagePath), 'dist');
const electronIconPath = path.join(electronDist, 'electron.ico');
const electronExePath = path.join(electronDist, 'electron.exe');

if (!fs.existsSync(iconPath)) {
  throw new Error(`Missing Linka icon: ${iconPath}`);
}

if (!fs.existsSync(rceditPath)) {
  throw new Error(`Missing rcedit executable: ${rceditPath}`);
}

if (!fs.existsSync(electronExePath)) {
  throw new Error(`Missing Electron executable target: ${electronExePath}`);
}

if (fs.existsSync(electronIconPath)) {
  fs.copyFileSync(iconPath, electronIconPath);
  console.log(`[icon] Patched Electron base icon file: ${electronIconPath}`);
}

const result = spawnSync(rceditPath, [electronExePath, '--set-icon', iconPath], {
  cwd: root,
  stdio: 'inherit',
});

if (result.status !== 0) {
  throw new Error(`Failed to apply Linka icon to ${electronExePath}`);
}

console.log(`[icon] Patched Electron executable icon: ${electronExePath}`);
