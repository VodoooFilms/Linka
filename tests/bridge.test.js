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

async function pairSocket(ws, sessionId, pairingToken) {
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
}

describe('Bridge Handling', () => {
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

  it('syncs bridge messages after upload', async () => {
    const ws = await openSocket(wsUrl);
    await pairSocket(ws, sessionId, pairingToken);

    const pushed = await sendAndWait(
      ws,
      {
        event: 'bridge_message',
        payload: {
          id: 'msg-1',
          type: 'text',
          from: 'phone',
          content: 'hello linka',
          timestamp: Date.now(),
        },
      },
      (data) => data.event === 'bridge_message' && data.payload?.id === 'msg-1',
    );
    assert.equal(pushed.payload.content, 'hello linka');

    const sync = await sendAndWait(
      ws,
      { event: 'bridge_sync_request' },
      (data) => data.event === 'bridge_sync',
    );
    assert.equal(sync.payload.messages.at(-1)?.id, 'msg-1');
    ws.close();
  });

  it('rejects oversized bridge uploads safely', async () => {
    const ws = await openSocket(wsUrl);
    await pairSocket(ws, sessionId, pairingToken);

    const tooLargeBase64 = `data:application/octet-stream;base64,${'A'.repeat(7 * 1024 * 1024)}`;
    const error = await sendAndWait(
      ws,
      {
        event: 'bridge_message',
        payload: {
          id: 'huge-file',
          type: 'file',
          from: 'phone',
          content: tooLargeBase64,
          filename: 'huge.bin',
          size: 6 * 1024 * 1024,
          timestamp: Date.now(),
        },
      },
      (data) => data.event === 'bridge_capture_error',
    );
    assert.match(error.payload.message, /Maximum is 5MB/);
    ws.close();
  });
});
