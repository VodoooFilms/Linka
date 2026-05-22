import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server.js';
import {
  createConnectAttemptTracker,
  shouldReconnectOnVisibility,
} from '../shared/mobile-reconnect.js';

let activeServer = null;
let restoreNow = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }

  if (restoreNow) {
    restoreNow();
    restoreNow = null;
  }
});

function withMockedNow(initialValue) {
  const realNow = Date.now;
  let current = initialValue;
  Date.now = () => current;
  restoreNow = () => {
    Date.now = realNow;
  };
  return {
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

function buildSocketUrl(port) {
  return `ws://127.0.0.1:${port}`;
}

function getPairingParams(server) {
  const url = new URL(server.pairingUrl);
  return {
    sessionId: url.searchParams.get('sessionId'),
    pairingToken: url.searchParams.get('pairingToken'),
  };
}

async function connectSocket(port) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(buildSocketUrl(port));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForJson(ws, predicate, timeoutMs = 2000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onClose(code, reason) {
      cleanup();
      reject(new Error(`Socket closed before expected message: ${code} ${reason}`));
    }

    function onMessage(raw) {
      const data = JSON.parse(raw.toString());
      if (!predicate(data)) return;
      cleanup();
      resolve(data);
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

async function authenticateClient({
  server,
  mode,
  sessionId,
  token,
  deviceId,
}) {
  const ws = await connectSocket(server.port);
  ws.send(
    JSON.stringify({
      type: 'auth',
      mode,
      sessionId,
      token,
      deviceId,
    }),
  );
  const authResult = await waitForJson(
    ws,
    (data) => data.type === 'auth_ok' || data.type === 'auth_error',
  );
  return { ws, authResult };
}

async function closeSocket(ws) {
  if (!ws) return;
  if (ws.readyState === WebSocket.CLOSED) return;

  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

describe('Reconnect server flow', { concurrency: false }, () => {
  it('accepts reconnect with the current token', async () => {
    activeServer = await startServer({ port: 0 });
    const { sessionId, pairingToken } = getPairingParams(activeServer);

    const paired = await authenticateClient({
      server: activeServer,
      mode: 'pair',
      sessionId,
      token: pairingToken,
      deviceId: 'device-a',
    });
    assert.strictEqual(paired.authResult.type, 'auth_ok');
    const reconnectToken = paired.authResult.reconnectToken;
    await closeSocket(paired.ws);

    const reconnected = await authenticateClient({
      server: activeServer,
      mode: 'reconnect',
      sessionId,
      token: reconnectToken,
      deviceId: 'device-a',
    });
    assert.strictEqual(reconnected.authResult.type, 'auth_ok');
    assert.ok(reconnected.authResult.reconnectToken);
    await closeSocket(reconnected.ws);
  });

  it('accepts the immediately previous token during the grace window', async () => {
    activeServer = await startServer({ port: 0 });
    const { sessionId, pairingToken } = getPairingParams(activeServer);

    const paired = await authenticateClient({
      server: activeServer,
      mode: 'pair',
      sessionId,
      token: pairingToken,
      deviceId: 'device-a',
    });
    const originalToken = paired.authResult.reconnectToken;
    await closeSocket(paired.ws);

    const firstReconnect = await authenticateClient({
      server: activeServer,
      mode: 'reconnect',
      sessionId,
      token: originalToken,
      deviceId: 'device-a',
    });
    assert.strictEqual(firstReconnect.authResult.type, 'auth_ok');
    await closeSocket(firstReconnect.ws);

    const graceReconnect = await authenticateClient({
      server: activeServer,
      mode: 'reconnect',
      sessionId,
      token: originalToken,
      deviceId: 'device-a',
    });
    assert.strictEqual(graceReconnect.authResult.type, 'auth_ok');
    await closeSocket(graceReconnect.ws);
  });

  it('rejects an expired previous token', async () => {
    const clock = withMockedNow(1_000);
    activeServer = await startServer({ port: 0 });
    const { sessionId, pairingToken } = getPairingParams(activeServer);

    const paired = await authenticateClient({
      server: activeServer,
      mode: 'pair',
      sessionId,
      token: pairingToken,
      deviceId: 'device-a',
    });
    const originalToken = paired.authResult.reconnectToken;
    await closeSocket(paired.ws);

    const firstReconnect = await authenticateClient({
      server: activeServer,
      mode: 'reconnect',
      sessionId,
      token: originalToken,
      deviceId: 'device-a',
    });
    assert.strictEqual(firstReconnect.authResult.type, 'auth_ok');
    await closeSocket(firstReconnect.ws);

    clock.advance(61_000);

    const expiredReconnect = await authenticateClient({
      server: activeServer,
      mode: 'reconnect',
      sessionId,
      token: originalToken,
      deviceId: 'device-a',
    });
    assert.strictEqual(expiredReconnect.authResult.type, 'auth_error');
    assert.strictEqual(expiredReconnect.authResult.reason, 'invalid_reconnect');
    await closeSocket(expiredReconnect.ws).catch(() => {});
  });

  it('rejects reconnect from the wrong deviceId', async () => {
    activeServer = await startServer({ port: 0 });
    const { sessionId, pairingToken } = getPairingParams(activeServer);

    const paired = await authenticateClient({
      server: activeServer,
      mode: 'pair',
      sessionId,
      token: pairingToken,
      deviceId: 'device-a',
    });
    const reconnectToken = paired.authResult.reconnectToken;
    await closeSocket(paired.ws);

    const wrongDevice = await authenticateClient({
      server: activeServer,
      mode: 'reconnect',
      sessionId,
      token: reconnectToken,
      deviceId: 'device-b',
    });
    assert.strictEqual(wrongDevice.authResult.type, 'auth_error');
    assert.strictEqual(wrongDevice.authResult.reason, 'invalid_device');
    await closeSocket(wrongDevice.ws).catch(() => {});
  });
});

describe('Mobile reconnect policy', () => {
  it('serializes overlapping reconnect attempts with generations', () => {
    const tracker = createConnectAttemptTracker();
    const first = tracker.beginAttempt();
    const second = tracker.beginAttempt();

    assert.strictEqual(tracker.isCurrent(first), false);
    assert.strictEqual(tracker.isCurrent(second), true);
    assert.strictEqual(tracker.getActiveGeneration(), second);
  });

  it('does not reconnect on foreground if the socket is still healthy', () => {
    const now = 50_000;
    const shouldReconnect = shouldReconnectOnVisibility({
      readyState: 1,
      isAuthenticated: true,
      lastPongReceived: now - 500,
      lastConnectStartedAt: now - 2_000,
      now,
      hiddenDurationMs: 4_000,
    });

    assert.strictEqual(shouldReconnect, false);
  });

  it('reconnects on foreground after a temporary network loss', () => {
    const now = 50_000;
    const shouldReconnect = shouldReconnectOnVisibility({
      readyState: 3,
      isAuthenticated: false,
      lastPongReceived: now - 20_000,
      lastConnectStartedAt: now - 20_000,
      now,
      hiddenDurationMs: 500,
    });

    assert.strictEqual(shouldReconnect, true);
  });

  it('reconnects on foreground when a hidden tab returns with a stale socket', () => {
    const now = 50_000;
    const shouldReconnect = shouldReconnectOnVisibility({
      readyState: 1,
      isAuthenticated: true,
      lastPongReceived: now - 12_000,
      lastConnectStartedAt: now - 20_000,
      now,
      hiddenDurationMs: 20_000,
    });

    assert.strictEqual(shouldReconnect, true);
  });
});
