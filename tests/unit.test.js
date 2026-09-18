// Unit tests for core Linka modules.
// Run: node --test tests/unit.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Utils: crypto/auth functions ──
import {
  createSessionId,
  createSecretToken,
  tokenMatches,
  withPairingParams,
  formatBytes,
  getBridgeContentBytes,
} from '../server/utils.js';

// ── Network: IP scoring and discovery ──
import {
  isLikelyVirtualAdapter,
  scoreNetworkCandidate,
  getConnectionInfo,
  resolveDefaultPort,
} from '../server/network.js';

// ── Trackpad acceleration ──
import {
  DEFAULT_TRACKPAD_ACCELERATION_PROFILE,
  computeTrackpadAcceleration,
  resolveTrackpadAccelerationProfile,
} from '../shared/trackpad-acceleration.js';

// ═══════════════════════════════════════════════
// AUTH & CRYPTO
// ═══════════════════════════════════════════════

describe('Auth & Crypto', () => {
  it('createSessionId generates valid UUIDs', () => {
    const id1 = createSessionId();
    const id2 = createSessionId();
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notStrictEqual(id1, id2);
  });

  it('createSecretToken generates 43-char base64url strings', () => {
    const t1 = createSecretToken();
    const t2 = createSecretToken();
    assert.strictEqual(t1.length, 43);
    assert.notStrictEqual(t1, t2);
    assert.match(t1, /^[A-Za-z0-9_-]+$/);
  });

  it('tokenMatches uses timing-safe comparison', () => {
    assert.strictEqual(tokenMatches('abc', 'abc'), true);
    assert.strictEqual(tokenMatches('abc', 'abd'), false);
    assert.strictEqual(tokenMatches('abc', 'ab'), false);
    assert.strictEqual(tokenMatches('abc', 'abcd'), false);
    assert.strictEqual(tokenMatches(null, 'abc'), false);
    assert.strictEqual(tokenMatches('abc', 123), false);
  });

  it('withPairingParams appends query params correctly', () => {
    const url = withPairingParams('http://192.168.1.5:3067', 'sess-123', 'tok-abc');
    assert.ok(url.includes('sessionId=sess-123'));
    assert.ok(url.includes('pairingToken=tok-abc'));
    assert.ok(url.includes('192.168.1.5:3067'));
  });

  it('formatBytes formats bytes to MB', () => {
    assert.strictEqual(formatBytes(1048576), '1.0MB');
    assert.strictEqual(formatBytes(5242880), '5.0MB');
    assert.strictEqual(formatBytes(0), '0.0MB');
  });

  it('getBridgeContentBytes calculates decoded size from base64 data URI', () => {
    // "hello" in base64 = "aGVsbG8=" (5 bytes)
    const dataUri = 'data:text/plain;base64,aGVsbG8=';
    assert.strictEqual(getBridgeContentBytes(dataUri), 5);
    // Non-data-URI passes through as-is, base64 decoded
    const plain = 'aGVsbG8=';
    assert.strictEqual(getBridgeContentBytes(plain), 5);
    assert.strictEqual(getBridgeContentBytes(123), 0);
  });
});

// ═══════════════════════════════════════════════
// NETWORK SCORING
// ═══════════════════════════════════════════════

describe('Network Scoring', () => {
  it('scores private LAN addresses high', () => {
    assert.strictEqual(scoreNetworkCandidate('Wi-Fi', '192.168.1.100'), 90); // 50 + 40
    assert.strictEqual(scoreNetworkCandidate('Ethernet', '10.0.0.5'), 75); // 50 + 25
  });

  it('penalizes virtual adapters', () => {
    const vbox = scoreNetworkCandidate('VirtualBox Host-Only', '192.168.56.1');
    assert.ok(vbox < 0, `VirtualBox score ${vbox} should be negative`);
  });

  it('penalizes .1 addresses', () => {
    const gw = scoreNetworkCandidate('Wi-Fi', '192.168.1.1');
    const normal = scoreNetworkCandidate('Wi-Fi', '192.168.1.100');
    assert.ok(gw < normal, `Gateway ${gw} should score lower than ${normal}`);
  });

  it('detects virtual adapters', () => {
    assert.strictEqual(isLikelyVirtualAdapter('DockerNAT', '10.0.0.1'), true);
    assert.strictEqual(isLikelyVirtualAdapter('Tailscale', '100.64.0.1'), true);
    assert.strictEqual(isLikelyVirtualAdapter('Wi-Fi', '192.168.1.100'), false);
    assert.strictEqual(isLikelyVirtualAdapter('Loopback', '127.0.0.1'), true);
  });

  it('getConnectionInfo returns valid structure', () => {
    const info = getConnectionInfo(3067);
    assert.strictEqual(info.port, 3067);
    assert.ok(info.localhostUrl.includes('localhost'));
    assert.ok(Array.isArray(info.urls));
    assert.ok(Array.isArray(info.candidates));
  });

  it('resolveDefaultPort respects env', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    assert.strictEqual(resolveDefaultPort(), 3067);
    process.env.NODE_ENV = 'development';
    assert.strictEqual(resolveDefaultPort(), 3000);
    process.env.NODE_ENV = saved;
  });
});

describe('Trackpad Acceleration', () => {
  it('keeps very slow movement close to 1x', () => {
    const result = computeTrackpadAcceleration(1, 0, 16, {
      sensitivity: 1.45,
      currentMultiplier: 1,
      profileId: DEFAULT_TRACKPAD_ACCELERATION_PROFILE,
      isPortrait: false,
    });
    assert.ok(result.multiplier < 1.08, `expected near-1x multiplier, got ${result.multiplier}`);
    assert.ok(result.dx < 1.6, `expected low acceleration, got dx ${result.dx}`);
  });

  it('boosts fast movement more strongly in higher reach profiles', () => {
    const balanced = computeTrackpadAcceleration(18, 0, 12, {
      sensitivity: 1.45,
      currentMultiplier: 1,
      profileId: 'balanced',
      isPortrait: false,
    });
    const infinite = computeTrackpadAcceleration(18, 0, 12, {
      sensitivity: 1.45,
      currentMultiplier: 1,
      profileId: 'infinite',
      isPortrait: false,
    });
    assert.ok(balanced.multiplier > 1.3, `balanced multiplier too small: ${balanced.multiplier}`);
    assert.ok(infinite.multiplier > balanced.multiplier, 'infinite should accelerate more');
  });

  it('adds portrait-only horizontal reach for non-precision profiles', () => {
    const landscape = computeTrackpadAcceleration(10, 0, 16, {
      sensitivity: 1.45,
      currentMultiplier: 1.4,
      profileId: 'balanced',
      isPortrait: false,
    });
    const portrait = computeTrackpadAcceleration(10, 0, 16, {
      sensitivity: 1.45,
      currentMultiplier: 1.4,
      profileId: 'balanced',
      isPortrait: true,
    });
    assert.ok(portrait.dx > landscape.dx, 'portrait horizontal boost should increase dx');
  });

  it('falls back to the default profile for unknown ids', () => {
    const resolved = resolveTrackpadAccelerationProfile('unknown-profile');
    assert.strictEqual(resolved.id, DEFAULT_TRACKPAD_ACCELERATION_PROFILE);
  });
});
