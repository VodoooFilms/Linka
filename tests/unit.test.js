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

// ── Teach recording ──
import { buildTeachRecording, renderTeachSkillMarkdown } from '../server/teach/recording.js';
import { createTeachMessageHandler } from '../server/hermes/teach-handler.js';
import { mergeTeachEventStreams, normalizeTeachCommandToEvents } from '../platform/input/macos.js';
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
// TEACH RECORDING
// ═══════════════════════════════════════════════

describe('Teach Recording', () => {
  it('builds a local skill with keystrokes only', () => {
    const events = [
      { ts: 1000, type: 'key_combo', key: 'h', modifiers: null },
      { ts: 1100, type: 'key_combo', key: 'e', modifiers: null },
      { ts: 1200, type: 'key_combo', key: 'l', modifiers: null },
      { ts: 1300, type: 'key_combo', key: 'l', modifiers: null },
      { ts: 1400, type: 'key_combo', key: 'o', modifiers: null },
    ];
    const recording = buildTeachRecording('Test Type', events, { app: { name: 'TextEdit' } });
    assert.equal(recording.id, 'test-type');
    assert.equal(recording.target.app_name, 'TextEdit');
    assert.equal(recording.summary.has_keyboard, true);
    assert.equal(recording.summary.has_pointer, false);
    assert.deepEqual(recording.summary.action_labels, [
      'Press h',
      'Press e',
      'Type "ll" (2 keystrokes)',
      'Press o',
    ]);
  });

  it('removes coordinates from persisted click recordings', () => {
    const events = [
      { ts: 1000, type: 'mouse_moved', x: 100, y: 200 },
      { ts: 1100, type: 'left_down', x: 100, y: 200 },
      { ts: 1150, type: 'left_up', x: 100, y: 200 },
    ];
    const recording = buildTeachRecording('Test Click', events, { app: { name: 'Safari' } });
    assert.equal(recording.summary.has_pointer, true);
    assert.deepEqual(recording.summary.action_labels, ['Click']);
    assert.ok(recording.events.every((event) => !Object.hasOwn(event, 'x')));
    assert.ok(recording.events.every((event) => !Object.hasOwn(event, 'y')));
  });

  it('detects dock switch from app history', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'a', modifiers: null }];
    const appHistory = [
      { app: 'Linka', ts: 1000 },
      { app: 'TextEdit', ts: 2000 },
    ];
    const recording = buildTeachRecording('Dock Test', events, { appHistory });
    assert.deepEqual(recording.target.dock_switch, { from: 'Linka', to: 'TextEdit' });
    assert.equal(recording.target.app_name, 'TextEdit');
  });

  it('uses user prompt as authoritative intent', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'x', modifiers: null }];
    const recording = buildTeachRecording('Prompt Test', events, {
      app: { name: 'Notes' },
      userPrompt: 'Write meeting notes',
    });
    assert.equal(recording.guidance.user_intent, 'Write meeting notes');
    assert.equal(recording.guidance.summary, 'Write meeting notes');
  });

  it('handles empty events gracefully', () => {
    const recording = buildTeachRecording('Empty', [], { app: { name: 'Finder' } });
    assert.equal(recording.id, 'empty');
    assert.deepEqual(recording.summary.action_labels, []);
    assert.equal(recording.summary.has_pointer, false);
    assert.equal(recording.summary.has_keyboard, false);
  });

  it('stores screenshot path when available', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'a', modifiers: null }];
    const recording = buildTeachRecording('Screenshot', events, {
      app: { name: 'Safari' },
      screenshotPath: '/tmp/screenshot.png',
    });
    assert.equal(recording.assets.has_screenshot, true);
    assert.equal(recording.assets.screenshot_path, '/tmp/screenshot.png');
    assert.equal(recording.assets.screenshot_stage, 'after_recording_before_review');
  });

  it('preserves event source metadata for teach recordings', () => {
    const recording = buildTeachRecording('Source Test', [
      { ts: 1000, type: 'left_down', source: 'desktop_input' },
      { ts: 1001, type: 'left_up', source: 'remote_command' },
    ]);
    assert.deepEqual(recording.summary.event_sources.sort(), ['desktop_input', 'remote_command']);
    assert.equal(recording.events[0].source, 'desktop_input');
  });

  it('adds codex-friendly reading instructions for future skills', () => {
    const events = [
      { ts: 1000, type: 'left_down', x: 50, y: 60 },
      { ts: 1050, type: 'left_up', x: 50, y: 60 },
    ];
    const recording = buildTeachRecording('Codex Guide', events, {
      app: { name: 'Linka' },
      userPrompt: 'Minimize the Linka window',
      screenshotPath: '/tmp/linka-shot.png',
    });
    assert.equal(recording.codex.purpose, 'codex_local_desktop_skill');
    assert.equal(recording.codex.read_this_first, 'Minimize the Linka window');
    assert.equal(recording.codex.targeting_strategy.primary_signal, 'guidance.user_intent');
    assert.equal(recording.codex.execution_contract.required_approval, true);
    assert.ok(recording.codex.review_order.includes('Open assets.screenshot_path and inspect the UI state.'));
    assert.equal(recording.codex.semantic_target.status, 'partially_resolved');
    assert.equal(recording.codex.semantic_target.candidate_actions[0].action, 'minimize_linka_window');
    assert.deepEqual(recording.presentation.codex_should_read, [
      'guidance.user_intent',
      'target.app_name',
      'assets.screenshot_path',
      'codex.semantic_target',
    ]);
  });

  it('presents calculator multiplication as a semantic workflow, not just clicks', () => {
    const events = [
      { ts: 1000, type: 'left_down', x: 10, y: 10 },
      { ts: 1020, type: 'left_up', x: 10, y: 10 },
    ];
    const recording = buildTeachRecording('Multiplicacion', events, {
      appHistory: [
        { app: 'Linka', ts: 1000 },
        { app: 'Calculator', ts: 2000 },
      ],
      userPrompt: 'Uso de calculadora y multiplicación',
      screenshotPath: '/tmp/calc-shot.png',
    });
    assert.equal(recording.presentation.semantic_readiness, 'partially_resolved');
    assert.equal(recording.target.app_name, 'Calculator');
    assert.ok(
      recording.codex.semantic_target.candidate_actions.some(
        (candidate) => candidate.action === 'calculator_multiply',
      ),
    );
  });

  it('extracts calculator operands when the intent includes the full expression', () => {
    const recording = buildTeachRecording('Multiplicacion Exacta', [], {
      appHistory: [
        { app: 'Linka', ts: 1000 },
        { app: 'Calculator', ts: 2000 },
      ],
      userPrompt: 'Usa calculadora abrela y haz 47 x 98',
      screenshotPath: '/tmp/calc-shot.png',
    });
    const multiply = recording.codex.semantic_target.candidate_actions.find(
      (candidate) => candidate.action === 'calculator_multiply',
    );
    assert.deepEqual(multiply.params, { operands: ['47', '98'] });
    assert.equal(recording.codex.semantic_target.primary_action, 'calculator_multiply');
  });

  it('extracts text parameters for text entry workflows', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'h', modifiers: null }];
    const recording = buildTeachRecording('Text Entry', events, {
      app: { name: 'Notes' },
      userPrompt: 'Escribe "hola mundo" en Notes',
    });
    const enterText = recording.codex.semantic_target.candidate_actions.find(
      (candidate) => candidate.action === 'enter_text',
    );
    assert.deepEqual(enterText.params, { text: 'hola mundo' });
    assert.equal(recording.codex.semantic_target.extracted_parameters.typed_text, 'hola mundo');
  });

  it('renders a markdown skill companion with structured parameters', () => {
    const recording = buildTeachRecording('Markdown Skill', [], {
      app: { name: 'Calculator' },
      userPrompt: 'Usa calculadora y haz 47 x 98',
      screenshotPath: '/tmp/final-state.png',
    });
    const markdown = renderTeachSkillMarkdown(recording);
    assert.match(markdown, /# Linka Teach Skill Prompt/);
    assert.match(markdown, /## Intended Action\ncalculator_multiply/);
    assert.match(markdown, /- operator: multiply/);
    assert.match(markdown, /- operands: 47, 98/);
    assert.match(markdown, /Use the screenshot as end-state context/);
  });

  it('summarizes right-click actions without coordinates', () => {
    const events = [
      { ts: 1000, type: 'right_down', x: 50, y: 60 },
      { ts: 1050, type: 'right_up', x: 50, y: 60 },
    ];
    const recording = buildTeachRecording('RightClick', events, { app: { name: 'Finder' } });
    assert.deepEqual(recording.summary.action_labels, ['Right-click']);
    assert.equal(recording.execution.coordinates_removed, true);
  });

  it('preserves key combos with modifiers', () => {
    const events = [
      { ts: 1000, type: 'key_combo', key: 'n', modifiers: ['cmd'] },
      { ts: 1100, type: 'key_combo', key: 'v', modifiers: ['cmd'] },
    ];
    const recording = buildTeachRecording('Combos', events, { app: { name: 'TextEdit' } });
    assert.deepEqual(recording.summary.action_labels, ['Press cmd+n', 'Press cmd+v']);
  });

  it('keeps scroll direction and amount', () => {
    const events = [{ ts: 1000, type: 'scroll', x: 100, y: 200, dy: -120 }];
    const recording = buildTeachRecording('Scroll', events, { app: { name: 'Safari' } });
    assert.deepEqual(recording.summary.action_labels, ['Scroll up 120px']);
    assert.deepEqual(recording.events, [{ ts: 1000, type: 'scroll', dy: -120 }]);
  });

  it('keeps unknown app recordings generic', () => {
    const events = [{ ts: 1000, type: 'key_combo', key: 'a', modifiers: null }];
    const recording = buildTeachRecording('Unknown', events, {});
    assert.equal(recording.target.app_name, 'unknown');
    assert.equal(recording.guidance.parameterization.app_focus, false);
  });

  it('marks mixed pointer and keyboard flows as high risk', () => {
    const events = [
      { ts: 1000, type: 'left_down', x: 10, y: 10 },
      { ts: 1100, type: 'left_up', x: 10, y: 10 },
      { ts: 1200, type: 'key_combo', key: 'a', modifiers: null },
    ];
    const recording = buildTeachRecording('Hint', events, { app: { name: 'TextEdit' } });
    assert.equal(recording.execution.risk_level, 'high');
  });

  it('captures the screenshot after recording stops, not when it starts', async () => {
    const statusMessages = [];
    const input = {
      async teachStart() {
        return { active: true };
      },
      async teachStop() {
        return { events: [{ ts: 1, type: 'left_down' }], app_name: 'Linka', app_history: [] };
      },
    };
    const ws = {};
    const handler = createTeachMessageHandler({
      input,
      captureScreen: async () => 'data:image/png;base64,ZmFrZQ==',
      sendJson(_ws, payload) {
        statusMessages.push(payload);
      },
    });

    await handler(ws, { type: 'teach_start' });
    assert.equal(ws._teachScreenshot, null);

    await handler(ws, { type: 'teach_stop' });
    assert.equal(ws._teachScreenshot, 'data:image/png;base64,ZmFrZQ==');
    assert.equal(statusMessages[1].event, 'teach_events');
  });
});

describe('Teach Command Mirroring', () => {
  it('normalizes remote click and key commands into teach events', () => {
    const clickEvents = normalizeTeachCommandToEvents({ type: 'click', button: 'left', double: true }, 1000);
    const keyEvents = normalizeTeachCommandToEvents({ type: 'keytap', key: 'v', modifiers: ['cmd'] }, 1001);
    assert.deepEqual(clickEvents.map((event) => event.type), [
      'left_down',
      'left_up',
      'left_down',
      'left_up',
    ]);
    assert.equal(clickEvents[0].source, 'remote_command');
    assert.deepEqual(keyEvents[0], {
      ts: 1001,
      type: 'key_combo',
      x: null,
      y: null,
      key: 'v',
      modifiers: ['cmd'],
      dy: null,
      source: 'remote_command',
    });
  });

  it('merges native and mirrored teach events without duplicating equivalent actions', () => {
    const merged = mergeTeachEventStreams(
      [
        { ts: 1000, type: 'left_down', source: 'desktop_input' },
        { ts: 1000.02, type: 'left_up', source: 'desktop_input' },
      ],
      [
        { ts: 1000.01, type: 'left_down', source: 'remote_command' },
        { ts: 1000.03, type: 'left_up', source: 'remote_command' },
        { ts: 1001, type: 'key_combo', key: '2', modifiers: null, source: 'remote_command' },
      ],
    );
    assert.deepEqual(
      merged.map((event) => `${event.type}:${event.source}`),
      ['left_down:desktop_input', 'left_up:desktop_input', 'key_combo:remote_command'],
    );
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
