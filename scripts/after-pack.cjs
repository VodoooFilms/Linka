const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const root = context.packager.projectDir;
  const iconPath = path.join(root, 'build', 'linka-icon.ico');
  const rceditPath = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  const executableName = `${context.packager.appInfo.productFilename}.exe`;
  const target = path.join(context.appOutDir, executableName);

  if (!fs.existsSync(iconPath)) {
    throw new Error(`Missing Windows icon: ${iconPath}`);
  }

  if (!fs.existsSync(rceditPath)) {
    throw new Error(`Missing rcedit executable: ${rceditPath}`);
  }

  if (!fs.existsSync(target)) {
    throw new Error(`Missing packaged executable: ${target}`);
  }

  const result = spawnSync(rceditPath, [target, '--set-icon', iconPath], {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to apply icon to ${target}`);
  }

  console.log(`[icon] afterPack applied Linka icon to ${target}`);
};
