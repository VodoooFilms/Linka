import { WebSocketServer } from 'ws';
import { createConnectionHandler } from './handlers.js';

const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const WS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export function createWebSocketLayer(options) {
  const { server } = options;
  const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD_BYTES });
  const clients = new Set();
  let heartbeatTimer = null;

  const sendJson = (ws, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  };

  const broadcast = (data) => {
    for (const client of clients) {
      if (!client._authenticated) continue;
      sendJson(client, data);
    }
  };

  const connectionHandler = createConnectionHandler({
    ...options,
    bridge: options.bridgeFactory({ sendJson, broadcast }),
    clients,
    sendJson,
    wsMaxPayloadBytes: WS_MAX_PAYLOAD_BYTES,
  });

  wss.on('headers', (_headers, req) => {
    console.log(`[ws] Upgrade attempt from ${req.socket.remoteAddress} ${req.url}`);
  });

  wss.on('connection', connectionHandler);

  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      if (client._heartbeatTimeout) {
        clearTimeout(client._heartbeatTimeout);
      }

      client._heartbeatTimeout = setTimeout(() => {
        console.warn('[ws] Client heartbeat timeout. Terminating connection.');
        client.terminate();
      }, HEARTBEAT_TIMEOUT_MS);

      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  return {
    clients,
    broadcast,
    closeAllClients(code = 4001, reason = 'Pairing reset') {
      for (const client of clients) {
        clearTimeout(client._heartbeatTimeout);
        options.sessions.clearSocketAuth(client);
        client.close(code, reason);
      }
    },
    dispose() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const client of clients) {
        clearTimeout(client._heartbeatTimeout);
        options.sessions.clearSocketAuth(client);
      }
    },
  };
}
