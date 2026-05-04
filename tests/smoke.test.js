import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server.js';

describe('Linka Smoke Test', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({ port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  });

  after(async () => {
    if (server) await server.close();
  });

  it('GET /api/status returns 200 with correct structure', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.product, 'LINKA');
    assert.strictEqual(body.status, 'running');
    assert.ok('nativeInputReady' in body, 'nativeInputReady property should exist');
    assert.strictEqual(typeof body.port, 'number');
    assert.strictEqual(typeof body.inputBackend, 'string');
  });

  it('GET /hermes/events does not crash (200 or 501 acceptable)', async () => {
    const res = await fetch(`${baseUrl}/hermes/events`);
    assert.ok(
      res.status === 200 || res.status === 501,
      `/hermes/events returned ${res.status}, expected 200 or 501`,
    );
    const body = await res.json();
    if (res.status === 200) {
      assert.strictEqual(typeof body.count, 'number');
    } else {
      assert.strictEqual(body.error, 'Event capture not available on this platform.');
    }
  });

  it('GET /api/status CORS/security headers are set', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'), 'CSP header should be present');
  });
});
