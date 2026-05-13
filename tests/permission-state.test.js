import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server.js';

function createTestInputAdapter(overrides = {}) {
  return {
    name: 'test-input',
    ready: true,
    permissionMissing: false,
    message: '',
    close() {},
    ...overrides,
  };
}

describe('Permission Failure State', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({
      port: 0,
      inputAdapter: createTestInputAdapter({
        ready: false,
        permissionMissing: true,
        message: 'Accessibility permission is missing.',
      }),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  after(async () => {
    if (server) await server.close();
  });

  it('surfaces permission failure on /api/status', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();
    assert.equal(body.nativeInputReady, false);
    assert.equal(body.permissionMissing, true);
    assert.match(body.message, /permission/i);
  });

  it('includes permission state in the initial websocket hello', async () => {
    const { ws, hello } = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${server.port}`);
      const timer = setTimeout(() => reject(new Error('Timed out waiting for hello.')), 2000);
      socket.once('message', (raw) => {
        clearTimeout(timer);
        resolve({ ws: socket, hello: JSON.parse(raw.toString()) });
      });
      socket.once('error', reject);
    });

    assert.equal(hello.type, 'hello');
    assert.equal(hello.nativeInputReady, false);
    assert.equal(hello.permissionMissing, true);
    assert.match(hello.message, /permission/i);
    ws.close();
  });
});
