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
  getNetworkCandidates,
  getConnectionInfo,
  resolveDefaultPort,
} from '../server/network.js';

// ── Skill generator ──
import { generateTeachSkill } from '../server/skill-generator.js';
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

// ═══════════════════════════════════════════════
// SKILL GENERATOR
// ═══════════════════════════════════════════════

describe('Skill Generator', () => {
  it('generates skill with keystrokes only', () => {
    const events = [
      { ts: 1000, type: 'key_combo', key: 'h', modifiers: null },
      { ts: 1100, type: 'key_combo', key: 'e', modifiers: null },
      { ts: 1200, type: 'key_combo', key: 'l', modifiers: null },
      { ts: 1300, type: 'key_combo', key: 'l', modifiers: null },
      { ts: 1400, type: 'key_combo', key: 'o', modifiers: null },
    ];
    const skill = generateTeachSkill('Test Type', events, { name: 'TextEdit' });
    assert.ok(skill.includes('name: test-type'));
    assert.ok(skill.includes('app: TextEdit'));
    assert.ok(skill.includes('has_keyboard: true'));
    assert.ok(skill.includes('has_clicks: false'));
    // Consecutive same keys are grouped: h, e, ll, o
    assert.ok(skill.includes('Press h'));
    assert.ok(skill.includes('Press e'));
    assert.ok(skill.includes('Type "ll"'));
    assert.ok(skill.includes('Press o'));
  });

  it('generates skill with clicks', () => {
    const events = [
      { ts: 1000, type: 'mouse_moved', x: 100, y: 200 },
      { ts: 1100, type: 'left_down', x: 100, y: 200 },
      { ts: 1150, type: 'left_up', x: 100, y: 200 },
    ];
    const skill = generateTeachSkill('Test Click', events, { name: 'Safari' });
    assert.ok(skill.includes('has_clicks: true'));
    assert.ok(skill.includes('Click at (100, 200)'));
    assert.ok(skill.includes('app: Safari'));
  });

  it('detects dock switch from app history', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'a', modifiers: null }];
    const appHistory = [
      { app: 'Linka', ts: 1000 },
      { app: 'TextEdit', ts: 2000 },
    ];
    const skill = generateTeachSkill('Dock Test', events, {}, false, null, appHistory);
    assert.ok(skill.includes('dock_switch: Linka → TextEdit'));
    assert.ok(skill.includes('app: TextEdit'));
  });

  it('handles user prompt as authoritative intent', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'x', modifiers: null }];
    const skill = generateTeachSkill(
      'Prompt Test',
      events,
      { name: 'Notes' },
      false,
      null,
      null,
      'Write meeting notes',
    );
    assert.ok(skill.includes('**User said:** "Write meeting notes"'));
    assert.ok(skill.includes('**Intent:** Write meeting notes'));
  });

  it('handles empty events gracefully', () => {
    const skill = generateTeachSkill('Empty', [], { name: 'Finder' });
    assert.ok(skill.includes('name: empty'));
    assert.ok(skill.includes('_No actions extracted_'));
    assert.ok(skill.includes('has_clicks: false'));
    assert.ok(skill.includes('has_keyboard: false'));
  });

  it('generates screenshot section when hasScreenshot is true', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'a', modifiers: null }];
    const skill = generateTeachSkill('Screenshot', events, { name: 'Safari' }, true);
    assert.ok(skill.includes('📸 Reference Screenshot'));
    assert.ok(skill.includes('vision_analyze'));
  });

  it('generates right-click actions', () => {
    const events = [
      { ts: 1000, type: 'right_down', x: 50, y: 60 },
      { ts: 1050, type: 'right_up', x: 50, y: 60 },
    ];
    const skill = generateTeachSkill('RightClick', events, { name: 'Finder' });
    assert.ok(skill.includes('Right-click at (50, 60)'));
    assert.ok(skill.includes('right-click 1 time'));
  });

  it('handles key combos with modifiers', () => {
    const events = [
      { ts: 1000, type: 'key_combo', key: 'n', modifiers: ['cmd'] },
      { ts: 1100, type: 'key_combo', key: 'v', modifiers: ['cmd'] },
    ];
    const skill = generateTeachSkill('Combos', events, { name: 'TextEdit' });
    assert.ok(skill.includes('Press cmd+n'));
    assert.ok(skill.includes('Press cmd+v'));
  });

  it('handles scroll events', () => {
    const events = [{ ts: 1000, type: 'scroll', x: 100, y: 200, dy: -120 }];
    const skill = generateTeachSkill('Scroll', events, { name: 'Safari' });
    assert.ok(skill.includes('Scroll up 120px'));
    assert.ok(skill.includes('scroll'));
  });

  it('unknown app generates cautious replay instructions', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'a', modifiers: null }];
    const skill = generateTeachSkill('Unknown', events, {});
    assert.ok(skill.includes('App unknown'));
    assert.ok(skill.includes('qué app estabas usando'));
  });

  it('includes app hints for known apps', () => {
    const events = [
      { ts: 1000, type: 'left_down', x: 10, y: 10 },
      { ts: 1100, type: 'left_up', x: 10, y: 10 },
    ];
    const skill = generateTeachSkill('Hint', events, { name: 'TextEdit' });
    assert.ok(skill.includes('TextEdit opens a new document'));
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
