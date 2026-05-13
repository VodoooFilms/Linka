import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server.js';

function createRecordingInputAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    name: 'recording-input',
    ready: true,
    permissionMissing: false,
    message: '',
    move(dx, dy) {
      calls.push({ type: 'move', dx, dy });
    },
    keyTap(key, modifiers) {
      calls.push({ type: 'keytap', key, modifiers });
    },
    close() {},
    ...overrides,
  };
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 2500) {
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

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }

    ws.on('message', onMessage);
  });
}

function sendAndWait(ws, payload, predicate, timeoutMs = 2500) {
  const pending = waitForMessage(ws, predicate, timeoutMs);
  ws.send(JSON.stringify(payload));
  return pending;
}

describe('WebSocket Routing', () => {
  let server;
  let wsUrl;
  let sessionId;
  let pairingToken;
  let input;

  before(async () => {
    input = createRecordingInputAdapter();
    server = await startServer({
      port: 0,
      inputAdapter: input,
    });
    wsUrl = `ws://localhost:${server.port}`;
    const pairingUrl = new URL(server.pairingUrl);
    sessionId = pairingUrl.searchParams.get('sessionId');
    pairingToken = pairingUrl.searchParams.get('pairingToken');
  });

  after(async () => {
    if (server) await server.close();
  });

  it('rejects invalid pairing tokens without changing auth protocol', async () => {
    const ws = await openSocket(wsUrl);
    const error = await sendAndWait(
      ws,
      {
        type: 'auth',
        mode: 'pair',
        sessionId,
        token: 'invalid-token',
      },
      (data) => data.type === 'auth_error',
    );
    assert.equal(error.reason, 'invalid_pairing');
    ws.close();
  });

  it('routes native input commands after auth', async () => {
    const ws = await openSocket(wsUrl);
    await sendAndWait(
      ws,
      {
        type: 'auth',
        mode: 'pair',
        sessionId,
        token: pairingToken,
      },
      (data) => data.type === 'auth_ok',
    );

    ws.send(JSON.stringify({ type: 'move', dx: 12, dy: -4 }));
    ws.send(JSON.stringify({ type: 'keytap', key: 'enter', modifiers: ['shift'] }));

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(input.calls[0], { type: 'move', dx: 12, dy: -4 });
    assert.deepEqual(input.calls[1], {
      type: 'keytap',
      key: 'enter',
      modifiers: ['shift'],
    });
    ws.close();
  });

  it('routes teach-unavailable through the websocket handler without changing message shape', async () => {
    const ws = await openSocket(wsUrl);
    await sendAndWait(
      ws,
      {
        type: 'auth',
        mode: 'pair',
        sessionId,
        token: pairingToken,
      },
      (data) => data.type === 'auth_ok',
    );

    const error = await sendAndWait(
      ws,
      { type: 'teach_start' },
      (data) => data.event === 'teach_error',
    );
    assert.equal(error.payload.message, 'Teach not available on this platform.');
    ws.close();
  });
});
