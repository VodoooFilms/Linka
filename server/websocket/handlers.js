import {
  createAuthRequiredError,
  createHelloMessage,
  createLocalAuthSuccessMessage,
  createPongMessage,
} from './messages.js';
import {
  WS_MAX_MSG_PER_SEC,
  createRateLimiter,
  isLocalhostAddress,
  normalizeNumber,
  shouldRateLimit,
} from './utils.js';

export function handleCommand(input, data) {
  switch (data.type) {
    case 'move':
      input.move(normalizeNumber(data.dx), normalizeNumber(data.dy));
      break;
    case 'mousedown':
      input.mouseDown(data.button || 'left');
      break;
    case 'mouseup':
      input.mouseUp(data.button || 'left');
      break;
    case 'click':
      input.click(data.button || 'left', data.double || false);
      break;
    case 'scroll':
      input.scroll(normalizeNumber(data.dy, 0, -1200, 1200));
      break;
    case 'zoom':
      input.zoom(data.direction === 'out' ? 'out' : 'in');
      break;
    case 'type':
      input.type(data.text || '');
      break;
    case 'keytap':
      input.keyTap(data.key, Array.isArray(data.modifiers) ? data.modifiers : []);
      break;
    case 'volume':
      input.setVolume?.(Math.max(0, Math.min(1, Number(data.value))));
      break;
    case 'mute':
      input.setMute?.(Boolean(data.muted));
      break;
    case 'togglemute':
      input.toggleMute?.();
      break;
    default:
      console.warn(`[ws] Unknown command: ${data.type}`);
  }
}

export function createConnectionHandler(options) {
  const {
    bridge,
    bridgeCaptureAvailable,
    clients,
    input,
    sendJson,
    sessions,
    onTeachMessage,
    wsMaxPayloadBytes,
  } = options;

  return function handleConnection(ws, req) {
    clients.add(ws);
    console.log(
      `[ws] Client connected from ${req.socket.remoteAddress}. Total clients: ${clients.size}`,
    );

    ws._authenticated = false;
    ws._sessionId = null;
    ws._reconnectToken = null;
    ws._rateLimiter = createRateLimiter();

    sendJson(ws, createHelloMessage(input, bridgeCaptureAvailable));

    ws.on('message', async (message) => {
      try {
        if (Buffer.isBuffer(message) && message.length > wsMaxPayloadBytes) {
          return;
        }

        if (shouldRateLimit(ws._rateLimiter)) {
          if (ws._rateLimiter.rateLimited) {
            console.warn(`[ws] Rate limit hit for ${req.socket.remoteAddress}. Dropping messages.`);
          }
          return;
        }

        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          sendJson(ws, createPongMessage());
          return;
        }

        if (data.type === 'auth') {
          const ok = sessions.handleAuthMessage(ws, data, req, clients.size);
          if (!ok) {
            sessions.clearSocketAuth(ws);
            ws.close(4401, 'Authentication failed');
          }
          return;
        }

        const remoteAddr = req.socket.remoteAddress || '';
        if (!ws._authenticated && isLocalhostAddress(remoteAddr)) {
          sessions.authenticateSocket(ws, 'local');
          sendJson(
            ws,
            createLocalAuthSuccessMessage(
              sessions.getSessionSnapshot().sessionId,
              sessions.issueReconnectToken({
                mode: 'local',
                remoteAddress: remoteAddr,
              }),
            ),
          );
          console.log(`[ws] Auto-authenticated localhost client from ${remoteAddr}`);
        }

        if (!ws._authenticated) {
          sendJson(ws, createAuthRequiredError());
          ws.close(4401, 'Authentication required');
          return;
        }

        if (onTeachMessage && (await onTeachMessage(ws, data))) {
          return;
        }

        if (!(await bridge.handleEvent(ws, data))) {
          handleCommand(input, data);
        }
      } catch (error) {
        console.error('[ws] Error processing message:', error);
      }
    });

    ws.on('close', () => {
      clearTimeout(ws._heartbeatTimeout);
      sessions.clearSocketAuth(ws);
      clients.delete(ws);
      console.log(`[ws] Client disconnected. Total clients: ${clients.size}`);
    });

    ws.on('pong', () => {
      clearTimeout(ws._heartbeatTimeout);
    });
  };
}

export { WS_MAX_MSG_PER_SEC };
