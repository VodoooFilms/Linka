import { createSessionId, createSecretToken, tokenMatches, withPairingParams } from '../utils.js';

const MAX_RECONNECT_TOKENS = 24;

export function createSessionStore({ connectionInfo, onClientConnected, sendJson, input }) {
  let activeSessionId = createSessionId();
  let activePairingToken = createSecretToken();
  let reconnectTokens = new Map();

  function getSessionSnapshot() {
    return {
      sessionId: activeSessionId,
      pairingUrl: withPairingParams(connectionInfo.primaryUrl, activeSessionId, activePairingToken),
      localhostPairingUrl: withPairingParams(
        connectionInfo.localhostUrl,
        activeSessionId,
        activePairingToken,
      ),
    };
  }

  function updateConnectionInfo(nextConnectionInfo) {
    connectionInfo = nextConnectionInfo;
  }

  function pruneReconnectTokens() {
    if (reconnectTokens.size <= MAX_RECONNECT_TOKENS) {
      return;
    }

    const ordered = [...reconnectTokens.entries()].sort(
      (a, b) => (a[1].lastSeenAt || a[1].createdAt) - (b[1].lastSeenAt || b[1].createdAt),
    );

    for (const [token] of ordered.slice(0, reconnectTokens.size - MAX_RECONNECT_TOKENS)) {
      reconnectTokens.delete(token);
    }
  }

  function issueReconnectToken(meta = {}) {
    const token = createSecretToken();
    reconnectTokens.set(token, {
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ...meta,
    });
    pruneReconnectTokens();
    return token;
  }

  function clearSocketAuth(ws) {
    if (!ws) return;
    ws._authenticated = false;
    ws._sessionId = null;
    ws._reconnectToken = null;
  }

  function authenticateSocket(ws, authMode) {
    ws._authenticated = true;
    ws._sessionId = activeSessionId;
    ws._authMode = authMode;
  }

  function createAuthSuccessPayload(ws, meta = {}) {
    const reconnectToken = issueReconnectToken(meta);
    ws._reconnectToken = reconnectToken;

    return {
      type: 'auth_ok',
      sessionId: activeSessionId,
      reconnectToken,
    };
  }

  function sendVolumeState(ws) {
    if (!input.getVolumeState) return;
    input
      .getVolumeState()
      .then((state) => {
        if (state && ws.readyState === 1 && ws._authenticated) {
          sendJson(ws, { event: 'volume_state', payload: state });
        }
      })
      .catch(() => {});
  }

  function reportClientConnected(clients, req, authMode) {
    onClientConnected?.({
      clients,
      remoteAddress: req.socket.remoteAddress || 'unknown',
      authMode,
    });
  }

  function handleAuthMessage(ws, data, req, clientsCount) {
    const providedSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const providedToken = typeof data.token === 'string' ? data.token : '';
    const authMode = data.mode === 'reconnect' ? 'reconnect' : data.mode === 'pair' ? 'pair' : null;

    if (!authMode) {
      sendJson(ws, { type: 'auth_error', reason: 'invalid_mode' });
      return false;
    }

    if (!tokenMatches(activeSessionId, providedSessionId)) {
      sendJson(ws, { type: 'auth_error', reason: 'session_changed' });
      return false;
    }

    if (authMode === 'pair') {
      if (!tokenMatches(activePairingToken, providedToken)) {
        sendJson(ws, { type: 'auth_error', reason: 'invalid_pairing' });
        return false;
      }

      clearSocketAuth(ws);
      authenticateSocket(ws, authMode);
      sendJson(
        ws,
        createAuthSuccessPayload(ws, {
          mode: authMode,
          remoteAddress: req.socket.remoteAddress || 'unknown',
        }),
      );
      sendVolumeState(ws);
      reportClientConnected(clientsCount, req, authMode);
      return true;
    }

    const existing = reconnectTokens.get(providedToken);
    if (!existing) {
      sendJson(ws, { type: 'auth_error', reason: 'invalid_reconnect' });
      return false;
    }

    reconnectTokens.delete(providedToken);
    clearSocketAuth(ws);
    authenticateSocket(ws, authMode);
    sendJson(
      ws,
      createAuthSuccessPayload(ws, {
        mode: authMode,
        remoteAddress: req.socket.remoteAddress || 'unknown',
        previousIssuedAt: existing.createdAt,
      }),
    );
    sendVolumeState(ws);
    reportClientConnected(clientsCount, req, authMode);
    return true;
  }

  function resetPairing() {
    activeSessionId = createSessionId();
    activePairingToken = createSecretToken();
    reconnectTokens = new Map();
    return getSessionSnapshot();
  }

  return {
    authenticateSocket,
    clearSocketAuth,
    getSessionSnapshot,
    handleAuthMessage,
    issueReconnectToken,
    resetPairing,
    updateConnectionInfo,
  };
}
