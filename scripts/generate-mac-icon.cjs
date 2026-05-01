const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourcePng = path.join(root, 'build', 'linka-logo.png');
const outputIcns = path.join(root, 'build', 'linka.icns');

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (!fs.existsSync(sourcePng)) {
  throw new Error(`Missing source PNG for mac icon: ${sourcePng}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linka-iconset-'));
const iconsetDir = path.join(tempDir, 'linka.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

try {
  const sizes = [16, 32, 64, 128, 256, 512];

  for (const size of sizes) {
    const oneX = path.join(iconsetDir, `icon_${size}x${size}.png`);
    const twoX = path.join(iconsetDir, `icon_${size}x${size}@2x.png`);

    run('sips', ['-z', String(size), String(size), sourcePng, '--out', oneX]);
    run('sips', ['-z', String(size * 2), String(size * 2), sourcePng, '--out', twoX]);
  }

  run('iconutil', ['-c', 'icns', iconsetDir, '-o', outputIcns]);
  console.log(`[icon] Generated macOS icon: ${outputIcns}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
