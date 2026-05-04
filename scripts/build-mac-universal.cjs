// Builds the macOS native input helper as a universal binary (arm64 + x86_64).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SWIFT_SOURCE = path.join(ROOT, 'native', 'mac-input', 'main.swift');
const BIN_DIR = path.join(ROOT, 'native', 'mac-input', 'bin');
const ARM64_OUT = path.join(BIN_DIR, 'Linka.NativeInput-arm64');
const X64_OUT = path.join(BIN_DIR, 'Linka.NativeInput-x86_64');
const UNIVERSAL_OUT = path.join(BIN_DIR, 'Linka.NativeInput');

const SWIFT_FRAMEWORKS = ['-framework', 'ApplicationServices', '-framework', 'AppKit'];

function run(cmd, description) {
  console.log(`[build-universal] ${description}...`);
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`[build-universal] FAILED: ${description}`);
    if (err.stderr) console.error(err.stderr.trim());
    process.exit(1);
  }
}

if (!fs.existsSync(SWIFT_SOURCE)) {
  console.error(`[build-universal] Missing Swift source: ${SWIFT_SOURCE}`);
  process.exit(1);
}

fs.mkdirSync(BIN_DIR, { recursive: true });

const arch = process.arch; // 'arm64' or 'x64'

// Build for arm64
run(
  `xcrun swiftc -O -target arm64-apple-macos11 ${SWIFT_FRAMEWORKS.join(' ')} "${SWIFT_SOURCE}" -o "${ARM64_OUT}"`,
  'Building arm64 binary',
);

// Build for x86_64
run(
  `xcrun swiftc -O -target x86_64-apple-macos11 ${SWIFT_FRAMEWORKS.join(' ')} "${SWIFT_SOURCE}" -o "${X64_OUT}"`,
  'Building x86_64 binary',
);

// Create universal binary with lipo
run(
  `lipo -create "${ARM64_OUT}" "${X64_OUT}" -output "${UNIVERSAL_OUT}"`,
  'Creating universal binary',
);

// Verify
const fileType = execSync(`file "${UNIVERSAL_OUT}"`, { encoding: 'utf8' }).trim();
console.log(`[build-universal] Output: ${fileType}`);

// Make executable
fs.chmodSync(UNIVERSAL_OUT, 0o755);

// Clean up single-arch intermediates
if (arch !== 'arm64') fs.unlinkSync(ARM64_OUT);
if (arch !== 'x64') fs.unlinkSync(X64_OUT);

console.log('[build-universal] Universal binary ready.');
