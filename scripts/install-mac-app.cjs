#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const distRoot = path.join(root, 'dist_electron');
const targetApp = '/Applications/Linka.app';

function fail(message) {
  console.error(`[mac-install] ${message}`);
  process.exit(1);
}

function findBuiltApp() {
  if (!fs.existsSync(distRoot)) {
    return null;
  }

  const candidates = [];
  for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue;
    const appPath = path.join(distRoot, entry.name, 'Linka.app');
    if (!fs.existsSync(appPath)) continue;
    const stat = fs.statSync(appPath);
    candidates.push({ appPath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.appPath || null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });

  if (result.status !== 0 && !options.allowFailure) {
    fail(`${command} ${args.join(' ')} failed`);
  }
}

const sourceApp = findBuiltApp();
if (!sourceApp) {
  fail('No packaged macOS app was found in dist_electron/. Run the mac build first.');
}

run('osascript', ['-e', 'tell application "Linka" to quit'], { allowFailure: true });
run('pkill', ['-f', '/Applications/Linka.app/Contents/MacOS/Linka'], { allowFailure: true });

if (fs.existsSync(targetApp)) {
  fs.rmSync(targetApp, { recursive: true, force: true });
}

run('ditto', [sourceApp, targetApp]);

console.log(`[mac-install] Installed ${sourceApp} -> ${targetApp}`);
