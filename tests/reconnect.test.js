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

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for websocket message.'));
    }, timeoutMs);

    function onMessage(raw) {
      const data = JSON.parse(raw.toString());
      if (!predicate(data)) return;
      cleanup();
      resolve(data);
    }

    function onClose() {
      cleanup();
      reject(new Error('WebSocket closed before expected message.'));
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function sendAndWait(ws, payload, predicate, timeoutMs = 2000) {
  const pending = waitForMessage(ws, predicate, timeoutMs);
  ws.send(JSON.stringify(payload));
  return pending;
}

describe('Reconnect Persistence', () => {
  let server;
  let wsUrl;
  let sessionId;
  let pairingToken;

  before(async () => {
    server = await startServer({
      port: 0,
      inputAdapter: createTestInputAdapter(),
    });
    wsUrl = `ws://localhost:${server.port}`;
    const pairingUrl = new URL(server.pairingUrl);
    sessionId = pairingUrl.searchParams.get('sessionId');
    pairingToken = pairingUrl.searchParams.get('pairingToken');
  });

  after(async () => {
    if (server) await server.close();
  });

  it('allows a paired client to reconnect once with the issued token', async () => {
    const ws1 = await openSocket(wsUrl);
    const auth1 = await sendAndWait(
      ws1,
      {
        type: 'auth',
        mode: 'pair',
        sessionId,
        token: pairingToken,
      },
      (data) => data.type === 'auth_ok',
    );
    assert.equal(auth1.sessionId, sessionId);
    assert.equal(typeof auth1.reconnectToken, 'string');
    ws1.close();

    const ws2 = await openSocket(wsUrl);
    const auth2 = await sendAndWait(
      ws2,
      {
        type: 'auth',
        mode: 'reconnect',
        sessionId,
        token: auth1.reconnectToken,
      },
      (data) => data.type === 'auth_ok',
    );
    assert.equal(auth2.sessionId, sessionId);
    assert.notEqual(auth2.reconnectToken, auth1.reconnectToken);
    ws2.close();
  });

  it('rejects reuse of an already-consumed reconnect token', async () => {
    const ws1 = await openSocket(wsUrl);
    const auth1 = await sendAndWait(
      ws1,
      {
        type: 'auth',
        mode: 'pair',
        sessionId,
        token: pairingToken,
      },
      (data) => data.type === 'auth_ok',
    );
    ws1.close();

    const ws2 = await openSocket(wsUrl);
    await sendAndWait(
      ws2,
      {
        type: 'auth',
        mode: 'reconnect',
        sessionId,
        token: auth1.reconnectToken,
      },
      (data) => data.type === 'auth_ok',
    );
    ws2.close();

    const ws3 = await openSocket(wsUrl);
    const error = await sendAndWait(
      ws3,
      {
        type: 'auth',
        mode: 'reconnect',
        sessionId,
        token: auth1.reconnectToken,
      },
      (data) => data.type === 'auth_error',
    );
    assert.equal(error.reason, 'invalid_reconnect');
    ws3.close();
  });
});
